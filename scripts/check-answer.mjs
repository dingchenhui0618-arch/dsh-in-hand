#!/usr/bin/env node
/**
 * v1.8.3 手机端回答选项式提问（P0 第二类）的契约测试。
 *
 * 与 check-approval.mjs 同一个套路，分三层：
 *   1. 纯函数：validateAnswers / questionTitleOf 直接钉规则与 field；
 *   2. 真实 HTTP：apply() 注册的 /taskwatch/answer 与 /taskwatch/data 走 node:http +
 *      fetch，和手机实际打的是同一条路；fake event 直接驱动 handler，断言宿主
 *      收到的就是 { answers:[{id,selected}] }；
 *   3. 真浏览器：Chrome headless + CDP 打开 docs/demo.html（与 page.html 同源构建），
 *      断言选项行 ≥44px、计划审批徽标、未答完时提交键 disabled、单选的替换语义。
 *
 * 失败语义与审批逐条对齐：离线立刻 next()、超时 next() 且审计 by:'timeout'、
 * abort 立刻交还、内部异常 next()；错误码 400 / 404 / 409 / 410。
 *
 * 本机没有 Chrome 时页面那一节 SKIP（不算失败），其余照常断言。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'tw-answer-'))
process.env.DSH_HOME = home

const {
  apply,
  createApprovalBroker,
  createQuestionGate,
  validateAnswers,
  questionTitleOf,
  normalizeQuestionItems,
  auditLogPath,
  ANSWER_CUSTOM_MAX,
} = await import('../lib/index.js')

let failures = 0
function test(name, fn) {
  return (async () => {
    try {
      await fn()
      console.log('  PASS  ' + name)
    } catch (e) {
      failures++
      console.log('  FAIL  ' + name + ' — ' + (e && e.message ? e.message : e))
    }
  })()
}

function q1(over = {}) {
  return Object.assign({
    id: 'q-window',
    header: '发布窗口',
    question: '发布窗口选哪个？',
    options: [
      { label: '今天 18:00', description: '下班前发' },
      { label: '明天 10:00', description: '留一晚观察' },
    ],
    multiSelect: false,
  }, over)
}
function q2(over = {}) {
  return Object.assign({
    id: 'q-channel',
    header: '发布渠道',
    question: '走哪些渠道？',
    options: [{ label: '应用内' }, { label: '邮件' }, { label: '短信' }],
    multiSelect: true,
  }, over)
}
function fakeEvent(questions, extra = {}) {
  return Object.assign({
    questions,
    agent: { id: 'session-answer' },
    wait: { callId: 'call-' + Math.random().toString(36).slice(2) },
  }, extra)
}

// ── 1. 纯函数 ──────────────────────────────────────────────────────────────
console.log('\n校验与标题')

await test('标题优先取 header，没有就取问题前 40 字', () => {
  assert.equal(questionTitleOf({ header: '发布窗口', question: '发布窗口选哪个？' }), '发布窗口')
  const long = '一'.repeat(80)
  const got = questionTitleOf({ question: long })
  assert.equal(got.length, 41)
  assert.ok(got.endsWith('…'))
})

await test('normalizeQuestionItems 丢掉没有 id 的题、收敛 intent 形状', () => {
  const got = normalizeQuestionItems({
    questions: [
      { question: '没有 id' },
      { id: 'a', question: 'A', options: [{ label: 'x', description: 'dx' }, { description: '无 label' }],
        intent: { kind: 'plan-review', approve: 'x', callId: 'secret' } },
    ],
  })
  assert.equal(got.length, 1)
  assert.equal(got[0].id, 'a')
  assert.equal(got[0].options.length, 1)
  assert.deepEqual(got[0].intent, { kind: 'plan-review', approve: 'x' })
})

await test('少答一题 → field 指向缺失的那道题', () => {
  const bad = validateAnswers(normalizeQuestionItems({ questions: [q1(), q2()] }),
    [{ id: 'q-window', selected: ['明天 10:00'] }])
  assert.equal(bad.ok, false)
  assert.equal(bad.field, 'answers[1]')
  assert.match(bad.error, /q-channel/)
})

await test('selected 不在 options 里 / 单选传多项 / custom 超长 都被拒', () => {
  const qs = normalizeQuestionItems({ questions: [q1(), q2(), q1({ id: 'q-note', multiSelect: false })] })
  assert.equal(validateAnswers(qs, [
    { id: 'q-window', selected: ['不存在的选项'] },
    { id: 'q-channel', selected: ['邮件'] },
    { id: 'q-note', selected: [] },
  ]).field, 'answers[0].selected')
  assert.equal(validateAnswers(qs, [
    { id: 'q-window', selected: ['今天 18:00', '明天 10:00'] },
    { id: 'q-channel', selected: ['邮件'] },
    { id: 'q-note', selected: [] },
  ]).field, 'answers[0].selected')
  const long = validateAnswers(qs, [
    { id: 'q-window', selected: ['今天 18:00'] },
    { id: 'q-channel', selected: ['邮件'] },
    { id: 'q-note', selected: [], custom: 'x'.repeat(ANSWER_CUSTOM_MAX + 1) },
  ])
  assert.equal(long.field, 'answers[2].custom')
})

await test('多选可以传多项，custom 允许 2000 字', () => {
  const qs = normalizeQuestionItems({ questions: [q1(), q2()] })
  const got = validateAnswers(qs, [
    { id: 'q-window', selected: ['明天 10:00'], custom: '顺便说一句' },
    { id: 'q-channel', selected: ['邮件', '短信'] },
  ])
  assert.equal(got.ok, true)
  assert.equal(got.answers.length, 2)
  assert.deepEqual(got.answers[1].selected, ['邮件', '短信'])
})

await test('重复 label 去重；未知题目 id 被拒', () => {
  const qs = normalizeQuestionItems({ questions: [q2()] })
  assert.deepEqual(validateAnswers(qs, [{ id: 'q-channel', selected: ['邮件', '邮件'] }]).answers[0].selected, ['邮件'])
  assert.equal(validateAnswers(qs, [{ id: 'nope', selected: [] }]).field, 'answers[0].id')
})

// ── 2. gate 的失败语义（50ms 超时能真跑完）────────────────────────────────
console.log('\n闸门控制流')

// broker 的超时定时器故意 unref（宿主进程不该被它拖住），而脚本这一段还没有
// HTTP 服务这种 ref 句柄 —— 没有这个 keepAlive，Node 会在 50ms 到点前就退出，
// 表现为 "Detected unsettled top-level await"。测试结束立刻清掉。
const keepAlive = setInterval(() => {}, 1000)

function gateHarness({ timeoutMs = 120000, online = true } = {}) {
  const audits = []
  const pending = new Map()
  const broadcasts = []
  const gate = createQuestionGate({
    timeoutMs,
    isPhoneOnline: () => online,
    audit: (entry) => audits.push(entry),
    onPending: (key, entry) => pending.set(key, entry),
    onRelease: (key) => pending.delete(key),
    onBroadcast: (event) => broadcasts.push(event),
  })
  return { gate, audits, pending, broadcasts }
}

await test('手机离线：立刻 next()，不建可决定卡', async () => {
  const { gate, audits, pending, broadcasts } = gateHarness({ online: false })
  let nexts = 0
  const got = await gate.handle(fakeEvent([q1()]), async () => { nexts++; return { answers: [{ id: 'host' }] } })
  assert.equal(nexts, 1)
  assert.deepEqual(got, { answers: [{ id: 'host' }] })
  assert.equal(pending.size, 0, '交还后不能留下待办')
  assert.equal(audits.length, 0, '离线不是一次决定，不该写审计')
  assert.equal(broadcasts.length, 0)
})

await test('超时：next() 且审计 by=timeout / kind=question', async () => {
  const { gate, audits } = gateHarness({ timeoutMs: 50 })
  let nexts = 0
  const started = Date.now()
  const got = await gate.handle(fakeEvent([q1()]), async () => { nexts++; return { answers: [] } })
  assert.equal(nexts, 1)
  assert.deepEqual(got, { answers: [] })
  assert.ok(Date.now() - started >= 40)
  const entry = audits.find((e) => e.kind === 'question')
  assert.ok(entry, '必须有提问审计')
  assert.equal(entry.by, 'timeout')
  assert.equal(entry.outcome, 'delegated')
  assert.equal(entry.title, '发布窗口')
})

await test('signal abort：立刻交还，审计 by=desktop', async () => {
  const { gate, audits } = gateHarness()
  const ac = new AbortController()
  let nexts = 0
  const p = gate.handle(fakeEvent([q1()], { signal: ac.signal }), async () => { nexts++; return { answers: [] } })
  await new Promise((r) => setTimeout(r, 30))
  ac.abort()
  await p
  assert.equal(nexts, 1)
  const entry = audits.find((e) => e.kind === 'question')
  assert.equal(entry.by, 'desktop')
  assert.equal(entry.outcome, 'cancelled')
})

await test('内部异常：next() 且只调用一次 next', async () => {
  const audits = []
  const gate = createQuestionGate({
    timeoutMs: 120000,
    isPhoneOnline: () => true,
    audit: (entry) => audits.push(entry),
    onPending: () => { throw new Error('observability exploded') },
  })
  let nexts = 0
  const got = await gate.handle(fakeEvent([q1()]), async () => { nexts++; return { answers: [{ id: 'host' }] } })
  assert.equal(nexts, 1, '内部异常必须交还，且只能交还一次')
  assert.deepEqual(got, { answers: [{ id: 'host' }] })
  const entry = audits.find((e) => e.outcome === 'error')
  assert.ok(entry, '内部异常要留 error 审计')
  assert.equal(entry.by, 'error')
  assert.equal(entry.kind, 'question')
})

// ── 3. 真实 HTTP ──────────────────────────────────────────────────────────
console.log('\nHTTP 路由')
clearInterval(keepAlive)

const routes = new Map()
const handlers = new Map()
const webServer = { register(spec) { routes.set(spec.path, spec.handler); return () => {} } }
const ctx = {
  get(name) { return name === 'webServer' ? webServer : undefined },
  effect(fn) { return fn() },
  on(event, fn) { handlers.set(event, fn); return () => {} },
}
apply(ctx, { approveFromPhone: true })

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const handler = routes.get(path)
  if (!handler) { res.writeHead(404); res.end(); return }
  Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: String(error && error.message || error) }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

async function call(path, init = {}) {
  const response = await fetch(base + path, init)
  const text = await response.text()
  let body = {}
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: response.status, body }
}
const postAnswer = (body) => call('/taskwatch/answer', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
async function waitFor(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 30))
  }
  throw new Error('等待条件超时')
}
async function pendingList() {
  await call('/taskwatch/data?view=phone')   // 顺带把手机标记成在线
  const res = await call('/taskwatch/data?view=phone')
  return Array.isArray(res.body.pending) ? res.body.pending : []
}
/** 先标记手机在线（闸门是在 handler 启动那一刻判断的），再记下已经在 pending 里的 id。
 *  后者是为了避开 /data 的 1 秒快照缓存：那里可能还留着上一题，按 id 排除掉。 */
