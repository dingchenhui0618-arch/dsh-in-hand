/**
 * 简洁模式（v1.10.0）的行为自检。
 *
 * 断言的是**真的收起了**，不是加了个类名：
 *   · 默认不是简洁（升级不替用户改界面）：指标行与附件/相机键都在；
 *   · 打开后指标行不占位、两个键不显示、「+」出现；
 *   · 「+」里三项都在（拍照 / 选图片 / 导入文件）—— 收起按钮不等于砍功能；
 *   · 偏好写进 localStorage，刷新后仍然生效；
 *   · 360 宽下不出现横向滚动。
 *
 * 服务端只回虚构数据；不读任何本机文件。
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
  console.log('SKIP 简洁模式自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
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
const SID = 'session-simple-check'
const FIXTURE = {
  generatedAt: BASE, offline: false, errors: [],
  totals: { sessions: 2, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
  today: { since: BASE - 3600_000, turns: 1, steps: 2, sessions: 2, partial: false },
  pending: [],
  sessions: [{
    id: SID, title: '简洁模式自检', running: false, activeJobs: 0, live: true,
    origin: 'root', depth: 0, cwd: '~/projects/simple-check',
    updatedAt: BASE - 1000, lastActivity: BASE - 1000, lastTool: '', turnStartedAt: 0, stepsInTurn: 0, goal: null,
  }],
  jobs: [], subagents: [], workflows: [],
}
function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

let server = null, child = null, profile = ''
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
    // 空队列：简洁模式下这一行不许占位。
    if (path === '/taskwatch/chat/queue') { sendJson(res, { items: [], steering: [], running: true }); return }
    if (path === '/taskwatch/chat/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
      res.write('data: ' + JSON.stringify({
        type: 'snapshot', cursor: 1,
        records: [{ type: 'event', event: { type: 'assistant/message', seq: 1, time: Date.now(), data: {
          message: { content: [{ type: 'text', text: '简洁模式自检的对话内容。' }] } } } }],
      }) + '\n\n')
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

  profile = mkdtempSync(join(tmpdir(), 'tw-simple-chrome-'))
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
  const load = async (target) => {
    await cdp.send('Page.navigate', { url: target })
    await sleep(900)
  }
  const disp = (sel) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display`

  console.log('\n[1] 默认不是简洁：指标行与两个键都在')
  await load(url)
  await waitFor('document.body.innerText.indexOf("简洁模式自检的对话内容") >= 0', 8000, '会话内容渲染')
  check('默认没有 simple 类', await evalJs('document.documentElement.classList.contains("simple")') === false)
  check('指标行显示', await evalJs(disp('#stats')) !== 'none')
  check('附件键显示', await evalJs(disp('#attach')) !== 'none')
  check('相机键显示', await evalJs(disp('#camera')) !== 'none')
  check('「+」默认不出现', await evalJs(disp('#composeMore')) === 'none')

  console.log('\n[2] 打开简洁：指标行让位、三个键收成一个「+」')
  await evalJs('applySimple(true, true); true')
  await sleep(300)
  check('simple 类已挂上', await evalJs('document.documentElement.classList.contains("simple")') === true)
  check('指标行不显示', await evalJs(disp('#stats')) === 'none', await evalJs(disp('#stats')))
  check('指标明细不显示', await evalJs(disp('#statsDetail')) === 'none')
  check('附件键不显示', await evalJs(disp('#attach')) === 'none')
  check('相机键不显示', await evalJs(disp('#camera')) === 'none')
  check('「+」显示出来', await evalJs(disp('#composeMore')) !== 'none')
  check('空队列不占一行', await evalJs(disp('#queueBar')) === 'none', await evalJs(disp('#queueBar')))
  const rows = await evalJs('document.getElementById("composeMore").getBoundingClientRect().height')
  check('「+」命中区 ≥44px', rows >= 44, String(rows))
  check('偏好写进 localStorage', await evalJs('localStorage.getItem("tw-simple")') === '1')

  console.log('\n[3] 「+」里三项都在')
  await evalJs('document.getElementById("composeMore").click(); true')
  await sleep(300)
  const menu = await evalJs('Array.prototype.map.call(document.querySelectorAll(".cm-row .lbl"), function(n){return n.textContent}).join("/")')
  check('菜单是 拍照/选图片/导入文件', menu === '拍照/选图片/导入文件', String(menu))
  await evalJs('closeSheet(); true')

  console.log('\n[4] 刷新之后仍然是简洁的')
  await cdp.send('Page.reload', { ignoreCache: true })
  await sleep(1200)
  check('刷新后 simple 类仍在', await evalJs('document.documentElement.classList.contains("simple")') === true)
  check('刷新后指标行仍不显示', await evalJs(disp('#stats')) === 'none')

  console.log('\n[5] 360 宽不出现横向滚动')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true })
  await sleep(500)
  const over = await evalJs('document.documentElement.scrollWidth - document.documentElement.clientWidth')
  check('文档宽度没有溢出', over <= 0, '溢出 ' + over + 'px')

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
