#!/usr/bin/env node
/**
 * v1.8.15 / v1.8.16 离屏通知（飞书 / Server酱 / 通用 webhook）的契约测试。
 *
 * 这一版最该被钉住的不是"能不能发出去"，而是三件容易悄悄退化的事：
 *   1. **正文口径**：工具名 + reason 前 30 字、多条只列 3 条 + 「还有 N 件」、
 *      不含完整命令 —— 这里用一条真带 `rm -rf` 的 reason 正面断言它没被带出去；
 *   2. **安全闸**：地址 / SendKey 只能从设置页 POST 进来、只回掩码、失败文案不含
 *      URL 也不含 key；
 *   3. **去重合并**：同时三件只推 1 条、通道全关时零请求。
 *
 * v1.8.16 追加 Server酱：`/<key>.send` + form + 只有 title/desp、标题自截 32 字、
 * SendKey 校验、落盘只存 key（配置里塞 URL 也忽略）。
 *
 * 分两层：
 *   · 纯函数 / 状态机：正文口径、URL 校验、payload 形状、重试次数、静默；
 *   · 真实 HTTP：apply() 注册的 /taskwatch/notify* 与假 webhook 服务器，
 *     走 node:http + fetch，和手机实际打的是同一条路。
 *
 * 所有地址都是 http://127.0.0.1:<随机端口>（内网 http 白名单的唯一合法用途），
 * 测试里没有任何真实凭据；假服务器只记录请求体，不联网。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'tw-notify-'))
process.env.DSH_HOME = home

const {
  apply,
  NOTIFY_DEBOUNCE_MS,
  NOTIFY_FILE_NAME,
  NOTIFY_MAX_CHANNELS,
  NOTIFY_REASON_MAX,
  NOTIFY_RETRY_DELAYS,
  NOTIFY_SERVERCHAN_TITLE_MAX,
  NOTIFY_TIMEOUT_MS,
  buildNotifyPayload,
  buildNotifyText,
  createNotifier,
  createNotifySender,
  createNotifyStore,
  maskNotifyKey,
  maskNotifyUrl,
  notifyConfigPath,
  notifyServerchanTitle,
  resolveNotifyConfig,
  serverchanEndpoint,
  validateNotifyUrl,
  validateSendKey,
} = await import('../lib/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const asyncTests = []
function test(name, fn) {
  return asyncTests.push({ name, fn })
}

// ── 宿主假装（与 check-approval.mjs 同一套）────────────────────────────────
const routes = new Map()
const handlers = new Map()
const webServer = {
  register(spec) {
    routes.set(spec.path, spec.handler)
    return () => {}
  },
}
const ctx = {
  get(name) { return name === 'webServer' ? webServer : undefined },
  effect(fn) { return fn() },
  on(event, fn) { handlers.set(event, fn); return () => {} },
}

// 日志里也不许出现地址：把 console.error 抄一份，最后统一断言。
const logs = []
const realError = console.error
console.error = (...args) => { logs.push(args.map(String).join(' ')); realError(...args) }

apply(ctx, {
  approveFromPhone: true,
  approvalTimeoutMs: 120 * 1000,
  // 合并窗口压到下限 200ms：测试不需要真的等 1.2 秒，但走的是同一条钳制逻辑。
  notify: { debounceMs: 200 },
})

// ── 假 webhook 服务器 ─────────────────────────────────────────────────────
const hits = []
// serverchan 的请求单独收：它只该有一条 `/<key>.send`，且请求体是 form。
const sctHits = []
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname
  if (path.endsWith('.send')) {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      sctHits.push({ path, contentType: String(req.headers['content-type'] || ''), raw })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"code":0}')
    })
    return
  }
  if (path.startsWith('/hook/')) {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      hits.push({ path, contentType: String(req.headers['content-type'] || ''), raw })
      if (path === '/hook/fail') {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'boom' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end('{"code":0}')
    })
    return
  }
  const handler = routes.get(path)
  if (!handler) { res.writeHead(404); res.end(); return }
  Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: String((error && error.message) || error) }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

async function call(path, init = {}) {
  const response = await fetch(base + path, init)
  const text = await response.text()
  let body = {}
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: response.status, body, text }
}
const postJson = (path, body) => call(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const resetHits = () => { hits.length = 0; sctHits.length = 0 }

/** 触发一次审批（手机"离线"，桌面在等）—— 条目会在 next() 解析前一直留在
 *  approvals 里，正是「有事情等你」的真实形状。 */