async function arm() {
  const list = await pendingList()
  await new Promise((r) => setTimeout(r, 80))
  return new Set(list.map((p) => String(p.id)))
}
async function waitNewQuestion(before, title) {
  let found = null
  await waitFor(async () => {
    const list = await pendingList()
    found = list.find((p) => p.kind === 'question' && p.title === title
      && p.canDecide === true && !before.has(String(p.id))) || null
    return !!found
  })
  return found
}

const driver = handlers.get('user-questions/request')
assert.equal(typeof driver, 'function', 'user-questions/request 必须注册为 waterfall')

await test('正常单选 → 200，宿主收到 { answers:[{id,selected}] }', async () => {
  let nexts = 0
  const before = await arm()
  const hostAnswer = { answers: [{ id: 'q-window', selected: ['桌面端的答案'] }] }
  const done = driver(fakeEvent([q1()], { wait: { callId: 'call-single' } }), async () => {
    nexts++
    return hostAnswer
  })
  const card = await waitNewQuestion(before, '发布窗口')
  assert.ok(card, 'pending 里要有这张提问卡')
  assert.equal(card.canDecide, true)
  assert.equal(card.kind, 'question')
  assert.equal(card.multiSelect, false)
  assert.equal(card.options.length, 2)
  assert.equal(card.options[1].label, '明天 10:00')
  assert.equal(card.options[1].description, '留一晚观察')
  assert.ok(card.expiresAt > Date.now(), '必须有倒计时截止时间')
  const res = await postAnswer({ id: card.id, answers: [{ id: 'q-window', selected: ['明天 10:00'] }] })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(res.body.answers, [{ id: 'q-window', selected: ['明天 10:00'] }])
  const got = await done
  assert.equal(nexts, 0, '认领成功就不该再调 next()')
  assert.deepEqual(got, { answers: [{ id: 'q-window', selected: ['明天 10:00'] }] })
})

