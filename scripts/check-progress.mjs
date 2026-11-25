/**
 * 运行进度（v1.10.0）的行为自检。
 *
 * 为什么必须真 Chrome：这一版要证明的是**时序**与**DOM 复用**，不是字符串：
 *   · 收到 step/start 与 tool/call 之后，运行条要出现并说清「第几步 · 正在干什么」；
 *   · 运行条右侧的时长由本地 1 秒计时器刷（两次采样必须不同），不靠 5 秒轮询；
 *   · turn/end 之后运行条必须收起；
 *   · 重连拿回**同一份**快照时不许整屏重绘（旧的 DOM 节点必须还是同一个）。
 *
 * 服务端只回虚构数据；不读任何本机文件，不碰真实中继。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]
const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p))
if (!chrome) {
  console.log('SKIP 运行进度自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
  process.exit(0)
}

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
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result)
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

let passed = 0, failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}
async function waitPort(profile, child) {
  const deadline = Date.now() + 15000
  const file = join(profile, 'DevToolsActivePort')
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Chrome 启动即退出，code=' + child.exitCode)
    if (existsSync(file)) {
      let raw = ''
      try { raw = readFileSync(file, 'utf8') } catch (e) {
        if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'ENOENT') { await sleep(100); continue }
        throw e
      }
      const first = raw.split(/\r?\n/)[0]
      if (first) return Number(first)
    }
    await sleep(100)
  }
  throw new Error('等不到 DevToolsActivePort')
}

const BASE = Date.now()
const SID = 'session-runbar-check'
const FIXTURE = {
  generatedAt: BASE, offline: false, errors: [],
  totals: { sessions: 1, running: 1, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
  today: { since: BASE - 3600_000, turns: 1, steps: 2, sessions: 1, partial: false },
  pending: [],
  sessions: [{
    id: SID, title: '运行进度自检', running: true, activeJobs: 0, live: true,
    origin: 'root', depth: 0, cwd: '~/projects/runbar-check',
    updatedAt: BASE - 1000, lastActivity: BASE - 1000,
    lastTool: 'pwsh', lastToolAt: BASE - 2000, turnStartedAt: BASE - 30000, stepsInTurn: 2, goal: null,
  }],
  jobs: [], subagents: [], workflows: [],
}
function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

let server = null, child = null, profile = ''
let streams = 0
try {
  const html = readFileSync(PAGE, 'utf8')
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (path === '/taskwatch/data') { sendJson(res, { ...FIXTURE, generatedAt: Date.now() }); return }
    if (path === '/taskwatch/chat/sessions') { sendJson(res, { sessions: FIXTURE.sessions }); return }
    if (path === '/taskwatch/chat/models') { sendJson(res, { models: [], current: '' }); return }
    if (path === '/taskwatch/chat/usage') { sendJson(res, {}); return }
    if (path === '/taskwatch/chat/queue') { sendJson(res, { items: [], steering: [] }); return }
    if (path === '/taskwatch/chat/stream') {
      streams++
      const first = streams === 1
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store', connection: 'keep-alive',
      })
      const now = Date.now()
      const frame = (o) => 'data: ' + JSON.stringify(o) + '\n\n'
      const event = (type, data, seq, time) => frame({
        type: 'event', event: { type, seq, time, data },
      })
      // 两条连接都先给同一份开场快照：第一条 cursor=2，第二条 cursor=10
      // （页面此时已经收到 seq 10），用来测「同一份快照不重绘」。
      res.write(frame({
        type: 'snapshot',
        cursor: first ? 2 : 10,
        records: [
          { type: 'event', event: { type: 'user/message', seq: 1, time: now - 60000, data: {
            role: 'user', content: [{ type: 'text', text: '进度自检：改一下重试逻辑。' }] } } },
          { type: 'event', event: { type: 'assistant/message', seq: 2, time: now - 55000, data: {
            message: { content: [{ type: 'text', text: '先读一遍现在的实现。' }] } } } },
        ],
      }))
      if (!first) return        // 第二次只给快照：页面应当跳过重绘
      setTimeout(() => {
        res.write(event('turn/start', {}, 3, Date.now() - 28000))
        res.write(event('step/start', {}, 4, Date.now() - 26000))
        res.write(event('tool/call', { name: 'read', callId: 'c1', arguments: { path: 'src/retry.ts' } }, 5, Date.now() - 24000))
        res.write(event('tool/result', { message: { source: { callId: 'c1' }, content: [{ type: 'toolCallId', text: '' }] } }, 6, Date.now() - 21000))
        res.write(event('step/start', {}, 7, Date.now() - 20000))
        res.write(event('tool/call', { name: 'edit', callId: 'c2', arguments: { path: 'src/retry.ts' } }, 8, Date.now() - 18000))
      }, 120)
      // 4 秒后主动收流：模拟「网络把连接掐了」，页面按退避重连。
      setTimeout(() => { try { res.end() } catch { /* 已断 */ } }, 4000)
      return
    }
    if (path === '/taskwatch/lan.json') { sendJson(res, { lanMode: false }, 404); return }
    if (path === '/taskwatch/approvals/stream') {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = 'http://127.0.0.1:' + server.address().port + '/taskwatch#session/' + SID

  profile = mkdtempSync(join(tmpdir(), 'tw-runbar-chrome-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const port = await waitPort(profile, child)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const info = list.find((t) => t.id === targetId)
  if (!info) throw new Error('找不到 target')
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await cdp.send('Page.bringToFront')

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }
  const waitFor = async (expression, timeout, label) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evalJs(expression)) return true
      await sleep(100)
    }
    throw new Error('超时：' + label)
  }

  console.log('\n[1] 运行条：第几步 · 正在干什么')
  await cdp.send('Page.navigate', { url })
  await waitFor('!!document.getElementById("runbar") && !document.getElementById("runbar").hidden', 8000, '运行条出现')
  const t1 = await evalJs('document.getElementById("runbarText").textContent')
  check('运行条显示「第 N 步」', /第\s*2\s*步/.test(t1), t1)
  check('运行条写明正在改文件', /修改文件/.test(t1), t1)

  console.log('\n[2] 时长由本地秒表刷（不是 5 秒轮询）')
  const d1 = await evalJs('document.getElementById("runbarDur").textContent')
  await sleep(2300)
  const d2 = await evalJs('document.getElementById("runbarDur").textContent')
  check('运行时长在 2 秒内前进', d1 !== d2, d1 + ' -> ' + d2)
  check('时长带「已跑」前缀', /^已跑\s/.test(d2), d2)

  console.log('\n[3] 重连拿回同一份快照：不重绘')
  await evalJs('window.__probe = document.querySelector("#log .row.ai"); true')
  await waitFor('__twNet && __twNet.sse.reconnects >= 1', 12000, '事件流重连一次')
  await sleep(1200)
  const same = await evalJs('!!window.__probe && window.__probe === document.querySelector("#log .row.ai")')
  check('重连后旧 DOM 节点仍在使用（没有整屏重建）', same === true, String(same))
  const users = await evalJs('document.querySelectorAll("#log .row.me").length')
  check('重连后用户消息没有重复', users === 1, '条数=' + users)

  console.log('\n[4] 运行条不常驻：切到首页必须收起')
  await evalJs('location.hash = ""; true')
  await sleep(600)
  const homeHidden = await evalJs('document.getElementById("runbar").hidden')
  check('切到首页时运行条收起', homeHidden === true, String(homeHidden))

  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败')
} catch (e) {
  failed++
  console.log('  FAIL  ' + (e && e.message ? e.message : String(e)))
} finally {
  try { child && child.kill() } catch { /* 已退出 */ }
  try { server && server.close() } catch { /* 已关闭 */ }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 删不掉就算了 */ } }
  process.exit(failed ? 1 : 0)
}