function triggerApproval(callId, reason, holdMs = 600, toolName = 'pwsh') {
  const startedAt = Date.now()
  const running = handlers.get('approval/request')(
    { agent: { id: 'session-notify' }, toolName, callId, reason },
    async () => { await sleep(holdMs); return 'unavailable' },
  )
  return { running, startedAt }
}

const maskToken = (where) => {
  assert.ok(!String(where).includes(TEST_TOKEN), '响应/文本里出现了完整 webhook 地址')
}

// 第一个通道用的地址（假服务器上的一个不存在的路径，token 全部是编的）。
const TEST_TOKEN = 'testhook0000000000000000000000000000'
// v1.8.16 的 Server酱 假 SendKey：带 `-`，**故意不写成纯字母数字**，这样它既能过
// 校验，也永远不会被误认成真实 key（Grep 自查 `SCT[A-Za-z0-9]{10,}` 命中不了）。
const SCT_KEY = 'SCTfake-key-abcd'
const SCT_KEY_12 = 'SCTfake-key-001'

// ═════════════════════════════════════════════════════════════════════════
// 纯函数：口径 / 校验 / payload / 静默
// ═════════════════════════════════════════════════════════════════════════
test('正文口径：单条 = 工具名 + reason 前 30 字（超出补 …）', async () => {
  const reason = '删除 build/cache 下的 3 个过期产物目录，命令为 rm -rf build/cache --force'
  const text = buildNotifyText([{ kind: 'approval', title: 'pwsh', detail: reason }])
  assert.ok(text.startsWith('1 件事等你：pwsh · '), text)
  assert.ok(text.includes('删除 build/cache 下的 3 个过期产物目录，命令…'), text)
  assert.ok(!text.includes('rm -rf'), '正文里不能出现完整命令')
  assert.ok(!text.includes('build/cache --force'), '正文里不能出现命令尾部')
  // 截断长度按 reason 前 30 字算（标题部分不算）。
  const shown = text.slice('1 件事等你：pwsh · '.length)
  assert.equal(shown.replace('…', '').length, NOTIFY_REASON_MAX, shown)
})

test('正文口径：多条只列前 3 条 + 「还有 N 件」', async () => {
  const list = [
    { kind: 'approval', title: 'pwsh', detail: '删除 build/cache 下的过期产物' },
    { kind: 'question', title: '发布窗口', detail: '今天 18:00 还是明天 10:00 发？' },
    { kind: 'approval', title: 'edit', detail: '改一处文案' },
    { kind: 'approval', title: 'pwsh', detail: '第四件' },
    { kind: 'approval', title: 'pwsh', detail: '第五件' },
  ]
  const text = buildNotifyText(list)
  assert.ok(text.startsWith('5 件事等你：\n'), text)
  assert.equal((text.match(/^· /gm) || []).length, 3, '只列前 3 条')
  assert.ok(text.includes('· 提问 · 发布窗口'), text)
  assert.ok(text.trim().endsWith('还有 2 件'), text)
  assert.ok(!text.includes('第四件') && !text.includes('第五件'), '第 4/5 件不能出现明细')
  // 恰好 3 件时不写「还有」。
  const three = buildNotifyText(list.slice(0, 3))
  assert.ok(!three.includes('还有'), three)
  // 已 settle 的不算「等你」。
  assert.equal(buildNotifyText([{ settled: true, title: 'pwsh' }]), '')
})

test('地址校验：只允许 https；http 仅本机 / 内网；公网 http 被拒', async () => {
  assert.equal(validateNotifyUrl('https://open.feishu.cn/open-apis/bot/v2/hook/x').ok, true)
  assert.equal(validateNotifyUrl('http://127.0.0.1:1234/hook/a').ok, true)
  assert.equal(validateNotifyUrl('http://10.1.2.3/h').ok, true)
  assert.equal(validateNotifyUrl('http://192.168.1.9:8080/h').ok, true)
  assert.equal(validateNotifyUrl('http://172.20.0.2/h').ok, true)
  assert.equal(validateNotifyUrl('http://172.32.0.2/h').ok, false)
  const pub = validateNotifyUrl('http://example.com/hook/x')
  assert.equal(pub.ok, false)
  assert.ok(pub.error.includes('https'), pub.error)
  assert.ok(!pub.error.includes('example.com'), '错误文案不能回显地址')
  // 以 "10." 开头的公网域名不能被前缀判断放过去。
  assert.equal(validateNotifyUrl('http://10.evil.com/h').ok, false)
  assert.equal(validateNotifyUrl('ftp://example.com/x').ok, false)
  // 地址里带账号密码 = 把第二份凭据塞进同一个文件，直接拒。
  assert.equal(validateNotifyUrl('https://' + ['user', 'pw'].join(':') + '@example.com/x').ok, false)
  assert.equal(validateNotifyUrl('').ok, false)
  assert.equal(validateNotifyUrl('x'.repeat(2000)).ok, false)
})