await test('少答一题 → 400 且 field 指向缺失那题，且不消费这次提问', async () => {
  let nexts = 0
  const before = await arm()
  const done = driver(fakeEvent([q1(), q2()], { wait: { callId: 'call-multi' } }), async () => {
    nexts++
    return { answers: [] }
  })
  const card = await waitNewQuestion(before, '发布窗口')
  assert.ok(card)
  const bad = await postAnswer({ id: card.id, answers: [{ id: 'q-window', selected: ['明天 10:00'] }] })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.field, 'answers[1]')
  // 400 之后仍然可以补交 —— 校验失败绝不能把机会用掉。
  const ok = await postAnswer({
    id: card.id,
    answers: [
      { id: 'q-window', selected: ['明天 10:00'] },
      { id: 'q-channel', selected: ['邮件', '短信'] },
    ],
  })
  assert.equal(ok.status, 200)
  await done
  assert.equal(nexts, 0)
})

await test('selected 不在 options → 400；multiSelect=false 传多项 → 400', async () => {
  const before = await arm()
  const done = driver(fakeEvent([q1()], { wait: { callId: 'call-invalid' } }), async () => ({ answers: [] }))
  const card = await waitNewQuestion(before, '发布窗口')
  assert.ok(card)
  const outside = await postAnswer({ id: card.id, answers: [{ id: 'q-window', selected: ['随手编的'] }] })
  assert.equal(outside.status, 400)
  assert.equal(outside.body.field, 'answers[0].selected')
  const double = await postAnswer({
    id: card.id,
    answers: [{ id: 'q-window', selected: ['今天 18:00', '明天 10:00'] }],
  })
  assert.equal(double.status, 400)
  assert.equal(double.body.field, 'answers[0].selected')
  // 收尾：正常提交一次，让这次提问交还并释放 pending。
  const ok = await postAnswer({ id: card.id, answers: [{ id: 'q-window', selected: ['今天 18:00'] }] })
  assert.equal(ok.status, 200)
  await done
})

