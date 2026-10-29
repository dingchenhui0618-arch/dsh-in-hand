#!/usr/bin/env node
/**
 * 双入口路由契约测试（GET /taskwatch/entries、POST /taskwatch/ticket）。
 *
 * 走真实的 node:http 服务与真实路由处理函数，只把 DSH 服务换成假实现 ——
 * 不联网、不碰真实会话、不写任何文件。
 *
 * 为什么要有这份测试：v1.7.0 的真实故障是「页面点去远端就一直报错」，根因就是这两条
 * 路由**只有中继实现**、宿主没有。所以这里钉住的正是当时缺的那几条：
 *   - 入口清单的两种形态：配了 publicUrl（远端 + 局域网）/ 没配（只有局域网）
 *   - ticket 的 60 秒、一次性、用后即焚（重放无效）
 *   - 没配 publicUrl 时明确的 409 no-public-entry，而不是 500 或空 url
 *   - 写路由的门禁：POST + application/json + 同源（跨站表单打不进来）
 *   - 兑换路径：命中 302 + Set-Cookie，未知/过期 401（与中继一致）
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  apply, createTicketStore, lanAddresses, name, normalizePublicUrl, TICKET_TTL_MS,
} from '../lib/index.js'
import { TICKET_V2_SUNSET_AT, createTicketGate } from '../lib/ticket.js'
import { readDevToolsPort } from './devtools-port.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(ROOT, 'docs', 'demo.html')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 用环境变量固定密钥：测试既不读写真实 ~/.dsh，也让每个实例签出同一套票。
process.env.TASKWATCH_TICKET_SECRET = 'check-entries-' + 'k'.repeat(40)

// ── 纯函数：公网地址归一化 ─────────────────────────────────────────────────
assert.equal(normalizePublicUrl('https://dsh.example.com'), 'https://dsh.example.com')
assert.equal(normalizePublicUrl('  https://dsh.example.com/  '), 'https://dsh.example.com')
assert.equal(normalizePublicUrl('http://192.168.1.5:52676'), 'http://192.168.1.5:52676')
// 子路径与非常规协议一律当作没配：302 的 Location 是根绝对路径，带前缀会跳错地方。
assert.equal(normalizePublicUrl('https://dsh.example.com/dsh'), '')
assert.equal(normalizePublicUrl('javascript:alert(1)'), '')
assert.equal(normalizePublicUrl('not a url'), '')
assert.equal(normalizePublicUrl(''), '')
assert.equal(normalizePublicUrl(undefined), '')

// ── 纯函数：票据存储的过期语义 ─────────────────────────────────────────────
{
  let clock = 1000
  const store = createTicketStore({ ttlMs: 60 * 1000, now: () => clock })
  const ticket = store.mint()
  assert.ok(ticket.length >= 16)
  assert.equal(store.size, 1)
  clock += 1000
  assert.equal(store.redeem(ticket), true, '60 秒内应可用')
  assert.equal(store.size, 0, '兑换后立刻删除')
  assert.equal(store.redeem(ticket), false, '同一张票据不能重放')

  const stale = store.mint()
  clock += 60 * 1000 + 1
  assert.equal(store.redeem(stale), false, '过期票据无效')
  assert.equal(store.size, 0, '过期票据同样被删掉，不会堆在内存里')
}
assert.equal(TICKET_TTL_MS, 60 * 1000, '票据有效期必须是 60 秒')

// ── 真实 HTTP：每个实例一套假 webServer ────────────────────────────────────
function makeInstance(config) {
  const routes = new Map()
  const services = {
    webServer: { register(spec) { routes.set(spec.path, spec.handler) } },
  }
  const ctx = {
    get(name) { return services[name] },
    effect(fn) { return fn() },
    on() { return () => {} },
  }
  apply(ctx, config)
  return routes
}

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!handler) { res.writeHead(404); res.end('not found'); return }
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function raw(base, path, init = {}) {
  // redirect:'manual'：302 兑换路径必须看到**原样的 302**，不能被 fetch 自动跟走。
  const response = await fetch(base + path, { redirect: 'manual', ...init })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { status: response.status, headers: response.headers, text, body }
}

const PORT = (base) => Number(/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(base)[1])
const postJson = (base, path, value, headers = {}) => raw(base, path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(value),
})

// ══════════════════════════════════════════════════════════════════════════
// 实例 A：没配 publicUrl → 只报局域网，远端请求 409 no-public-entry
// ══════════════════════════════════════════════════════════════════════════
{
  const { server, base } = await serve(makeInstance({}))
  const lan = lanAddresses()

  let got = await raw(base, '/taskwatch/entries')
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.remote, '', '没配 publicUrl 时 remote 必须为空')
  assert.equal(got.body.current, 'lan')
  assert.ok(Array.isArray(got.body.entries))
  assert.equal(got.body.entries.length, lan.length, '入口数应等于局域网地址数')
  assert.ok(got.body.entries.every((e) => e.kind === 'lan'), '不应凭空多出远端入口')
  for (const e of got.body.entries) {
    assert.equal(typeof e.label, 'string')
    assert.match(e.url, new RegExp('^http://[0-9.]+:' + PORT(base) + '/taskwatch$'))
    assert.equal(typeof e.current, 'boolean')
  }
  // 每条地址都能在 lanAddresses() 里找到，且顺序一致。
  assert.deepEqual(got.body.entries.map((e) => e.url), lan.map(
    (a) => 'http://' + a.ip + ':' + PORT(base) + '/taskwatch'))
  assert.equal(got.body.entries.filter((e) => e.current).length, lan.length ? 1 : 0)

  got = await postJson(base, '/taskwatch/ticket', { to: 'remote' })
  assert.equal(got.status, 409)
  assert.equal(got.body.ok, false)
  assert.equal(got.body.code, 'no-public-entry')
  assert.match(got.body.error, /publicUrl/, '错误里要说清该配什么')

  // 用一个"刚生成的"票据去兑换也必须是 401：远端票据根本没签发。
  got = await raw(base, '/taskwatch?t=fake-ticket')
  assert.equal(got.status, 401)
  assert.match(got.text, /换路凭据无效或已过期/)

  server.close()
}

// ══════════════════════════════════════════════════════════════════════════
// 实例 B：配了 publicUrl → 远端 + 局域网，票据 60 秒一次性
// ══════════════════════════════════════════════════════════════════════════
{
  const PUBLIC = 'https://dsh.example.com'
  const { server, base } = await serve(makeInstance({ publicUrl: PUBLIC + '/' }))
  const lan = lanAddresses()
  const port = PORT(base)

  let got = await raw(base, '/taskwatch/entries')
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.remote, PUBLIC, '尾部斜杠要被归一化掉')
  assert.equal(got.body.current, 'lan', '从回环 / 局域网访问时当前路径是局域网')
  assert.equal(got.body.entries[0].kind, 'remote')
  assert.equal(got.body.entries[0].url, PUBLIC + '/taskwatch')
  assert.equal(got.body.entries[0].current, false)
  assert.equal(got.body.entries.length, 1 + lan.length)
  assert.deepEqual(got.body.lan, lan.map((a) => 'http://' + a.ip + ':' + port + '/taskwatch'))
  assert.equal(got.body.entries.filter((e) => e.current).length, lan.length ? 1 : 0)

  // 方法 / content-type 门禁：和宿主其它写路由同一套。
  got = await raw(base, '/taskwatch/ticket')
  assert.equal(got.status, 405)
  assert.equal(got.headers.get('allow'), 'POST')
  got = await raw(base, '/taskwatch/entries', { method: 'POST' })
  assert.equal(got.status, 405)
  got = await raw(base, '/taskwatch/ticket', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
  })
  assert.equal(got.status, 415)

  // 跨站门禁：显式 cross-site、以及 Origin 与 Host 不同源，都必须 403。
  got = await postJson(base, '/taskwatch/ticket', { to: 'remote' }, { origin: 'https://evil.example' })
  assert.equal(got.status, 403)
  assert.equal(got.body.code, 'cross-site')
  got = await postJson(base, '/taskwatch/ticket', { to: 'remote' }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(got.status, 403)
  // 同源（页面自己 fetch）必须放行。
  got = await postJson(base, '/taskwatch/ticket', { to: 'remote' }, { origin: base })
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.to, 'remote')
  assert.equal(got.body.expiresInMs, TICKET_TTL_MS)
  // publicUrl 指向一个不存在的中继：v3 探测必然失败 → 回退 v2（"旧中继 + 新插件"的默认档位）。
  assert.match(got.body.url, new RegExp('^' + PUBLIC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '/taskwatch\\?t=v2\\.\\d{13}\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{20,}$'))
  const remoteTicket = got.body.url.split('?t=')[1]

  // 兑换/重放用"局域网直连"票：宿主只认 aud=lan，用同一密钥签一张即可（跨实例同密钥契约）。
  const lanTicket = createTicketGate({ secret: process.env.TASKWATCH_TICKET_SECRET, aud: 'lan' }).mint()
  assert.match(lanTicket, /^v3\.\d{13}\.[A-Za-z0-9_-]{16,}\.lan\.[A-Za-z0-9_-]{20,}$/)
  let redeemed = await raw(base, '/taskwatch?t=' + lanTicket)
  assert.equal(redeemed.status, 302)
  assert.equal(redeemed.headers.get('location'), '/taskwatch')
  assert.match(String(redeemed.headers.get('set-cookie')), /tw-route=remote/)
  assert.equal(redeemed.headers.get('cache-control'), 'no-store')
  // 一次性：重放立刻 401。
  redeemed = await raw(base, '/taskwatch?t=' + lanTicket)
  assert.equal(redeemed.status, 401)
  // 未知票据同样 401。
  redeemed = await raw(base, '/taskwatch?t=nope')
  assert.equal(redeemed.status, 401)
  // v2 过渡票（没有受众）在过渡期内仍能在宿主兑换 —— 升级不该把旧票/旧中继挡在门外。
  // 过渡期结束后这条会变成 401，那正是 TICKET_V2_SUNSET_AT 的语义。
  if (Date.now() < TICKET_V2_SUNSET_AT) {
    assert.equal((await raw(base, '/taskwatch?t=' + remoteTicket)).status, 302, '过渡期内 v2 仍可用')
  }

  // 没有 t 时仍然是正常页面（不是 302，也不是 401）。
  got = await raw(base, '/taskwatch')
  assert.equal(got.status, 200)
  assert.match(got.text, /<title>掌上 DSH<\/title>/)

  // 局域网票据：URL 用请求的端口（不写死 52676），兑换同样可用。
  got = await postJson(base, '/taskwatch/ticket', { to: 'lan' })
  if (lan.length) {
    assert.equal(got.status, 200)
    assert.equal(got.body.to, 'lan')
    assert.match(got.body.url, new RegExp('^http://[0-9.]+:' + port + '/taskwatch\\?t='))
    const lanTicket = got.body.url.split('?t=')[1]
    const hop = await raw(base, '/taskwatch?t=' + lanTicket)
    assert.equal(hop.status, 302)
  } else {
    assert.equal(got.status, 409)
    assert.equal(got.body.code, 'no-lan-entry')
  }

  // 空 body / 未知 to 走默认的局域网，不会误签发远端票据。
  got = await postJson(base, '/taskwatch/ticket', {})
  assert.equal(got.body.to, lan.length ? 'lan' : got.body.to)

  // v3 票据只靠签名 + 受众 + 时效，不再依赖签发进程的 Map：同一密钥签出的 lan 票在另一个
  // 实例也能兑换 —— 这正是"宿主签的票到公网（中继）也认"的契约（受众必须匹配校验方）。
  const other = createTicketGate({ secret: process.env.TASKWATCH_TICKET_SECRET, aud: 'lan' })
  got = await raw(base, '/taskwatch?t=' + other.mint())
  assert.equal(got.status, 302, '同一密钥签出的 v3 lan 票应跨实例兑换')
  // 老格式随机票仍只走本进程 Map；宿主内部 Map 里没有它，所以必须是 401。
  const legacy = createTicketStore()
  got = await raw(base, '/taskwatch?t=' + legacy.mint())
  assert.equal(got.status, 401, '老格式随机票不能靠"形状像"被放行')

  server.close()
}

// ══════════════════════════════════════════════════════════════════════════
// 实例 C：环境变量兜底（配置项仍然优先）
// ══════════════════════════════════════════════════════════════════════════
{
  process.env.DSH_TASKWATCH_PUBLIC_URL = 'https://env.example'
  const { server, base } = await serve(makeInstance({}))
  const got = await raw(base, '/taskwatch/entries')
  assert.equal(got.body.remote, 'https://env.example')
  delete process.env.DSH_TASKWATCH_PUBLIC_URL
  server.close()
}

// ══════════════════════════════════════════════════════════════════════════
// 实例 D：配了 lanUrl → 局域网条目换成它（典型是指向中继的局域网入口）
// ══════════════════════════════════════════════════════════════════════════
{
  const LAN = 'http://192.168.1.23:3099'
  const { server, base } = await serve(makeInstance({ lanUrl: LAN + '/' }))
  let got = await raw(base, '/taskwatch/entries')
  assert.equal(got.status, 200)
  assert.deepEqual(got.body.lan, [LAN + '/taskwatch'], '配了 lanUrl 就不再自动探测内网 IP')
  const lanEntry = got.body.entries.find((e) => e.kind === 'lan')
  assert.equal(lanEntry.url, LAN + '/taskwatch')
  assert.equal(lanEntry.label, '局域网 · 中继')
  assert.equal(lanEntry.current, true)

  got = await postJson(base, '/taskwatch/ticket', { to: 'lan' })
  assert.equal(got.status, 200)
  assert.equal(got.body.to, 'lan')
  assert.match(got.body.url, new RegExp('^' + LAN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '/taskwatch\\?t=v[23]\\.\\d{13}\\.'))
  // lanUrl 指到中继（192.168.1.23:3099 不是本机）→ 受众按"谁兑现"算是 remote：
  //   · 中继声明 v3 → v3 + aud=remote，宿主必须 401（跨入口重放）；
  //   · 探测失败/旧中继 → v2（没有受众），过渡期内宿主仍认。
  const lanTicket = got.body.url.split('?t=')[1]
  if (lanTicket.startsWith('v3.')) {
    assert.match(lanTicket, /\.remote\.[A-Za-z0-9_-]{20,}$/)
    assert.equal((await raw(base, '/taskwatch?t=' + lanTicket)).status, 401, 'aud=remote 的票不能在宿主兑现')
  } else if (Date.now() < TICKET_V2_SUNSET_AT) {
    assert.equal((await raw(base, '/taskwatch?t=' + lanTicket)).status, 302, '过渡期内 v2 仍可用')
  }
  server.close()
}

assert.equal(name, 'dsh-in-hand')
console.log('entries / ticket route checks passed')

// ══════════════════════════════════════════════════════════════════════════
// P3 客户端入口切换器（v1.8.12）：真 Chrome + CDP
//
// 上面这一段验的是**宿主**的入口清单与换路票据；这一段验的是**页面自己**：
// 切到 #entries 之后，地址清单能不能被正确地生成、规范化、去重、限流、存盘。
//
// 七组断言（与交付说明一一对应）：
//   1. 首次进入自动生成「本机」，URL = 当前 origin；
//   2. 尾斜杠 / 查询串 / 大小写被规范化，同一 origin 的另一种写法不产生重复；
//   3. javascript: / data: / file: 全部被拒，且有可见错误文案；
//   4. 第 9 条被上限挡住（8 条），提示里写清上限；
//   5. localStorage 里每条只有 label / url，整份存储没有 token / cookie / k= 痕迹；
//   6. 删除一条后列表与存储同步；编辑名称生效并写回；
//   7. 390 宽无横向溢出、可点元素 ≥44px、长地址只截断不撑破。
//
// 本机没有 Chrome 就 SKIP（与 check-parallel 一致），不联网，临时 profile 用完即删。
// ══════════════════════════════════════════════════════════════════════════
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]
const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p))

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
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    })
  }
  close() { try { this.ws.close() } catch (e) {} }
}

let passed = 0, failed = 0
function check(label, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + label) }
  else { failed++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')) }
}

async function waitPort(profile, child) {
  const deadline = Date.now() + 15000
  const file = join(profile, 'DevToolsActivePort')
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Chrome 启动即退出，code=' + child.exitCode)
    const port = readDevToolsPort(file)
    if (port) return Number(port)
    await sleep(100)
  }
  throw new Error('等不到 DevToolsActivePort')
}

async function openPage(browser, url, width, height) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()
  const info = list.find((t) => t.id === targetId)
  if (!info) throw new Error('找不到 target')
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile: true })
  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }
  let caseNo = 0
  const load = async (hash = '') => {
    caseNo++
    await cdp.send('Page.navigate', { url: url + '?case=' + caseNo + hash })
    await sleep(1700)
  }
  return {
    cdp, eval: evalJs, load,
    close: async () => { try { await browser.send('Target.closeTarget', { targetId }) } catch (e) {} cdp.close() },
  }
}

async function runEntriesUi() {
  let server = null, child = null, profile = ''
  try {
    const html = readFileSync(DEMO, 'utf8')
    server = http.createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname
      if (path === '/taskwatch' || path === '/taskwatch/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }
      res.writeHead(404); res.end('not found')
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const url = 'http://127.0.0.1:' + server.address().port + '/taskwatch'

    profile = mkdtempSync(join(tmpdir(), 'tw-entries-chrome-'))
    child = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
      '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    const port = await waitPort(profile, child)
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const browser = await Cdp.connect(version.webSocketDebuggerUrl)
    browser.port = port

    console.log('\n[390] 入口切换器：默认项 / 规范化 / 拒绝 / 上限 / 存储 / 增删改 / 布局')
    const p = await openPage(browser, url, 390, 844)
    try {
      const read = () => p.eval(`(function(){
        var items = []
        try { items = JSON.parse(localStorage.getItem('tw:entries') || '[]') } catch (e) {}
        var rows = [].slice.call(document.querySelectorAll('#entList .entrow')).map(function(r){
          var open = r.querySelector('a.ent-btn.open')
          var urlEl = r.querySelector('.ent-url')
          return {
            url: r.getAttribute('data-url'),
            label: (r.querySelector('.n') || {}).textContent || '',
            current: r.classList.contains('cur'),
            tag: (r.querySelector('.ent-tag') || {}).textContent || '',
            open: !!open,
            rel: open ? open.getAttribute('rel') : '',
            refpol: open ? open.getAttribute('referrerpolicy') : '',
            urlText: urlEl ? urlEl.textContent.trim() : ''
          }
        })
        var err = document.getElementById('entError')
        return {
          items: items,
          rows: rows,
          error: err ? err.textContent.trim() : '',
          errorH: err ? Math.round(err.getBoundingClientRect().height) : 0,
          limit: document.getElementById('entLimit').textContent.trim(),
          now: document.getElementById('entNow').textContent.trim()
        }
      })()`)
      const add = (label, value) => p.eval(`(function(){
        var f = document.getElementById('entForm')
        document.getElementById('entLabel').value = ${JSON.stringify(label)}
        document.getElementById('entUrl').value = ${JSON.stringify(value)}
        if (f.requestSubmit) f.requestSubmit()
        else document.getElementById('entAdd').click()
        return true
      })()`)

      await p.load('#entries')
      const shown = await p.eval(`(function(){
        return !document.getElementById('entriesView').hidden &&
          document.getElementById('entriesView').getBoundingClientRect().height > 0
      })()`)
      const first = await read()
      const origin = await p.eval('location.origin')
      check('#entries 打开整屏入口页', shown === true)
      check('首次进入自动生成「本机」，URL = 当前 origin',
        first.items.length === 1 && first.items[0].label === '本机' &&
        first.items[0].url === origin && first.rows.length === 1 &&
        first.rows[0].url === origin && first.rows[0].urlText === origin,
        JSON.stringify({ items: first.items, origin, rows: first.rows }))
      check('当前项标「当前」并用细线高亮（不是实心强调块）',
        first.rows[0] && first.rows[0].current === true && first.rows[0].tag === '当前' &&
        /当前：本机/.test(first.now) && first.rows[0].open === false &&
        /inset/.test(await p.eval("getComputedStyle(document.querySelector('#entList .entrow.cur')).boxShadow")),
        JSON.stringify({ row: first.rows[0], now: first.now }))

      // ── 2：规范化与去重 ────────────────────────────────────────────────
      await add('家里', 'http://192.168.1.50:3099/')
      let s = await read()
      check('尾斜杠被规范化掉（http://192.168.1.50:3099/ → 无斜杠）',
        s.items.length === 2 && s.items[1].url === 'http://192.168.1.50:3099' &&
        s.rows[1].url === 'http://192.168.1.50:3099',
        JSON.stringify(s.items))
      check('「打开」是新页面跳转，带 rel=noopener noreferrer（且不泄露 referrer）',
        s.rows[1].open === true && s.rows[1].rel === 'noopener noreferrer' &&
        s.rows[1].refpol === 'no-referrer',
        JSON.stringify({ open: s.rows[1].open, rel: s.rows[1].rel, refpol: s.rows[1].refpol }))
      await add('重复写法', 'HTTP://192.168.1.50:3099/?from=test#x')
      s = await read()
      check('同一 origin 的另一种写法（大写 + 尾斜杠 + ? / #）不产生重复',
        s.items.length === 2 && /已经在列表里/.test(s.error) && s.rows.length === 2,
        JSON.stringify({ n: s.items.length, error: s.error }))

      // ── 3：非 http(s) 全部被拒 ─────────────────────────────────────────
      const bads = []
      for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///c:/x']) {
        await add('坏地址', bad)
        const now = await read()
        bads.push({ bad, count: now.items.length, error: now.error, errorH: now.errorH })
      }
      check('javascript: / data: / file: 全部被拒，且有可见错误文案',
        bads.every((b) => b.count === 2 && /http \/ https/.test(b.error) && b.errorH > 0),
        JSON.stringify(bads))

      // ── 4：上限 8 ──────────────────────────────────────────────────────
      // 其中一条故意用超长主机名：第 7 组要证明长地址只在本行截断、不把行撑破。
      for (let i = 51; i <= 55; i++) await add('机器 ' + i, 'http://192.168.1.' + i + ':3099')
      await add('楼上 NAS', 'http://upstairs-office-nas-with-a-very-long-hostname.local:3099')
      s = await read()
      check('第 8 条可以添加（8 条时列表满、提示上限）',
        s.items.length === 8 && !s.error && /上限/.test(s.limit) && /8/.test(s.limit),
        JSON.stringify({ n: s.items.length, error: s.error, limit: s.limit }))
      const ninth = await (async () => {
        await add('第九台', 'http://192.168.1.57:3099')
        return read()
      })()
      check('添加第 9 条被挡下，并提示已达上限（8）',
        ninth.items.length === 8 && /上限/.test(ninth.error) && /8/.test(ninth.error),
        JSON.stringify({ n: ninth.items.length, error: ninth.error }))

      // ── 5：只存 label 与 url，整份存储无令牌痕迹 ───────────────────────
      const store = await p.eval(`(function(){
        var items = []
        try { items = JSON.parse(localStorage.getItem('tw:entries') || '[]') } catch (e) {}
        var keys = []
        for (var i = 0; i < items.length; i++) {
          var ks = Object.keys(items[i] || {}).sort()
          for (var j = 0; j < ks.length; j++) if (keys.indexOf(ks[j]) < 0) keys.push(ks[j])
        }
        keys.sort()
        var dump = ''
        for (var k = 0; k < localStorage.length; k++) {
          var key = localStorage.key(k)
          dump += key + '=' + localStorage.getItem(key) + '\\n'
        }
        var extra = items.filter(function (it) {
          return Object.keys(it || {}).length !== 2 || !('label' in it) || !('url' in it)
        })
        return { count: items.length, keys: keys, extra: extra.length, dump: dump }
      })()`)
      check('localStorage 的每一条只有 label 与 url 两个键（共 8 条）',
        store.count === 8 && JSON.stringify(store.keys) === JSON.stringify(['label', 'url']) &&
        store.extra === 0,
        JSON.stringify({ count: store.count, keys: store.keys, extra: store.extra }))
      check('整份 localStorage 里没有 token / cookie / k= / 配对码痕迹',
        !/(token|cookie|k=|secret|paircode|pair-code)/i.test(store.dump),
        store.dump.slice(0, 400))

      // ── 6：删除与改名 ──────────────────────────────────────────────────
      const del = await p.eval(`(function(){
        var rows = [].slice.call(document.querySelectorAll('#entList .entrow'))
        var row = rows.filter(function (r) { return r.getAttribute('data-url') === 'http://192.168.1.50:3099' })[0]
        if (!row) return false
        row.querySelector('[data-ent-del]').click()
        return true
      })()`)
      s = await read()
      check('删除一条后列表与存储同步（8 → 7，且那条不在两处）',
        del === true && s.items.length === 7 && s.rows.length === 7 &&
        !s.items.some((i) => i.url === 'http://192.168.1.50:3099') &&
        !s.rows.some((r) => r.url === 'http://192.168.1.50:3099'),
        JSON.stringify({ n: s.items.length, rows: s.rows.length }))
      const edit = await p.eval(`(function(){
        var row = document.querySelector('#entList .entrow.cur')
        if (!row) return { ok: false, why: '没有当前行' }
        row.querySelector('[data-ent-edit]').click()
        var inp = document.getElementById('entEditInput')
        if (!inp) return { ok: false, why: '编辑态没有输入框' }
        inp.value = '书房'
        var save = document.querySelector('#entList .entrow.editing [data-ent-save]')
        if (save) save.click()
        var items = JSON.parse(localStorage.getItem('tw:entries') || '[]')
        var n = document.querySelector('#entList .entrow.cur .n')
        return {
          ok: true,
          label: n ? n.textContent.trim() : '',
          now: document.getElementById('entNow').textContent.trim(),
          first: items[0]
        }
      })()`)
      check('编辑名称生效，列表、标题与存储三处一致',
        edit.ok && edit.label === '书房' && edit.first && edit.first.label === '书房' &&
        /当前：书房/.test(edit.now),
        JSON.stringify(edit))

      // ── 7：390 宽布局 ──────────────────────────────────────────────────
      const geo = await p.eval(`(function(){
        var body = document.getElementById('entriesBody')
        var view = document.getElementById('entriesView')
        var rows = [].slice.call(document.querySelectorAll('#entList .entrow'))
        var targets = [].slice.call(document.querySelectorAll(
          '#entriesView .ent-btn, #entriesView .ent-add, #entriesView input'))
        var small = targets.filter(function (b) {
          var r = b.getBoundingClientRect()
          return r.height > 0 && (r.height < 43.5 || r.width < 43.5)
        }).map(function (b) {
          var r = b.getBoundingClientRect()
          return (b.className || b.id) + ':' + Math.round(r.height) + 'x' + Math.round(r.width)
        })
        var urlEl = document.querySelector('#entList .entrow .ent-url')
        var longUrl = [].slice.call(document.querySelectorAll('#entList .entrow .ent-url'))
          .filter(function (u) { return u.scrollWidth > u.clientWidth })[0]
        var row = rows[0]
        return {
          iw: innerWidth,
          doc: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          view: view.scrollWidth,
          panel: body.scrollWidth,
          rows: rows.length,
          rowH: row ? Math.round(row.getBoundingClientRect().height) : 0,
          targets: targets.length,
          small: small,
          clipped: !!longUrl,
          urlRight: urlEl ? Math.round(urlEl.getBoundingClientRect().right) : 0,
          rowRight: row ? Math.round(row.getBoundingClientRect().right) : 0
        }
      })()`)
      check('390 宽无横向溢出（页面 / 整屏 / 列表都不超过视口）',
        geo.iw === 390 && geo.doc <= 391 && geo.body <= 391 && geo.view <= 391 && geo.panel <= 391,
        JSON.stringify(geo))
      check('行高 ≥64px、可点元素（按钮 / 链接 / 输入框）全部 ≥44px',
        geo.rowH >= 64 && geo.targets >= 6 && geo.small.length === 0,
        JSON.stringify({ rowH: geo.rowH, targets: geo.targets, small: geo.small }))
      check('长地址在自己的行里截断，不撑破行（右缘不越界）',
        geo.clipped === true && geo.urlRight <= geo.rowRight + 1,
        JSON.stringify({ clipped: geo.clipped, urlRight: geo.urlRight, rowRight: geo.rowRight }))
    } finally {
      await p.close()
    }

    console.log('\n入口切换器：PASS ' + passed + ' / FAIL ' + failed)
    if (failed) process.exitCode = 1
  } finally {
    try { if (child) child.kill() } catch (e) {}
    try { if (server) server.close() } catch (e) {}
    try { if (profile) rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  }
}

if (!chrome) {
  console.log('SKIP 入口切换器自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
} else {
  try {
    await runEntriesUi()
  } catch (e) {
    console.error('\n入口切换器自检异常：' + ((e && e.stack) || e))
    process.exitCode = 1
  }
}