test('掩码：只留主机 + 最后一段前 3 字，永远带「（已保存）」', async () => {
  const masked = maskNotifyUrl('https://open.feishu.cn/open-apis/bot/v2/hook/0000-1111-2222')
  assert.equal(masked, 'https://open.feishu.cn/…/000…（已保存）')
  assert.ok(!masked.includes('1111'))
  assert.equal(maskNotifyUrl('not a url'), '（已保存）')
  assert.ok(maskNotifyUrl('http://127.0.0.1:9/hook/abcdef').includes('/…/abc…'))
})

test('payload：feishu / 通用 json / 通用 form 三种形状', async () => {
  const feishu = buildNotifyPayload({ type: 'feishu' }, 'hi')
  assert.deepEqual(JSON.parse(feishu.body), { msg_type: 'text', content: { text: 'hi' } })
  assert.ok(feishu.contentType.startsWith('application/json'))
  const json = buildNotifyPayload({ type: 'webhook', format: 'json' }, 'hi')
  assert.deepEqual(JSON.parse(json.body), { title: '掌上 DSH · 有事等你', content: 'hi' })
  const form = buildNotifyPayload({ type: 'webhook', format: 'form' }, 'hi')
  assert.ok(form.contentType.startsWith('application/x-www-form-urlencoded'))
  assert.ok(form.body.includes('desp=hi'), form.body)
  assert.ok(form.body.includes('title='), form.body)
})