await test('重复提交 → 409；未知 id → 404；缺 id / answers 非数组 → 400', async () => {
  const before = await arm()
  const done = driver(fakeEvent([q1()], { wait: { callId: 'call-dup' } }), async () => ({ answers: [] }))
  const card = await waitNewQuestion(before, '发布窗口')
  assert.ok(card)
  const body = { id: card.id, answers: [{ id: 'q-window', selected: ['明天 10:00'] }] }
  assert.equal((await postAnswer(body)).status, 200)
  const again = await postAnswer(body)
  assert.equal(again.status, 409)
  await done
  assert.equal((await postAnswer({ id: 'no-such-id', answers: [] })).status, 404)
  assert.equal((await postAnswer({ answers: [] })).status, 400)
  assert.equal((await postAnswer({ id: card.id, answers: 'nope' })).status, 400)
})

// 审计：用一道专属题走完整链路，断言形状与"不记答案原文"。
await test('审计：answered / by=phone / selectedCount / custom', async () => {
  const before = await arm()
  const done = driver(fakeEvent([
    q1({ id: 'q-audit', header: '审计用题' }),
    q2({ id: 'q-audit-multi', header: '审计多选' }),
  ], { wait: { callId: 'call-audit' } }), async () => ({ answers: [] }))
  const card = await waitNewQuestion(before, '审计用题')
  assert.ok(card)
  const res = await postAnswer({
    id: card.id,
    answers: [
      { id: 'q-audit', selected: ['今天 18:00'], custom: '这句不该进日志' },
      { id: 'q-audit-multi', selected: ['邮件', '短信'] },
    ],
  })
  assert.equal(res.status, 200)
  await done
  const text = readFileSync(auditLogPath(), 'utf8')
  const entries = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const entry = entries.filter((e) => e.kind === 'question' && e.title === '审计用题').pop()
  assert.ok(entry, '必须留下提问审计')
  assert.equal(entry.outcome, 'answered')
  assert.equal(entry.by, 'phone')
  assert.equal(entry.session, 'session-answer')
  assert.equal(entry.selectedCount, 3)
  assert.equal(entry.custom, true)
  assert.equal(typeof entry.at, 'string')
  // 审计不记答案原文（选项没选什么、自定义写了什么都不进日志）。
  assert.ok(!('answers' in entry))
  assert.ok(!JSON.stringify(entry).includes('这句不该进日志'))
  assert.ok(!JSON.stringify(entry).includes('今天 18:00'))
})

