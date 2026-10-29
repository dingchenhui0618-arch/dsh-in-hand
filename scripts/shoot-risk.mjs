/**
 * 高危动作二次确认截图（v1.8.8，P4 收尾）。
 *
 * 真 Chrome + CDP，DPR2，390×844；页面就是 lib/page.html 本身，只把宿主接口
 * 换成假数据（不发真实请求、不读本机文件）。每张图先做页面级自检（无横向
 * 溢出、徽标不挤压标题、确认层文案完整、按钮 44px），再落盘到
 * _ui-review/round16。
 *
 *   risk-card.png    亮色：高危徽标 + 「这条会改动文件或发布…」
 *   risk-confirm.png 亮色：卡片内展开的确认层（遮罩压暗周围，卡片本身可读）
 *   risk-normal.png  亮色：普通审批卡，无高危徽标
 *   risk-dark.png    暗色：同一张高危确认层（实心危险色在暗色下的观感）
 *
 * 用法：node scripts/shoot-risk.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDevToolsPort } from './devtools-port.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
const SW = join(ROOT, 'lib', 'sw.js')
// 与仓库同级的评审目录（_ui-review/round16），不把本机绝对路径写进脚本。
const OUT = join(ROOT, '..', '_ui-review', 'round16')
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
mkdirSync(OUT, { recursive: true })

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

const NOW = Date.now()
const HIGH = {
  id: 'approval-demo-high',
  kind: 'approval/request',
  title: 'pwsh',
  detail: '在仓库根目录执行 npm publish --access public，把 1.8.8 发到 npm。',
  risk: 'high',
  session: 'session-demo-a',
  sessionTitle: '发布 1.8.8 到 npm',
  at: NOW - 2000,
  canDecide: true,
  expiresAt: NOW + 110000,
  timeoutMs: 120000,
}
const NORMAL = {
  id: 'approval-demo',
  kind: 'approval/request',
  title: 'edit',
  detail: '改一处文案：把「保存」改成「保存并关闭」。',
  risk: 'normal',
  session: 'session-demo-b',
  sessionTitle: '整理按钮文案',
  at: NOW - 1000,
  canDecide: true,
  expiresAt: NOW + 118000,
  timeoutMs: 120000,
}
function demoData(pending) {
  return {
    generatedAt: Date.now(),
    offline: false,
    errors: [],
    riskConfirm: true,
    totals: { sessions: 1, running: 1, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: pending.length },
    today: { since: Date.now() - 6 * 3600 * 1000, turns: 12, steps: 86, sessions: 1, partial: false },
    pending,
    sessions: [{
      id: 'session-demo-a',
      title: '发布 1.8.8 到 npm',
      running: true,
      activeJobs: 0,
      live: true,
      origin: 'root',
      depth: 0,
      preset: 'cordis',
      cwd: '~/projects/dsh-in-hand',
      updatedAt: Date.now() - 3000,
      lastActivity: Date.now() - 3000,
      lastTool: 'pwsh',
      lastToolAt: Date.now() - 9000,
      turnStartedAt: Date.now() - 186000,
      stepsInTurn: 4,
      goal: null,
    }],
    jobs: [],
    subagents: [],
    workflows: [],
  }
}

const pageHtml = readFileSync(PAGE, 'utf8')
const swJs = readFileSync(SW, 'utf8')
let scenario = { pending: [HIGH, NORMAL] }

let server = null
let child = null
let profile = ''
let cdp = null
let browser = null
let failures = 0
function check(name, ok, detail) {
  if (ok) console.log('  PASS  ' + name)
  else { failures++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}

try {
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const json = (value) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(pageHtml)
      return
    }
    if (path === '/taskwatch/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(swJs)
      return
    }
    if (path === '/taskwatch/data') { json(demoData(scenario.pending)); return }
    if (path === '/taskwatch/approve') { json({ ok: true, outcome: 'allowed-once' }); return }
    if (path.startsWith('/taskwatch/chat/') || path === '/taskwatch/devices') {
      json(path === '/taskwatch/devices' ? { ok: true, devices: [] } : { sessions: [] })
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

  profile = mkdtempSync(join(tmpdir(), 'tw-risk-shots-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=2',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const deadline = Date.now() + 15000
  let port = 0
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Chrome 启动即退出，code=' + child.exitCode)
    const found = readDevToolsPort(join(profile, 'DevToolsActivePort'))
    if (found) { port = Number(found); break }
    await sleep(100)
  }
  if (!port) throw new Error('等不到 DevToolsActivePort')
  const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json()
  browser = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const info = targets.find((t) => t.id === targetId)
  if (!info) throw new Error('找不到 target')
  cdp = await Cdp.connect(info.webSocketDebuggerUrl)
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
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await evalJs(expression)) return true
      await sleep(100)
    }
    throw new Error('超时：' + label)
  }

  async function openHome(scheme, tag) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await cdp.send('Page.navigate', { url: base + '/taskwatch?warm=' + tag })
    await sleep(500)
    await evalJs(`try { localStorage.setItem('taskwatch.theme', ${JSON.stringify(scheme)}) } catch (e) {}; 'ok'`)
    await cdp.send('Page.navigate', { url: base + '/taskwatch?shot=' + tag + '&t=' + Date.now() })
    await sleep(1200)
    await evalJs(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)}); 'ok'`)
    await waitFor(`document.querySelectorAll('#homeTodo [data-pending-id]').length >= 1`, 6000, '首页待办')
    await sleep(350)
  }

  async function shot(name, auditExpr) {
    const audit = auditExpr ? JSON.parse(await evalJs(`JSON.stringify((function () { ${auditExpr} })())`)) : {}
    check(name + ' 无横向溢出', audit.docW == null || (audit.docW <= audit.viewW + 1 && audit.bodyW <= audit.viewW + 1),
      'doc=' + audit.docW + ' body=' + audit.bodyW + ' view=' + audit.viewW)
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    console.log(`  ${name}.png ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} theme=${audit.theme || '-'}`)
    return audit
  }

  console.log('\n[1] risk-card（亮色：高危徽标）')
  scenario = { pending: [HIGH, NORMAL] }
  await openHome('light', 'card')
  const cardAudit = await shot('risk-card', `
    var hi = document.querySelector('#homeTodo [data-pending-id="approval-demo-high"]')
    var badge = hi.querySelector('.badge')
    var title = hi.querySelector('.title')
    var br = badge.getBoundingClientRect(), tr = title.getBoundingClientRect()
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      docW: document.documentElement.scrollWidth,
      bodyW: document.body.scrollWidth,
      viewW: window.innerWidth,
      badge: badge.textContent.trim(),
      badgeRight: Math.round(br.right),
      titleLeft: Math.round(tr.left),
      titleW: Math.round(tr.width),
      note: (hi.querySelector('.risk-note') || {}).textContent || '',
      approveH: Math.round(hi.querySelector('[data-approve]').getBoundingClientRect().height)
    }`)
  check('高危徽标是「高危」且不挤压标题',
    cardAudit.badge === '高危' && cardAudit.badgeRight <= cardAudit.titleLeft + 1 && cardAudit.titleW >= 80,
    JSON.stringify(cardAudit))
  check('说明文案完整', cardAudit.note === '这条会改动文件或发布，确认前请看清', cardAudit.note)
  check('批准按钮 44px', cardAudit.approveH >= 44, String(cardAudit.approveH))

  console.log('\n[2] risk-confirm（亮色：卡片内确认层）')
  await evalJs(`document.querySelector('#homeTodo [data-pending-id="approval-demo-high"] [data-approve]').click(); 'ok'`)
  await waitFor(`!document.querySelector('#homeTodo [data-risk-confirm]').hidden`, 3000, '确认层')
  await sleep(300)
  const confirmAudit = await shot('risk-confirm', `
    var box = document.querySelector('#homeTodo [data-risk-confirm]')
    var ok = box.querySelector('[data-risk-ok]')
    var cancel = box.querySelector('[data-risk-cancel]')
    var card = box.closest('.pending-card')
    var cr = card.getBoundingClientRect(), vr = box.getBoundingClientRect()
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      docW: document.documentElement.scrollWidth,
      bodyW: document.body.scrollWidth,
      viewW: window.innerWidth,
      text: box.textContent,
      okH: Math.round(ok.getBoundingClientRect().height),
      cancelH: Math.round(cancel.getBoundingClientRect().height),
      cardBottom: Math.round(cr.bottom),
      boxBottom: Math.round(vr.bottom),
      viewH: window.innerHeight,
      mask: !document.getElementById('riskMask').hidden,
      approveDisabled: card.querySelector('[data-approve]').disabled,
      rejectDisabled: card.querySelector('[data-reject]').disabled
    }`)
  check('确认层文案完整（工具 / 原因 / 不可撤销）',
    confirmAudit.text.includes('pwsh') && confirmAudit.text.includes('npm publish --access public') &&
    confirmAudit.text.includes('确认执行？此操作不可撤销'), confirmAudit.text)
  check('两个按钮 44px', confirmAudit.okH >= 44 && confirmAudit.cancelH >= 44,
    JSON.stringify({ ok: confirmAudit.okH, cancel: confirmAudit.cancelH }))
  check('确认层完整落在首屏内', confirmAudit.boxBottom <= confirmAudit.viewH + 1,
    'bottom=' + confirmAudit.boxBottom + ' viewH=' + confirmAudit.viewH)
  check('遮罩出现、卡片其余按钮禁用', confirmAudit.mask === true &&
    confirmAudit.approveDisabled === true && confirmAudit.rejectDisabled === true)

  console.log('\n[3] risk-normal（亮色：普通卡无徽标）')
  scenario = { pending: [NORMAL] }
  await openHome('light', 'normal')
  const normalAudit = await shot('risk-normal', `
    var card = document.querySelector('#homeTodo [data-pending-id="approval-demo"]')
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      docW: document.documentElement.scrollWidth,
      bodyW: document.body.scrollWidth,
      viewW: window.innerWidth,
      badge: card.querySelector('.badge').textContent.trim(),
      riskBadge: !!card.querySelector('.badge.risk'),
      note: !!card.querySelector('.risk-note'),
      confirm: !!card.querySelector('[data-risk-confirm]')
    }`)
  check('普通卡没有高危徽标 / 说明 / 确认层',
    normalAudit.badge === '待批准' && normalAudit.riskBadge === false &&
    normalAudit.note === false && normalAudit.confirm === false, JSON.stringify(normalAudit))

  console.log('\n[4] risk-dark（暗色：同一张确认层）')
  scenario = { pending: [HIGH, NORMAL] }
  await openHome('dark', 'dark')
  await evalJs(`document.querySelector('#homeTodo [data-pending-id="approval-demo-high"] [data-approve]').click(); 'ok'`)
  await waitFor(`!document.querySelector('#homeTodo [data-risk-confirm]').hidden`, 3000, '暗色确认层')
  await sleep(300)
  const darkAudit = await shot('risk-dark', `
    var box = document.querySelector('#homeTodo [data-risk-confirm]')
    var ok = box.querySelector('[data-risk-ok]')
    var cs = getComputedStyle(ok)
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      docW: document.documentElement.scrollWidth,
      bodyW: document.body.scrollWidth,
      viewW: window.innerWidth,
      text: box.textContent,
      okH: Math.round(ok.getBoundingClientRect().height),
      fill: cs.backgroundColor,
      fg: cs.color
    }`)
  check('暗色主题生效且确认层文案完整', darkAudit.theme === 'dark' &&
    darkAudit.text.includes('确认执行？此操作不可撤销') && darkAudit.text.includes('pwsh'))
  check('暗色危险按钮 44px 且有实心底色', darkAudit.okH >= 44 &&
    darkAudit.fill !== 'rgba(0, 0, 0, 0)' && darkAudit.fill !== 'transparent', JSON.stringify(darkAudit))

  try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
} finally {
  if (cdp) cdp.close()
  if (browser) browser.close()
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 旧 Node */ } try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}

const names = ['risk-card', 'risk-confirm', 'risk-normal', 'risk-dark']
for (const name of names) {
  if (!existsSync(join(OUT, name + '.png'))) { failures++; console.log('  FAIL  缺少 ' + name + '.png') }
}
if (failures) {
  console.error('\n截图自检失败：' + failures + ' 项')
  process.exitCode = 1
} else {
  console.log('\n四张高危确认截图通过：' + OUT)
}