test('发送器：默认 8 秒超时、最多 3 次、退避 1s/3s，失败文案不含 URL', async () => {
  assert.equal(NOTIFY_TIMEOUT_MS, 8000)
  assert.deepEqual([...NOTIFY_RETRY_DELAYS], [1000, 3000])
  const waited = []
  const sender = createNotifySender({
    timeoutMs: 8000,
    retryDelays: [10, 20],
    sleep: async (ms) => { waited.push(ms) },
    fetchImpl: async () => { throw new TypeError('fetch failed: https://open.feishu.cn/open-apis/bot/v2/hook/REAL-SECRET') },
  })
  const result = await sender.send({ type: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/REAL-SECRET' }, 'x')
  assert.equal(result.ok, false)
  assert.equal(result.attempts, 3, '最多 3 次')
  assert.deepEqual(waited, [10, 20], '第 1 次不等待，之后按退避')
  assert.ok(!result.error.includes('REAL-SECRET'), '失败文案不能带 URL')
  assert.ok(!result.error.includes('http'), result.error)
  // 超时走固定文案（不拼底层异常）。
  const timeoutSender = createNotifySender({
    timeoutMs: 10,
    retryDelays: [],
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
  })
  const timedOut = await timeoutSender.send({ type: 'feishu', url: 'https://example.com/x' }, 'x')
  assert.equal(timedOut.ok, false)
  assert.ok(timedOut.error.includes('超时'), timedOut.error)
  // 2xx 才算成功（3xx / 4xx / 5xx 都是失败）。
  const s500 = createNotifySender({
    retryDelays: [],
    fetchImpl: async () => ({ status: 500, body: null }),
  })
  assert.equal((await s500.send({ type: 'feishu', url: 'https://example.com/x' }, 'x')).ok, false)
})

test('静默：没有任何启用通道时，poke 不排定时器、不发请求、不写日志', async () => {
  let sent = 0
  const store = createNotifyStore({ file: join(home, 'empty-notify.json') })
  const notifier = createNotifier({
    store,
    debounceMs: 10,
    pending: () => [{ kind: 'approval', title: 'pwsh', detail: 'x' }],
    send: async () => { sent++; return { ok: true, status: 200 } },
    audit: () => { throw new Error('不该写审计') },
  })
  notifier.poke()
  await sleep(40)
  assert.equal(sent, 0)
  assert.equal(notifier.stats().waiting, false, '不该留下定时器')
  notifier.poke()
  assert.equal(notifier.stats().armed, true)
  notifier.dispose()
})

test('去重：一次等待期间只推一条，清空之后才重新武装', async () => {
  const sent = []
  let items = [{ kind: 'approval', title: 'pwsh', detail: 'a' }]
  const store = { enabledChannels: () => [{ type: 'feishu', url: 'https://example.com/x' }] }
  const notifier = createNotifier({
    store,
    debounceMs: 10,
    pending: () => items,
    send: async (channel, text) => { sent.push(text); return { ok: true, status: 200 } },
    audit: () => {},
  })
  notifier.poke()
  notifier.poke()
  await sleep(40)
  assert.equal(sent.length, 1, '窗口内多次 poke 只发一条')
  notifier.poke()
  await sleep(40)
  assert.equal(sent.length, 1, '还在等的时候不再推')
  items = []
  notifier.poke()
  items = [{ kind: 'approval', title: 'edit', detail: 'b' }]
  notifier.poke()
  await sleep(40)
  assert.equal(sent.length, 2, '清空后再出现才推第二条')
  notifier.dispose()
})

test('配置：插件配置里的 channels 被明确忽略（地址只能来自手机）', async () => {
  const warnings = []
  const resolved = resolveNotifyConfig({ channels: [{ type: 'feishu', url: 'https://x/y' }] }, (m) => warnings.push(m))
  assert.deepEqual(resolved, { enabled: true, debounceMs: NOTIFY_DEBOUNCE_MS })
  assert.ok(!('channels' in resolved))
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('忽略') && warnings[0].includes('手机'), warnings[0])
  const low = resolveNotifyConfig({ debounceMs: 10 }, () => {})
  assert.equal(low.debounceMs, 200, '小于下限取边界值')
  const off = resolveNotifyConfig({ enabled: false }, () => {})
  assert.equal(off.enabled, false)
})

// ═════════════════════════════════════════════════════════════════════════
// 真实 HTTP：设置页路由 + 假 webhook 服务器
// ═════════════════════════════════════════════════════════════════════════
test('设置页：保存飞书通道 → 触发一次待办 → 收到正确形状与口径', async () => {
  const empty = await call('/taskwatch/notify')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body.channels, [], '一开始没有任何通道')
  assert.equal(empty.body.anyEnabled, false)

  const hook = base + '/hook/' + TEST_TOKEN
  const added = await postJson('/taskwatch/notify/add', { type: 'feishu', url: hook })
  assert.equal(added.status, 200, JSON.stringify(added.body))
  assert.equal(added.body.channels.length, 1)
  const channel = added.body.channels[0]
  assert.equal(channel.type, 'feishu')
  assert.equal(channel.enabled, true)
  assert.ok(channel.masked.includes('（已保存）'), channel.masked)
  assert.ok(!channel.masked.includes(TEST_TOKEN), channel.masked)
  maskToken(added.text)

  resetHits()
  const reason = '删除 build/cache 下的 3 个过期产物目录，命令为 rm -rf build/cache --force'
  const { running } = triggerApproval('call-one', reason, 700)
  await sleep(500)
  assert.equal(hits.length, 1, '应只推送 1 条，实际 ' + hits.length)
  const hit = hits[0]
  assert.ok(hit.contentType.includes('application/json'), hit.contentType)
  const payload = JSON.parse(hit.raw)
  assert.deepEqual(Object.keys(payload), ['msg_type', 'content'])
  assert.equal(payload.msg_type, 'text')
  const text = payload.content.text
  assert.ok(text.includes('pwsh'), text)
  assert.ok(text.includes('1 件事等你'), text)
  assert.ok(text.includes('…'), '超过 30 字应补省略号')
  assert.ok(!text.includes('rm -rf'), '推送正文里不能出现完整命令')
  assert.ok(!text.includes('--force'), '推送正文里不能出现命令尾部')
  assert.ok(!text.includes('session-notify'), '不写会话 id')
  await running
  await sleep(50)
  // 释放后状态回到空，不会再多发一条。
  assert.equal(hits.length, 1)
})