await test('超时后的 id → answer() 得 410（已交还，不二次消费）', async () => {
  const audits = []
  const broker = createApprovalBroker({ timeoutMs: 50, audit: (entry) => audits.push(entry) })
  const claim = broker.begin({ session: 's', kind: 'question', title: '超时题', questions: [] })
  await new Promise((r) => setTimeout(r, 90))
  const res = broker.answer(claim.id, [])
  assert.equal(res.status, 410)
  const entry = audits.find((e) => e.kind === 'question')
  assert.equal(entry.by, 'timeout')
  assert.equal(entry.outcome, 'delegated')
})

// ── 4. 页面（真 Chrome + CDP）──────────────────────────────────────────────
console.log('\n页面')

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]
const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), 8000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = (e) => { clearTimeout(t); reject(e) }
    })
    return new Cdp(ws)
  }
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id || !this.pending.has(msg.id)) return
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 20000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
    })
  }
  close() { try { this.ws.close() } catch { /* 已断开 */ } }
}

async function waitPort(profile, child) {
  const deadline = Date.now() + 15000
  const file = join(profile, 'DevToolsActivePort')
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Chrome 启动即退出，code=' + child.exitCode)
    if (existsSync(file)) {
      const first = readFileSync(file, 'utf8').split(/\r?\n/)[0]
      if (first) return Number(first)
    }
    await sleep(100)
  }
  throw new Error('等不到 DevToolsActivePort')
}

const DEMO = join(ROOT, 'docs', 'demo.html')
let browserChild = null
let browserProfile = ''
let demoServer = null

