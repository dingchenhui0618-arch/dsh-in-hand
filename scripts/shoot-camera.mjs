/**
 * 相机直发截图（v1.8.9，P5）。
 *
 * 真 Chrome + CDP，DPR2，390×844；页面就是 lib/page.html 本身，只把宿主接口换成
 * 假数据（不发真实请求、不读本机文件）。每张图先做页面级自检（无横向溢出、
 * 缩略图不变形、两个键 44px、输入框仍有宽度、chip 文案不被截断），再落盘到
 * _ui-review/round17。
 *
 *   camera-picked.png    亮色：已压缩上传完成，缩略图 + 大小 + 取消，输入框里带文字
 *   camera-uploading.png 亮色：上传进行中（宿主挂起响应），chip 显示「上传中…」
 *   camera-390.png       亮色：390 宽布局本身（空附件、输入框有内容，两键与输入框共存）
 *   camera-dark.png      暗色：同一张已就绪的缩略图（暗色令牌）
 *
 * 用法：node scripts/shoot-camera.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDevToolsPort } from './devtools-port.mjs'
import { makeJpeg } from './camera-fixture.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
const SW = join(ROOT, 'lib', 'sw.js')
// 与仓库同级的评审目录（_ui-review/round17），不把本机绝对路径写进脚本。
const OUT = join(ROOT, '..', '_ui-review', 'round17')
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
function demoData() {
  return {
    generatedAt: Date.now(),
    offline: false,
    errors: [],
    riskConfirm: true,
    totals: { sessions: 1, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
    today: { since: NOW - 6 * 3600 * 1000, turns: 3, steps: 14, sessions: 1, partial: false },
    pending: [],
    sessions: [{
      id: 's-demo', title: '排查 Windows 权限报错', running: false, activeJobs: 0, live: true,
      origin: 'root', depth: 0, preset: 'cordis', cwd: '~/projects/ops',
      updatedAt: NOW - 5000, lastActivity: NOW - 5000,
    }],
    jobs: [], subagents: [], workflows: [],
  }
}
const SNAPSHOT = {
  type: 'snapshot',
  cursor: 2,
  records: [
    { type: 'event', event: { seq: 1, type: 'user/message', time: NOW - 150000, data: { content: [{ type: 'text', text: '桌面弹了个报错，我拍给你看。' }] } } },
    { type: 'event', event: { seq: 2, type: 'assistant/message', time: NOW - 140000, data: { message: { content: [{ type: 'text', text: '发过来。顺便说一下是哪个操作触发的，我一起看。' }] } } } },
  ],
}

const pageHtml = readFileSync(PAGE, 'utf8')
const swJs = readFileSync(SW, 'utf8')

let server = null
let child = null
let profile = ''
let cdp = null
let browser = null
let targetId = ''
let holdUpload = false
const held = []
let work = ''
let failures = 0
function check(name, ok, detail) {
  if (ok) console.log('  PASS  ' + name)
  else { failures++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}

try {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    const json = (value, status) => {
      res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
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
    if (path === '/taskwatch/data') { json(demoData()); return }
    if (path === '/taskwatch/chat/sessions') { json({ sessions: demoData().sessions }); return }
    if (path === '/taskwatch/chat/upload') {
      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks).length
      const name = url.searchParams.get('name') || 'photo.jpg'
      const reply = () => json({
        ok: true,
        upload: { kind: 'image', attachmentId: 'att-demo', name, mime: 'image/jpeg', bytes },
      })
      if (holdUpload) { held.push(reply); return }
      reply()
      return
    }
    if (path === '/taskwatch/chat/send') { json({ ok: true, accepted: true }); return }
    if (path === '/taskwatch/chat/stream' || path === '/taskwatch/approvals/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache', connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      if (path === '/taskwatch/chat/stream') res.write('data: ' + JSON.stringify(SNAPSHOT) + '\n\n')
      return
    }
    if (path === '/taskwatch/devices') { json({ ok: true, devices: [] }); return }
    json({ error: 'not found' }, 404)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-camera-shots-'))
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
  const created = await browser.send('Target.createTarget', { url: 'about:blank' })
  targetId = created.targetId
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const info = targets.find((t) => t.id === targetId)
  if (!info) throw new Error('找不到 target')
  cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('DOM.enable')
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
  const setFiles = async (selector, files) => {
    const doc = await cdp.send('DOM.getDocument', { depth: -1 })
    const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
    if (!found || !found.nodeId) throw new Error('找不到 ' + selector)
    await cdp.send('DOM.setFileInputFiles', { files, nodeId: found.nodeId })
  }

  async function openSession(scheme, tag) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await cdp.send('Page.navigate', { url: base + '/taskwatch?warm=' + tag })
    await sleep(500)
    await evalJs(`try { localStorage.setItem('taskwatch.theme', ${JSON.stringify(scheme)}) } catch (e) {}; 'ok'`)
    await cdp.send('Page.navigate', { url: base + '/taskwatch?shot=' + tag + '&t=' + Date.now() + '#session/s-demo' })
    await sleep(900)
    await evalJs(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)}); 'ok'`)
    await waitFor(`!!document.getElementById('camera') && document.querySelector('footer')
      && document.querySelector('footer').hidden === false`, 10000, '会话页')
    await waitFor(`document.querySelectorAll('#log .bub').length >= 2`, 8000, '对话快照')
    await sleep(250)
  }

  async function shot(name, auditExpr) {
    // 截图前先收掉焦点环：键盘焦点是给键盘用户的，不是这一屏要展示的状态。
    await evalJs(`(function () {
      try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur() } catch (e) {}
      return 'ok'
    })()`)
    await sleep(120)
    const audit = auditExpr ? JSON.parse(await evalJs(`JSON.stringify((function () { ${auditExpr} })())`)) : {}
    check(name + ' 无横向溢出', audit.docW == null ||
      (audit.docW <= audit.viewW + 1 && audit.bodyW <= audit.viewW + 1),
      'doc=' + audit.docW + ' body=' + audit.bodyW + ' view=' + audit.viewW)
    if (audit.chipText != null) {
      check(name + ' 缩略图是 cover（不变形）', audit.objectFit === 'cover',
        'object-fit=' + audit.objectFit)
      check(name + ' 缩略图/大小/状态文案完整',
        audit.chipText.length > 0 && /(已就绪|上传中…)$/.test(audit.chipText), audit.chipText)
    }
    check(name + ' 相机键与附件键 ≥44px',
      audit.cameraW >= 44 && audit.cameraH >= 44 && audit.attachW >= 44 && audit.attachH >= 44,
      JSON.stringify({ camera: [audit.cameraW, audit.cameraH], attach: [audit.attachW, audit.attachH] }))
    check(name + ' 输入框仍有宽度', audit.inputW > 0, String(audit.inputW))
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    console.log(`  ${name}.png ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} theme=${audit.theme || '-'}`)
    return audit
  }

  const auditExpr = `
    var input = document.getElementById('input')
    var chip = document.querySelector('#attachmentTray .attach-chip')
    var img = chip ? chip.querySelector('img.thumb') : null
    var state = chip ? chip.querySelector('.state') : null
    var nameEl = chip ? chip.querySelector('.name') : null
    var cam = document.getElementById('camera').getBoundingClientRect()
    var att = document.getElementById('attach').getBoundingClientRect()
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      docW: document.documentElement.scrollWidth,
      bodyW: document.body.scrollWidth,
      viewW: window.innerWidth,
      inputW: Math.round(input.getBoundingClientRect().width),
      cameraW: Math.round(cam.width), cameraH: Math.round(cam.height),
      attachW: Math.round(att.width), attachH: Math.round(att.height),
      chipText: chip ? chip.textContent.replace(/\\s+/g, ' ').trim() : null,
      objectFit: img ? getComputedStyle(img).objectFit : null,
      thumbW: img ? Math.round(img.getBoundingClientRect().width) : 0,
      thumbH: img ? Math.round(img.getBoundingClientRect().height) : 0,
      nameClipped: !!(nameEl && nameEl.scrollWidth > nameEl.clientWidth + 1),
      stateClipped: !!(state && state.scrollWidth > state.clientWidth + 1),
      removeH: chip ? Math.round(chip.querySelector('.remove').getBoundingClientRect().height) : 0,
      retry: !!(chip && chip.querySelector('.retry'))
    }`

  const workDir = mkdtempSync(join(tmpdir(), 'tw-camera-fix-'))
  work = workDir
  // 先开一次页面，用页面自己的 canvas 画一张 3000×2000 的「报错屏」当相机原图。
  await openSession('light', 'fixture')
  const photo = join(workDir, 'IMG_20261029_2004.jpg')
  writeFileSync(photo, await makeJpeg(evalJs, { width: 3000, height: 2000, code: '0x80070005' }))

  console.log('\n[1] camera-picked（亮色：缩略图 + 大小 + 取消）')
  await openSession('light', 'picked')
  await setFiles('#cameraInput', [photo])
  await waitFor(`(function () {
    var chip = document.querySelector('#attachmentTray .attach-chip')
    return !!chip && /已就绪/.test(chip.textContent)
  })()`, 25000, '压缩并上传完成')
  await evalJs(`(function () {
    var i = document.getElementById('input')
    i.value = '这个报错怎么解决？'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(300)
  const picked = await shot('camera-picked', auditExpr)
  check('picked：缩略图 32×32、取消 44px、名称未被截断',
    picked.thumbW === 32 && picked.thumbH === 32 && picked.removeH >= 44 &&
    picked.nameClipped === false && picked.stateClipped === false, JSON.stringify(picked))
  check('picked：字号与大小文案齐全', /已就绪/.test(picked.chipText || '') && /(KB|MB|B)/.test(picked.chipText || ''),
    picked.chipText)

  console.log('\n[2] camera-uploading（缩略图 + 上传中…）')
  await openSession('light', 'uploading')
  holdUpload = true
  const beforeHold = held.length
  await setFiles('#cameraInput', [photo])
  await waitFor(`(function () {
    var chip = document.querySelector('#attachmentTray .attach-chip')
    return !!chip && /上传中/.test(chip.textContent)
  })()`, 25000, '上传中状态')
  await evalJs(`(function () {
    var i = document.getElementById('input')
    i.value = '稍等，正在传…'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(250)
  const uploading = await shot('camera-uploading', auditExpr)
  check('uploading：chip 显示「上传中…」', /上传中/.test(uploading.chipText || ''), uploading.chipText)
  check('uploading：请求确实挂起（还没回包）', held.length === beforeHold + 1, 'held=' + held.length)
  holdUpload = false
  held.splice(0).forEach((reply) => { try { reply() } catch { /* 已断开 */ } })

  console.log('\n[3] camera-390（390 宽布局：两键与输入框共存）')
  await openSession('light', 'layout')
  await evalJs(`(function () {
    var i = document.getElementById('input')
    i.value = '再拍一张清楚点的'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(250)
  const layout = await shot('camera-390', auditExpr)
  check('390：输入框 ≥120px、两个键都在、无溢出',
    layout.inputW >= 120 && layout.cameraW >= 44 && layout.attachW >= 44 &&
    layout.docW <= layout.viewW + 1, JSON.stringify(layout))

  console.log('\n[4] camera-dark（暗色：同一张已就绪的缩略图）')
  await openSession('dark', 'dark')
  await setFiles('#cameraInput', [photo])
  await waitFor(`(function () {
    var chip = document.querySelector('#attachmentTray .attach-chip')
    return !!chip && /已就绪/.test(chip.textContent)
  })()`, 25000, '暗色压缩并上传完成')
  await evalJs(`(function () {
    var i = document.getElementById('input')
    i.value = '暗色下也看得清吧？'
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(300)
  const dark = await shot('camera-dark', auditExpr)
  check('dark：主题生效且缩略图状态完整', dark.theme === 'dark' &&
    /已就绪/.test(dark.chipText || '') && dark.thumbW === 32, JSON.stringify(dark))

  try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
} finally {
  holdUpload = false
  held.splice(0).forEach((reply) => { try { reply() } catch { /* 已断开 */ } })
  if (cdp) cdp.close()
  if (browser) browser.close()
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 旧 Node */ }
  try { server.close() } catch { /* 已关 */ }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
  if (work) { try { rmSync(work, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}

const names = ['camera-picked', 'camera-uploading', 'camera-390', 'camera-dark']
for (const name of names) {
  if (!existsSync(join(OUT, name + '.png'))) { failures++; console.log('  FAIL  缺少 ' + name + '.png') }
}
if (failures) {
  console.error('\n截图自检失败：' + failures + ' 项')
  process.exitCode = 1
} else {
  console.log('\n四张相机直发截图通过：' + OUT)
}