test('三件同时出现 → 只推 1 条且写「3 件事」', async () => {
  resetHits()
  const a = triggerApproval('call-a', '删除 build/cache 下的过期产物', 900)
  await sleep(20)
  const b = triggerApproval('call-b', '改一处文案', 900, 'edit')
  await sleep(20)
  const c = handlers.get('user-questions/request')(
    { agent: { id: 'session-notify' }, wait: { callId: 'q-1' }, questions: [{ id: 'q1', header: '发布窗口', question: '今天还是明天发？', options: [{ label: '今天' }, { label: '明天' }] }] },
    async () => { await sleep(900); return { answers: [] } },
  )
  await sleep(1200)
  assert.equal(hits.length, 1, '三条待办必须合并成一条，实际 ' + hits.length)
  const text = JSON.parse(hits[0].raw).content.text
  assert.ok(text.startsWith('3 件事等你'), text)
  assert.equal((text.match(/^· /gm) || []).length, 3, text)
  assert.ok(!text.includes('还有'), text)
  await Promise.all([a.running, b.running, c])
  await sleep(80)
})

test('通道全部关闭 → 零请求（也不写审计）', async () => {
  const list = await call('/taskwatch/notify')
  const id = list.body.channels[0].id
  const off = await postJson('/taskwatch/notify/toggle', { id, enabled: false })
  assert.equal(off.status, 200)
  assert.equal(off.body.channels[0].enabled, false)
  const after = await call('/taskwatch/notify')
  assert.equal(after.body.anyEnabled, false, '关掉后必须明确「不会推送」')

  resetHits()
  const { running } = triggerApproval('call-off', '删除 build/cache 下的过期产物', 700)
  await sleep(900)
  assert.equal(hits.length, 0, '没有启用通道时不能发任何请求')
  await running
})

test('掩码：设置页响应与页面源码都不出现完整 URL', async () => {
  const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')
  // 页面必须真的有这块设置页，否则"不出现 URL"是空断言。
  for (const needle of ['id="notifyView"', '#notify', 'data-ntf-toggle', 'data-ntf-test',
    '发一条测试消息', '当前不会推送', '会收到什么', '还有 N 件']) {
    assert.ok(page.includes(needle), '缺少：' + needle)
  }
  // 列表只画宿主给好的 masked，绝不画 url；输入框只用于添加。
  assert.ok(page.includes('esc(c.masked)'))
  assert.ok(!page.includes('esc(c.url)'), '页面不能直接渲染完整地址')
  assert.ok(!page.includes(TEST_TOKEN), '页面源码里不能出现任何真实地址片段')

  const list = await call('/taskwatch/notify')
  maskToken(list.text)
  assert.ok(!list.text.includes('/hook/'), '响应里不能出现完整路径')
  assert.ok(list.body.channels[0].masked.includes('（已保存）'))
  assert.ok(!('url' in list.body.channels[0]), '响应里不能有 url 字段')
})

test('公网 http 地址被拒（且错误文案不回显地址）；https 可用', async () => {
  const bad = await postJson('/taskwatch/notify/add', { type: 'feishu', url: 'http://example.com/hook/' + TEST_TOKEN })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.ok, false)
  assert.ok(bad.body.error.includes('https'), bad.body.error)
  assert.ok(!bad.body.error.includes('example.com'), '错误文案不能回显地址')
  maskToken(bad.text)

  const badProto = await postJson('/taskwatch/notify/add', { type: 'feishu', url: 'ftp://example.com/x' })
  assert.equal(badProto.status, 400)
  assert.equal(badProto.body.error.includes('ftp://'), false)

  const good = await postJson('/taskwatch/notify/add', { type: 'webhook', url: 'https://example.com/hook/abc', format: 'json' })
  assert.equal(good.status, 200)
  assert.equal(good.body.channels.length, 2)
  assert.equal(good.body.channels[1].format, 'json')
  // 收尾：删掉这条 https 测试通道，后面的断言只面对假服务器那条。
  const removed = await postJson('/taskwatch/notify/remove', { id: good.body.channels[1].id })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.channels.length, 1)
})

test('发送失败（500）：不抛错、审计写 notify failed、回执不含 URL', async () => {
  const failHook = base + '/hook/fail'
  const added = await postJson('/taskwatch/notify/add', { type: 'webhook', url: failHook, format: 'json' })
  assert.equal(added.status, 200)
  const failId = added.body.channels.filter((c) => c.enabled).pop().id
  resetHits()
  const started = Date.now()
  const result = await postJson('/taskwatch/notify/test', { id: failId })
  const took = Date.now() - started
  assert.equal(result.status, 200, '失败也是一次结果汇报，不是服务器错误')
  assert.equal(result.body.ok, false)
  assert.equal(result.body.status, 500)
  assert.equal(result.body.attempts, 3, '最多试 3 次')
  assert.ok(took >= 3800, '默认退避 1s + 3s，实际 ' + took + 'ms')
  maskToken(result.text)
  assert.equal(hits.length, 3, '三次尝试都打到了假服务器')

  const audit = readFileSync(join(home, 'taskwatch-audit.log'), 'utf8')
  const lines = audit.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const failed = lines.filter((e) => e.kind === 'notify')
  assert.ok(failed.length >= 1, JSON.stringify(lines))
  assert.equal(failed[failed.length - 1].error, 'notify failed')
  assert.equal(failed[failed.length - 1].outcome, 'failed')
  assert.ok(!audit.includes(TEST_TOKEN), '审计里不能出现地址')
  assert.ok(!audit.includes('/hook/'), '审计里不能出现路径')
})