try {
  if (!chrome) {
    console.log('  SKIP 页面自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
  } else {
    const demoHtml = readFileSync(DEMO, 'utf8')
    const icon192 = readFileSync(join(ROOT, 'lib', 'icons', 'icon-192.png'))
    demoServer = http.createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname
      if (path === '/demo') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(demoHtml)
        return
      }
      if (path === '/taskwatch/icon-192.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(icon192)
        return
      }
      res.writeHead(404); res.end('not found')
    })
    await new Promise((r) => demoServer.listen(0, '127.0.0.1', r))
    const demoUrl = 'http://127.0.0.1:' + demoServer.address().port + '/demo'

    browserProfile = mkdtempSync(join(tmpdir(), 'tw-answer-chrome-'))
    browserChild = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
      '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
      '--remote-debugging-port=0', '--user-data-dir=' + browserProfile, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    const port = await waitPort(browserProfile, browserChild)
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const browser = await Cdp.connect(version.webSocketDebuggerUrl)

    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const info = list.find((t) => t.id === targetId)
    const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    const evalJs = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result && r.result.value
    }
    await cdp.send('Page.navigate', { url: demoUrl })
    await sleep(1600)

    /** 把一份 pending 灌进页面、回到首页并强制重画。 */
    const inject = (pending) => evalJs(`(function(){
      lastData = {
        generatedAt: Date.now(), offline: false, errors: [],
        totals: {sessions:1,running:0,jobs:0,jobsRunning:0,subagents:0,workflows:0,pending:${pending.length}},
        today: {since:Date.now()-21600000,turns:1,steps:1,sessions:1,partial:false},
        pending: ${JSON.stringify(pending)},
        sessions: [], jobs: [], subagents: [], workflows: []
      };
      HOME_GOOD = null;
      HOME.settled = {};
      HOME.more = false;
      setView('home');
      renderHomeTodo(true);
      bindApprovals();
      return true;
    })()`)

    const single = {
      id: 'q-single', kind: 'question', title: '发布窗口选哪个', detail: '今天 18:00 还是明天 10:00 发？',
      session: 'session-demo-b', at: Date.now() - 1000, canDecide: true,
      expiresAt: Date.now() + 118000, timeoutMs: 120000, multiSelect: false,
      intent: { kind: 'plan-review', approve: '明天 10:00' },
      options: [
        { label: '今天 18:00', description: '下班前发，晚高峰前收工' },
        { label: '明天 10:00', description: '留一晚观察，明早再发' },
        { label: '再想想', description: '先别定，等白天再说' },
      ],
      questions: [{
        id: 'q-window', header: '发布窗口', question: '发布窗口选哪个？',
        options: [
          { label: '今天 18:00', description: '下班前发，晚高峰前收工' },
          { label: '明天 10:00', description: '留一晚观察，明早再发' },
          { label: '再想想', description: '先别定，等白天再说' },
        ],
        multiSelect: false,
        intent: { kind: 'plan-review', approve: '明天 10:00' },
      }],
    }

    await inject([single])
    const cardView = await evalJs(`(function(){
      var card = document.querySelector('#homeTodo .q-card');
      if (!card) return {found:false};
      var opts = card.querySelectorAll('.q-opt');
      var hs = [], descs = 0;
      for (var i = 0; i < opts.length; i++) {
        hs.push(Math.round(opts[i].getBoundingClientRect().height));
        if (opts[i].querySelector('.q-desc')) descs++;
      }
      var submit = card.querySelector('[data-qsubmit]');
      var plain = card.querySelector('.q-custom');
      var plan = card.querySelector('.q-plan');
      var primary = card.querySelector('.q-opt.q-primary');
      return {
        found: true, count: opts.length, heights: hs, descs: descs,
        submitDisabled: !!submit && submit.disabled,
        submitH: submit ? Math.round(submit.getBoundingClientRect().height) : 0,
        customHidden: !!plain && plain.getBoundingClientRect().height === 0,
        plan: plan ? plan.textContent.trim() : '',
        primary: primary ? primary.getAttribute('data-qval') : '',
        widths: {
          iw: innerWidth, doc: document.documentElement.scrollWidth,
          body: document.body.scrollWidth, card: card.scrollWidth,
        },
      };
    })()`)
    await test('页面：question 卡渲染整行选项（≥44px，带 description），计划审批有徽标与主色项', () => {
      assert.equal(cardView.found, true, '没有渲染出 .q-card')
      assert.equal(cardView.count, 3)
      assert.deepEqual(cardView.heights.every((h) => h >= 44), true, JSON.stringify(cardView.heights))
      assert.equal(cardView.descs, 3)
      assert.equal(cardView.plan, '计划审批')
      assert.equal(cardView.primary, '明天 10:00')
      assert.equal(cardView.submitH >= 44, true)
      assert.equal(cardView.customHidden, true, '自定义回答默认不展开')
      assert.ok(cardView.widths.doc <= cardView.widths.iw + 1, JSON.stringify(cardView.widths))
    })

    await test('页面：未答完时提交键禁用；选中后才放开；单选点第二个替换第一个', async () => {
      assert.equal(cardView.submitDisabled, true)
      const after = await evalJs(`(function(){
        var card = document.querySelector('#homeTodo .q-card');
        var opts = card.querySelectorAll('.q-opt');
        var submit = card.querySelector('[data-qsubmit]');
        opts[0].click();
        var afterFirst = submit.disabled;
        var pressed1 = card.querySelectorAll('.q-opt[aria-pressed="true"]').length;
        opts[2].click();
        var pressed2 = card.querySelectorAll('.q-opt[aria-pressed="true"]').length;
        var secondOn = opts[2].getAttribute('aria-pressed') === 'true';
        var firstOff = opts[0].getAttribute('aria-pressed') === 'false';
        return {afterFirst:afterFirst, pressed1:pressed1, pressed2:pressed2, secondOn:secondOn, firstOff:firstOff,
          submitDisabled:submit.disabled};
      })()`)
      assert.equal(after.pressed1, 1)
      assert.equal(after.afterFirst, false, '选中一项后提交键要放开')
      assert.equal(after.pressed2, 1, '单选不能同时选中两项')
      assert.equal(after.secondOn, true)
      assert.equal(after.firstOff, true)
      assert.equal(after.submitDisabled, false)
    })

    await test('页面：提交把 {id, answers} POST 给 /taskwatch/answer，成功后卡片收起', async () => {
      const got = await evalJs(`(async function(){
        var calls = [];
        var real = window.fetch;
        window.fetch = function(u, o) {
          calls.push({u: String(u), body: (o && o.body) || ''});
          return Promise.resolve({ok:true, status:200, json:function(){return Promise.resolve({ok:true})}});
        };
        var card = document.querySelector('#homeTodo .q-card');
        card.querySelector('[data-qsubmit]').click();
        await new Promise(function(r){ setTimeout(r, 120) });
        var state = card.querySelector('[data-state]');
        var list = card.querySelector('.q-list');
        window.fetch = real;
        return {
          call: calls[0] || null,
          state: state ? state.textContent.trim() : '',
          listHidden: list ? list.getBoundingClientRect().height === 0 : false,
        };
      })()`)
      assert.ok(got.call, '没有发出请求')
      assert.equal(new URL(got.call.u, 'http://x').pathname, '/taskwatch/answer')
      const body = JSON.parse(got.call.body)
      assert.equal(body.id, 'q-single')
      assert.deepEqual(body.answers, [{ id: 'q-window', selected: ['再想想'] }])
      assert.equal(got.state, '已提交')
      assert.equal(got.listHidden, true, '提交成功后选项区要收起')
    })

    await test('页面：超长选项与说明换行不截断、不撑破页面', async () => {
      const longLabel = '这是一条很长很长的选项文本'.repeat(6)
      const longDesc = '说明也可以很长，'.repeat(12)
      await inject([{
        id: 'q-long', kind: 'question', title: '长文本', detail: '看换行',
        session: 'session-demo-b', at: Date.now() - 1000, canDecide: true,
        expiresAt: Date.now() + 118000, timeoutMs: 120000, multiSelect: false,
        questions: [{
          id: 'q-long', header: '长文本', question: '下面这条能完整看见吗？',
          options: [{ label: longLabel, description: longDesc }],
          multiSelect: false,
        }],
      }])
      const info = await evalJs(`(function(){
        var card = document.querySelector('#homeTodo .q-card');
        var opt = card.querySelector('.q-opt');
        var lab = card.querySelector('.q-label');
        var cs = getComputedStyle(lab);
        return {
          optH: Math.round(opt.getBoundingClientRect().height),
          labH: Math.round(lab.getBoundingClientRect().height),
          labelScroll: lab.scrollWidth, labelClient: lab.clientWidth,
          optScroll: opt.scrollWidth, optClient: opt.clientWidth,
          whiteSpace: cs.whiteSpace, lineClamp: cs.webkitLineClamp,
          overflowX: document.documentElement.scrollWidth - innerWidth,
          fullyShown: lab.scrollHeight <= lab.clientHeight + 2,
        };
      })()`)
      assert.ok(info.optH >= 44)
      assert.ok(info.labH > 44, '长文本必须换成多行（高度超过一行）')
      assert.equal(info.whiteSpace, 'normal')
      assert.ok(info.lineClamp === 'none' || info.lineClamp === '', '不能用行数截断')
      assert.ok(info.labelScroll <= info.labelClient + 1, '选项文本不能横向溢出')
      assert.ok(info.optScroll <= info.optClient + 1)
      assert.ok(info.overflowX <= 1)
      assert.equal(info.fullyShown, true, '文本不能靠 overflow:hidden 藏起来')
    })

    // ── 多题 + 多选 ────────────────────────────────────────────────────────
    const multi = {
      id: 'q-multi', kind: 'question', title: '发布计划', detail: '两个问题，答完才能提交。',
      session: 'session-demo-b', at: Date.now() - 1000, canDecide: true,
      expiresAt: Date.now() + 118000, timeoutMs: 120000,
      options: [{ label: '今天 18:00' }], multiSelect: false,
      questions: [
        { id: 'q-a', header: '窗口', question: '发布窗口选哪个？', options: [
          { label: '今天 18:00', description: '下班前发' }, { label: '明天 10:00', description: '留一晚观察' },
        ], multiSelect: false },
        { id: 'q-b', header: '渠道', question: '通知发到哪里？', options: [
          { label: '应用内' }, { label: '邮件' }, { label: '短信' },
        ], multiSelect: true },
      ],
    }
    await inject([multi])
    const multiView = await evalJs(`(function(){
      var card = document.querySelector('#homeTodo .q-card');
      var items = card.querySelectorAll('.q-item');
      var need = card.querySelectorAll('.q-need');
      var submit = card.querySelector('[data-qsubmit]');
      var count = card.querySelector('[data-qcount]');
      var visibleNeed = 0;
      for (var i = 0; i < need.length; i++) if (need[i].getBoundingClientRect().height > 0) visibleNeed++;
      return {items:items.length, needs:need.length, visibleNeed:visibleNeed,
        count:count?count.textContent.trim():'', disabled:submit.disabled};
    })()`)
    await test('页面：多题纵排、未答题目标出、答完前禁用提交', async () => {
      assert.equal(multiView.items, 2)
      assert.equal(multiView.visibleNeed, 2)
      assert.equal(multiView.count, '0 / 2 题已回答')
      assert.equal(multiView.disabled, true)
      const step = await evalJs(`(function(){
        var card = document.querySelector('#homeTodo .q-card');
        var submit = card.querySelector('[data-qsubmit]');
        card.querySelectorAll('.q-item')[0].querySelectorAll('.q-opt')[1].click();
        var afterOne = submit.disabled;
        var count1 = card.querySelector('[data-qcount]').textContent.trim();
        var need1 = card.querySelectorAll('.q-need')[0].getBoundingClientRect().height;
        var opts2 = card.querySelectorAll('.q-item')[1].querySelectorAll('.q-opt');
        opts2[1].click(); opts2[2].click();
        var pressed2 = card.querySelectorAll('.q-item')[1].querySelectorAll('.q-opt[aria-pressed="true"]').length;
        var count2 = card.querySelector('[data-qcount]').textContent.trim();
        var afterTwo = submit.disabled;
        return {afterOne:afterOne, count1:count1, need1:need1, pressed2:pressed2, count2:count2, afterTwo:afterTwo};
      })()`)
      assert.equal(step.afterOne, true, '只答一题时提交键仍要禁用')
      assert.equal(step.count1, '1 / 2 题已回答')
      assert.equal(step.need1, 0, '答过的题不该再显示「待回答」')
      assert.equal(step.pressed2, 2, '多选要能同时选中两项')
      assert.equal(step.count2, '2 / 2 题已回答')
      assert.equal(step.afterTwo, false)
    })

    await test('页面：会话视图的问答条也能回答（同一份卡片结构）', async () => {
      const got = await evalJs(`(function(){
        S.sessionId = 'session-demo-a'; S.rootId = 'session-demo-a'; S.agentView = false;
        setView('session');
        renderSessionAsk();
        var box = document.getElementById('askBar');
        return {hidden:box.hidden, cards:box.querySelectorAll('.q-card').length};
      })()`)
      assert.equal(got.hidden, true, '演示会话是 session-demo-a，session-demo-b 的提问不该出现在 A 的问答条里')
      const got2 = await evalJs(`(function(){
        S.sessionId = 'session-demo-b'; S.rootId = 'session-demo-b';
        renderSessionAsk();
        var box = document.getElementById('askBar');
        var card = box.querySelector('.q-card');
        return {hidden:box.hidden, cards:box.querySelectorAll('.q-card').length,
          hasSubmit:!!(card && card.querySelector('[data-qsubmit]')),
          hasOptions:!!(card && card.querySelectorAll('.q-opt').length)};
      })()`)
      assert.equal(got2.hidden, false)
      assert.equal(got2.cards, 1)
      assert.equal(got2.hasSubmit, true)
      assert.equal(got2.hasOptions, true)
    })

    cdp.close()
    await browser.send('Target.closeTarget', { targetId }).catch(() => {})
    browser.close()
  }
} catch (e) {
  console.error('\n页面自检执行失败：' + (e && e.stack || e))
  failures++
} finally {
  try { if (browserChild) browserChild.kill() } catch { /* 已退出 */ }
  try { if (demoServer) demoServer.close() } catch { /* 已关闭 */ }
  try { if (browserProfile) rmSync(browserProfile, { recursive: true, force: true }) } catch { /* 占用就下次删 */ }
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 旧 Node */ }
  await new Promise((resolve) => server.close(resolve))
  try { rmSync(home, { recursive: true, force: true }) } catch { /* Windows 上偶尔占用 */ }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
