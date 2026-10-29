/**
 * P4 设备页截图（v1.8.7）。
 *
 * 真 Chrome + CDP，DPR2，390×844；页面就是 lib/page.html 本身，只把宿主接口换成
 * 假数据（不发真实请求、不读本机文件）。每张图先做页面级自检（无横向溢出、
 * 行高 ≥44、确认层文案完整），再落盘到 _ui-review/round15。
 *
 * 用法：node scripts/shoot-devices.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
// 与仓库同级的评审目录（_ui-review/round15），不把本机绝对路径写进脚本。
const OUT = join(ROOT, '..', '_ui-review', 'round15')
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
  console.error('找不到 Chrome：设置 CHROME_PATH 后重试')
  process.exit(2)
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
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Chrome 启动即退出，code=' + child.exitCode)
    const file = join(profile, 'DevToolsActivePort')
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file, 'utf8').split(/\r?\n/)[0]
        if (raw) return Number(raw)
      } catch { /* EBUSY：稍后再读 */ }
    }
    await sleep(100)
  }
  throw new Error('等不到 DevToolsActivePort')
}

const NOW = Date.now()
const CURRENT = 'dev-current-aaaa'
const DEVICES = {
  ok: true,
  capacity: 50,
  idleDays: 30,
  current: CURRENT,
  devices: [
    {
      id: CURRENT, name: 'iPhone · iOS 17.1 · Safari',
      firstSeen: NOW - 9 * 86400000, lastSeen: NOW - 40 * 1000,
      via: 'lan', sessions: 3, revoked: false, current: true,
    },
    {
      id: 'dev-mac-bbbb', name: 'MacBook · macOS · Safari',
      firstSeen: NOW - 6 * 86400000, lastSeen: NOW - 2 * 3600000,
      via: 'remote', sessions: 1, revoked: false, current: false,
    },
    {
      id: 'dev-long-cccc',
      name: 'Windows · Chrome · 公司配发的 ThinkPad X1 Carbon（受策略管理，设备名称很长很长，用来验证一行省略）',
      firstSeen: NOW - 20 * 86400000, lastSeen: NOW - 3 * 86400000,
      via: 'remote', sessions: 2, revoked: false, current: false,
    },
  ],
}
const DATA = {
  generatedAt: NOW,
  offline: false,
  errors: [],
  totals: { sessions: 0, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
  today: { since: NOW - 6 * 3600_000, turns: 0, steps: 0, sessions: 0, partial: false },
  pending: [], sessions: [], jobs: [], subagents: [], workflows: [],
}

const sendJson = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

let server = null
let child = null
let profile = ''
const failures = []
function check(name, ok, detail) {
  if (ok) console.log('  PASS  ' + name)
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}

try {
  mkdirSync(OUT, { recursive: true })
  const html = readFileSync(PAGE, 'utf8')
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (path === '/taskwatch/data') { sendJson(res, DATA); return }
    if (path === '/taskwatch/chat/sessions') { sendJson(res, { sessions: [] }); return }
    if (path === '/taskwatch/chat/usage') { sendJson(res, {}); return }
    if (path === '/taskwatch/chat/titles') { sendJson(res, {}); return }
    if (path === '/taskwatch/devices') { sendJson(res, DEVICES); return }
    if (path === '/taskwatch/devices/revoke') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        let body = {}
        try { body = JSON.parse(raw) } catch { body = {} }
        const self = body.deviceId === CURRENT
        sendJson(res, { ok: true, self, revoked: body.deviceId, sessions: 1 })
      })
      return
    }
    if (path === '/taskwatch/approvals/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      res.write(': connected\n\n')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-devices-shots-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=2',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const port = await waitPort(profile, child)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const info = targets.find((t) => t.id === targetId)
  if (!info) throw new Error('找不到 target')
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

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

  async function openDevicesPage(scheme, tag) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await cdp.send('Page.navigate', { url: base + '/taskwatch?warm=' + tag })
    await sleep(500)
    await evalJs(`try { localStorage.setItem('taskwatch.theme', ${JSON.stringify(scheme)}) } catch (e) {}; 'ok'`)
    await cdp.send('Page.navigate', { url: base + '/taskwatch?shot=' + tag + '&t=' + Date.now() })
    await sleep(1200)
    await evalJs(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)}); 'ok'`)
    await evalJs(`location.hash = '#devices'; 'ok'`)
    await waitFor(`!!document.querySelector('#devicesView') && !document.getElementById('devicesView').hidden
      && document.querySelectorAll('.devrow').length >= 2`, 6000, '设备页渲染')
    await sleep(350)
  }

  async function shot(name) {
    const audit = JSON.parse(await evalJs(`JSON.stringify((function () {
      var rows = [].slice.call(document.querySelectorAll('.devrow'))
        .filter(function (r) { return r.getBoundingClientRect().height > 0 })
      var names = [].slice.call(document.querySelectorAll('.dev-nm .n'))
        .filter(function (n) { return n.getBoundingClientRect().height > 0 })
      return {
        docW: document.documentElement.scrollWidth,
        bodyW: document.body.scrollWidth,
        viewW: window.innerWidth,
        rows: rows.map(function (r) { return { h: Math.round(r.getBoundingClientRect().height),
          w: Math.round(r.getBoundingClientRect().width) } }),
        names: names.map(function (n) { return { cw: n.clientWidth, sw: n.scrollWidth } }),
        buttons: [].slice.call(document.querySelectorAll('.dev-revoke'))
          .filter(function (b) { return b.getBoundingClientRect().height > 0 })
          .map(function (b) {
            var r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }),
        intro: (document.querySelector('.devs-intro') || {}).textContent || '',
        foot: (document.querySelector('.devs-foot') || {}).textContent || '',
        theme: document.documentElement.getAttribute('data-theme')
      }
    })())`))
    check(name + ' 无横向溢出', audit.docW <= audit.viewW + 1 && audit.bodyW <= audit.viewW + 1,
      'doc=' + audit.docW + ' body=' + audit.bodyW + ' view=' + audit.viewW)
    check(name + ' 每行 ≥64px', audit.rows.length === 0 || audit.rows.every((r) => r.h >= 64),
      JSON.stringify(audit.rows))
    check(name + ' 撤销按钮 44px', audit.buttons.length === 0 || audit.buttons.every((b) => b.h >= 44),
      JSON.stringify(audit.buttons))
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    console.log(`  ${name}.png ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} theme=${audit.theme} ` +
      `rows=${audit.rows.length} buttons=${JSON.stringify(audit.buttons)}`)
    return audit
  }

  console.log('\n[1] 设备列表（亮色）')
  await openDevicesPage('light', 'devices')
  const listAudit = await shot('devices')
  check('列表有 3 台设备', listAudit.rows.length === 3, String(listAudit.rows.length))
  check('长设备名在行内被省略（不撑宽文档）', listAudit.names.some((n) => n.sw > n.cw),
    JSON.stringify(listAudit.names))
  check('页脚写明不记录 IP / 完整 UA',
    listAudit.foot.includes('不记录 IP') && listAudit.foot.includes('完整浏览器标识'), listAudit.foot)
  check('当前设备带「这台设备」标记',
    (await evalJs(`(document.querySelector('.devrow.cur .dev-tag') || {}).textContent || ''`)) === '这台设备')

  console.log('\n[2] 撤销当前设备：二次确认层')
  await evalJs(`(function () {
    var b = document.querySelector('.devrow.cur .dev-revoke');
    if (b) b.click();
    return 'ok'
  })()`)
  await waitFor(`!document.getElementById('devConfirm').hidden`, 3000, '确认层出现')
  const confirmText = await evalJs(`document.getElementById('devConfirmText').textContent`)
  check('确认层文案完整（含需重配对）', /撤销后这台手机需要重新配对/.test(confirmText), confirmText)
  const confirmBox = await evalJs(`JSON.stringify((function () {
    var c = document.querySelector('#devConfirm .confirm-card').getBoundingClientRect()
    var b = [].slice.call(document.querySelectorAll('#devConfirm button')).map(function (x) {
      return Math.round(x.getBoundingClientRect().height) })
    return { w: Math.round(c.width), h: Math.round(c.height), buttons: b }
  })())`)
  const cbox = JSON.parse(confirmBox)
  check('确认层在 390 宽内且按钮 44px', cbox.w <= 358 && cbox.buttons.every((h) => h >= 44), confirmBox)
  await shot('devices-self-confirm')

  console.log('\n[3] 撤销后本端 → 说明屏')
  await evalJs(`document.getElementById('devConfirmOk').click(); 'ok'`)
  await waitFor(`!document.getElementById('revoked').hidden`, 4000, '撤销说明屏')
  const revokedText = await evalJs(`document.getElementById('revoked').innerText`)
  check('说明屏字样与重配对入口', /此设备已被撤销/.test(revokedText) &&
    /重新配对/.test(revokedText), revokedText)
  const rvBox = await evalJs(`JSON.stringify((function () {
    var c = document.querySelector('.revoked-card').getBoundingClientRect()
    var a = document.querySelector('.rv-pair').getBoundingClientRect()
    return { w: Math.round(c.width), h: Math.round(c.height), pairH: Math.round(a.height) }
  })())`)
  const rbox = JSON.parse(rvBox)
  check('说明屏卡片在 390 宽内、重配对键 48px', rbox.w <= 358 && rbox.pairH >= 48, rvBox)
  await shot('devices-revoked')

  console.log('\n[4] 设备列表（暗色）')
  await cdp.send('Page.navigate', { url: base + '/taskwatch?shot=dark&t=' + Date.now() })
  await sleep(900)
  await evalJs(`document.documentElement.setAttribute('data-theme', 'dark'); 'ok'`)
  await evalJs(`location.hash = '#devices'; 'ok'`)
  await waitFor(`!!document.querySelector('#devicesView') && !document.getElementById('devicesView').hidden
    && document.querySelectorAll('.devrow').length >= 2`, 6000, '暗色设备页')
  await sleep(350)
  const darkAudit = await shot('devices-dark')
  check('暗色主题确实生效', darkAudit.theme === 'dark', String(darkAudit.theme))

  try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
  cdp.close()
  browser.close()

  if (failures.length) {
    console.error('\n截图自检失败：\n  ' + failures.join('\n  '))
    process.exitCode = 1
  } else {
    console.log('\n四张设备页截图通过：无横向溢出、行高与命中区达标。')
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