test('通知文件权限：windows 走 icacls（best-effort），POSIX 0600', async () => {
  assert.equal(notifyConfigPath({ DSH_HOME: home }, 'C:\\ignored'), join(home, NOTIFY_FILE_NAME))
  assert.equal(notifyConfigPath({}, 'C:\\Users\\demo'), join('C:\\Users\\demo', '.dsh', NOTIFY_FILE_NAME))

  const real = join(home, NOTIFY_FILE_NAME)
  const parsed = JSON.parse(readFileSync(real, 'utf8'))
  assert.equal(parsed.version, 1)
  assert.ok(Array.isArray(parsed.channels) && parsed.channels.length >= 1)
  assert.ok(parsed.channels.every((c) => typeof c.url === 'string' && c.url.startsWith('http')))

  if (process.platform === 'win32') {
    // Windows 没有 0600：退化为「去掉继承、只授权当前用户」的 best-effort。
    const calls = []
    const dir = mkdtempSync(join(tmpdir(), 'tw-notify-perm-'))
    try {
      const store = createNotifyStore({
        file: join(dir, NOTIFY_FILE_NAME),
        platform: 'win32',
        env: { USERNAME: 'demo-user' },
        run: (cmd, args) => { calls.push({ cmd, args }); return { status: 0 } },
      })
      const added = store.add({ type: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' })
      assert.equal(added.ok, true)
      assert.equal(calls.length, 1, '写盘后必须调用一次权限收紧')
      assert.equal(calls[0].cmd, 'icacls')
      assert.equal(calls[0].args[0], join(dir, NOTIFY_FILE_NAME))
      assert.equal(calls[0].args[1], '/inheritance:r')
      assert.equal(calls[0].args[2], '/grant:r')
      assert.equal(calls[0].args[3], 'demo-user:F')
      assert.equal(store.stats().permission, 'icacls:user-only(best-effort)')
    } finally {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 锁 */ }
    }
  } else {
    const mode = statSync(real).mode & 0o777
    assert.equal(mode, 0o600, 'POSIX 上必须是 0600，实际 ' + mode.toString(8))
  }
})

test('上限与去重：同一地址只留一条，最多 ' + NOTIFY_MAX_CHANNELS + ' 个通道', async () => {
  const hook = base + '/hook/' + TEST_TOKEN
  const again = await postJson('/taskwatch/notify/add', { type: 'feishu', url: hook })
  assert.equal(again.status, 200)
  assert.equal(again.body.existed, true, '同一地址不重复添加')
  const list = await call('/taskwatch/notify')
  assert.equal(list.body.channels.filter((c) => c.masked.includes('（已保存）')).length <= NOTIFY_MAX_CHANNELS, true)
  const missing = await postJson('/taskwatch/notify/toggle', { id: 'nope', enabled: true })
  assert.equal(missing.status, 404)
  const badBody = await postJson('/taskwatch/notify/toggle', { id: 'nope' })
  assert.equal(badBody.status, 400)
})

// ═════════════════════════════════════════════════════════════════════════
// v1.8.16 Server酱（推到微信）：请求形状 / SendKey 校验 / 掩码 / 只存 key / 关闭
// ═════════════════════════════════════════════════════════════════════════
// 隔离用的 store：不跑真的 icacls（那一步在别的用例里已经单独验过）。
const quietStore = (file) => createNotifyStore({
  file,
  platform: 'win32',
  env: { USERNAME: 'demo-user' },
  run: () => ({ status: 0 }),
})

test('serverchan：路径 /<key>.send、form、字段只有 title/desp、标题 ≤32 字', async () => {
  resetHits()
  // 标题故意超过 32 字：必须自己截断并补「…」，不能交给微信去截。
  const body = '很'.repeat(40) + '：pwsh · 删除 build/cache 下的过期产物'
  const sender = createNotifySender({ retryDelays: [], serverchanBase: base })
  const result = await sender.send({ type: 'serverchan', key: SCT_KEY }, body)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(sctHits.length, 1, '只该打一条请求，实际 ' + sctHits.length)
  const hit = sctHits[0]
  assert.equal(hit.path, '/' + SCT_KEY + '.send', '路径必须是 /<key>.send')
  assert.ok(hit.contentType.startsWith('application/x-www-form-urlencoded'), hit.contentType)
  const params = new URLSearchParams(hit.raw)
  assert.deepEqual([...params.keys()].sort(), ['desp', 'title'], '只允许 title / desp 两个字段')
  assert.equal(params.get('desp'), body)
  const title = params.get('title')
  assert.ok(title.length <= NOTIFY_SERVERCHAN_TITLE_MAX, '标题超长：' + title.length)
  assert.ok(title.endsWith('…'), title)
  // 不超长时，标题就是飞书那条标题（单条 / 多条都取首行冒号前）。
  assert.equal(notifyServerchanTitle('1 件事等你：pwsh · 删除 build/cache 下的…'), '1 件事等你')
  assert.equal(notifyServerchanTitle('3 件事等你：\n· pwsh · 改一处文案'), '3 件事等你')
  assert.ok(serverchanEndpoint(SCT_KEY).startsWith('https://sctapi.ftqq.com/'))
  assert.ok(serverchanEndpoint(SCT_KEY).endsWith('/' + SCT_KEY + '.send'))
})

test('serverchan：SendKey 校验（太短被拒、SCT + 12 位通过）', async () => {
  assert.equal(validateSendKey('abc').ok, false, 'abc 太短')
  assert.equal(validateSendKey('SCT123').ok, false, 'SCT123 太短')
  assert.equal(validateSendKey(SCT_KEY_12).ok, true, 'SCT + 12 位应通过')
  assert.equal(validateSendKey(SCT_KEY_12).key, SCT_KEY_12)
  assert.equal(validateSendKey('x'.repeat(65)).ok, false, '超过 64 位被拒')
  assert.equal(validateSendKey('SCT bad key 123').ok, false, '不允许空格')
  assert.equal(validateSendKey('').ok, false)

  const store = quietStore(join(home, 'sct-validate.json'))
  assert.equal(store.add({ type: 'serverchan', key: 'abc' }).ok, false)
  assert.equal(store.add({ type: 'serverchan', key: 'SCT123' }).ok, false)
  const added = store.add({ type: 'serverchan', key: SCT_KEY_12 })
  assert.equal(added.ok, true)
  assert.equal(added.channel.type, 'serverchan')
  assert.equal(added.channel.masked, 'SCT…-001')
  assert.ok(!('key' in added.channel), '对外视图不能有 key')
  assert.ok(!('url' in added.channel), '对外视图不能有 url')
})

test('serverchan：页面与接口响应都不出现完整 SendKey（只出 SCT…abcd）', async () => {
  const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')
  for (const needle of ['SendKey', 'sct.ftqq.com', 'Server酱', '推到微信', '摘要会经过 Server酱']) {
    assert.ok(page.includes(needle), '缺少：' + needle)
  }
  assert.ok(!page.includes(SCT_KEY), '页面源码里不能出现完整 SendKey')
  assert.equal(maskNotifyKey(SCT_KEY), 'SCT…abcd')
  assert.ok(!maskNotifyKey(SCT_KEY).includes('fake'))

  // 接口：add 响应里只有掩码，没有 key / url；GET 列表也一样。
  const added = await postJson('/taskwatch/notify/add', { type: 'serverchan', key: SCT_KEY })
  assert.equal(added.status, 200, added.text)
  assert.ok(!added.text.includes(SCT_KEY), 'add 响应里出现了完整 SendKey')
  const sct = added.body.channels.find((c) => c.type === 'serverchan')
  assert.ok(sct, JSON.stringify(added.body))
  assert.equal(sct.masked, 'SCT…abcd')
  assert.ok(!('key' in sct) && !('url' in sct), '响应里不能有 key / url 字段')

  const list = await call('/taskwatch/notify')
  assert.ok(!list.text.includes(SCT_KEY), '列表响应里出现了完整 SendKey')
  const removed = await postJson('/taskwatch/notify/remove', { id: sct.id })
  assert.equal(removed.status, 200)
  assert.ok(!removed.text.includes(SCT_KEY))
})

test('serverchan：配置里只认 key，url 字段存在也被忽略', async () => {
  const file = join(home, 'sct-ignore-url.json')
  writeFileSync(file, JSON.stringify({
    version: 1,
    channels: [
      // 同一条通道同时塞了 key 和完整 URL：只能认 key，URL 不能进内存/落盘。
      { id: 'k1', type: 'serverchan', key: SCT_KEY, url: 'https://sctapi.ftqq.com/' + SCT_KEY + '.send', enabled: true },
      // 只有 URL、没有 key：直接丢弃，不能把 URL 当 key 存下来。
      { id: 'k2', type: 'serverchan', url: 'https://sctapi.ftqq.com/' + SCT_KEY + '.send', enabled: true },
    ],
  }), 'utf8')
  const store = quietStore(file)
  const list = store.list()
  assert.equal(list.length, 1, '只有带合法 key 的条目保留')
  assert.equal(list[0].masked, 'SCT…abcd')
  assert.ok(!('key' in list[0]) && !('url' in list[0]))
  const internal = store.channelForSend('k1')
  assert.equal(internal.key, SCT_KEY)
  assert.equal(internal.url, undefined, 'serverchan 内部形态不该带 url')
  // add 时同时塞 URL 也一样：只存 key（这次写盘会把读坏的 k2 一起清掉）。
  const added = store.add({ type: 'serverchan', key: SCT_KEY_12, url: 'https://evil.example/' + SCT_KEY + '.send' })
  assert.equal(added.ok, true)
  const persisted = JSON.parse(readFileSync(file, 'utf8')).channels
  assert.equal(persisted.length, 2, 'k2（只有 url）必须被丢掉')
  assert.ok(persisted.every((c) => typeof c.key === 'string'), '每一条都只该有 key')
  assert.ok(persisted.every((c) => !('url' in c)), '落盘不能有 url')
  assert.ok(!persisted.some((c) => c.id === 'k2'), '没有 key 的条目不能留下')
  const saved = persisted.find((c) => c.key === SCT_KEY_12)
  assert.ok(saved, '应写入 key')
})

test('serverchan：关闭后零请求（不排定时器、不发请求、不写审计）', async () => {
  const store = quietStore(join(home, 'sct-off.json'))
  const added = store.add({ type: 'serverchan', key: SCT_KEY })
  assert.equal(added.ok, true)
  assert.equal(store.setEnabled(added.channel.id, false).ok, true)
  assert.equal(store.enabledChannels().length, 0, '关闭后不该出现在启用列表里')
  let sends = 0
  const notifier = createNotifier({
    store,
    debounceMs: 10,
    pending: () => [{ kind: 'approval', title: 'pwsh', detail: 'x' }],
    send: async () => { sends++; return { ok: true, status: 200 } },
    audit: () => { throw new Error('不该写审计') },
  })
  notifier.poke()
  await sleep(40)
  assert.equal(sends, 0, '关闭的 serverchan 通道不能发任何请求')
  assert.equal(notifier.stats().waiting, false, '不该留下定时器')
  notifier.dispose()
})

// ── 跑完所有用例 ──────────────────────────────────────────────────────────
try {
  for (const { name, fn } of asyncTests) {
    try {
      await fn()
      console.log('  PASS  ' + name)
    } catch (e) {
      failures++
      console.log('  FAIL  ' + name + ' — ' + ((e && e.message) || e))
    }
  }
  // 最后一道闸：整轮跑完，日志里也不许出现那个 token / SendKey。
  const leaked = logs.filter((line) => line.includes(TEST_TOKEN) || line.includes('/hook/') || line.includes(SCT_KEY))
  if (leaked.length) {
    failures++
    console.log('  FAIL  日志泄漏地址 / SendKey — ' + leaked[0].slice(0, 160))
  } else {
    console.log('  PASS  日志里没有出现 webhook 地址与 SendKey')
  }
  // 通配检查：所有通知路由都注册上了。
  for (const path of ['/taskwatch/notify', '/taskwatch/notify/add', '/taskwatch/notify/toggle',
    '/taskwatch/notify/remove', '/taskwatch/notify/test']) {
    if (!routes.has(path)) { failures++; console.log('  FAIL  缺少路由 ' + path) }
  }
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 旧 Node */ }
  await new Promise((resolve) => server.close(resolve))
  try { rmSync(home, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}
