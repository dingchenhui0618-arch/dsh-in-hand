#!/usr/bin/env node
/**
 * 相机直发（P5，v1.8.9）的自检。
 *
 * 这一版要证明的是「拍一张就能发」，而且**没有另造一条上传通道**：
 *
 *   1. DOM 里有 input[accept="image/*"][capture="environment"] 与对应的相机键；
 *   2. 3000×2000 的图经 canvas 压缩后，**上传体**（真的 JPEG 字节，按 SOF 解析）
 *      长边 ≤1600、宽高比不变；
 *   3. EXIF Orientation=6 的竖图，输出宽 < 高（不横躺）；
 *   4. 选中即见缩略图/大小/取消；压缩期间点 × → 一条上传请求都不发；
 *   5. 上传失败（500）→ 保留缩略图并给「重试」，点了能恢复；
 *   6. 390 宽下输入框仍有宽度、无横向溢出、两个键 ≥44px；
 *   7. 相机键发出的上传请求与「附件 → 选择图片」**完全同一个路径与参数集**。
 *
 * 页面用真 Chrome + CDP（本机没有 Chrome 就 SKIP，与其它检查一致）。
 * 上传/发送都打到本地假宿主，不联网、不碰真实 ~/.dsh。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDevToolsPort } from './devtools-port.mjs'
import { jpegSize, makeJpeg, withExifOrientation } from './camera-fixture.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
const SW = join(ROOT, 'lib', 'sw.js')

let passed = 0
let failed = 0
let skipped = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail === undefined ? '' : '  → ' + detail)) }
}
function skip(name, why) { skipped++; console.log('  SKIP  ' + name + (why ? '  — ' + why : '')) }
function section(title) { console.log('\n' + title) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const near = (a, b, tol) => Math.abs(a / b - 1) <= tol

const pageHtml = readFileSync(PAGE, 'utf8')
const swJs = readFileSync(SW, 'utf8')

// ═════════════════════════════════════════════════════════════════════════
// [0] 静态：标记、常量、通道
// ═════════════════════════════════════════════════════════════════════════
section('[0] 静态：相机输入 / 按钮 / 压缩参数 / 上传通道')

check('页面有 input[accept="image/*"][capture="environment"]',
  /<input\s+id="cameraInput"[^>]*accept="image\/\*"[^>]*capture="environment"[^>]*>/.test(pageHtml))
check('有对应的相机键（aria-label「拍照发送」）',
  /<button\s+id="camera"[^>]*aria-label="拍照发送"/.test(pageHtml))
check('相册入口标注「选择图片」', /aria-label="选择图片"/.test(pageHtml))
check('不用 getUserMedia（不进权限 / 流的状态机）', !/getUserMedia\s*\(/.test(pageHtml))
check('压缩长边上限 1600、质量 0.82 / 0.7、体积上限 2.5MB',
  /CAMERA_MAX_EDGE = 1600/.test(pageHtml) && /CAMERA_QUALITY = 0\.82/.test(pageHtml) &&
  /CAMERA_QUALITY_RETRY = 0\.7/.test(pageHtml) && /CAMERA_MAX_BYTES = 2\.5 \* 1024 \* 1024/.test(pageHtml))
check('方向用 createImageBitmap 的 imageOrientation:"from-image"',
  /createImageBitmap\(file, \{ imageOrientation:'from-image' \}\)/.test(pageHtml))
check('页面里只有一个上传调用（没新增通道）',
  (pageHtml.match(/fetch\('\/taskwatch\/chat\/upload'/g) || []).length === 1,
  String((pageHtml.match(/fetch\('\/taskwatch\/chat\/upload'/g) || []).length))
check('上传请求方法 / 头与原来一致（POST + octet-stream）',
  /fetch\('\/taskwatch\/chat\/upload' \+ q, \{\s*method:'POST', headers:\{ 'content-type':'application\/octet-stream' \}/.test(pageHtml))
check('SW 缓存升到 taskwatch-v30', /const CACHE = 'taskwatch-v30'/.test(swJs))

// ═════════════════════════════════════════════════════════════════════════
// 页面：真 Chrome + CDP
// ═════════════════════════════════════════════════════════════════════════
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
  skip('页面七组验收（相机 / 压缩 / 方向 / 取消 / 失败 / 布局 / 同一路径）',
    '本机没有 Chrome（设置 CHROME_PATH 后可跑）')
} else {
  const NOW = Date.now()
  const payload = () => ({
    generatedAt: Date.now(),
    offline: false,
    errors: [],
    riskConfirm: true,
    totals: { sessions: 1, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
    today: { since: NOW - 6 * 3600 * 1000, turns: 2, steps: 9, sessions: 1, partial: false },
    pending: [],
    sessions: [{
      id: 's-camera', title: '相机直发测试', running: false, activeJobs: 0, live: true,
      origin: 'root', depth: 0, preset: 'cordis', cwd: '~/projects/dsh-in-hand',
      updatedAt: NOW - 4000, lastActivity: NOW - 4000,
    }],
    jobs: [],
    subagents: [],
    workflows: [],
  })

  const uploads = []
  const sends = []
  let uploadFail = false

  const server = createServer(async (req, res) => {
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
    if (path === '/taskwatch/data') { json(payload()); return }
    if (path === '/taskwatch/chat/sessions') {
      json({ sessions: payload().sessions })
      return
    }
    if (path === '/taskwatch/chat/upload') {
      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      const query = Object.fromEntries(url.searchParams)
      const record = {
        pathname: path, method: req.method, contentType: req.headers['content-type'] || '',
        query, body, bytes: body.length,
      }
      uploads.push(record)
      if (uploadFail) { json({ error: '上传服务不可用（自检拦截）' }, 500); return }
      json({
        ok: true,
        upload: {
          kind: query.kind || 'file', attachmentId: 'att-' + uploads.length,
          name: query.name || 'x', mime: query.mime || '', bytes: body.length,
        },
      })
      return
    }
    if (path === '/taskwatch/chat/send') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      let body = {}
      try { body = JSON.parse(raw) } catch { body = {} }
      sends.push(body)
      json({ ok: true, accepted: true })
      return
    }
    if (path === '/taskwatch/chat/stream' || path === '/taskwatch/approvals/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache', connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      return
    }
    if (path === '/taskwatch/devices') { json({ ok: true, devices: [] }); return }
    json({ error: 'not found' }, 404)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

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
      this.requests = []
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (!msg.id) {
          if (msg.method === 'Network.requestWillBeSent') {
            const request = msg.params.request
            this.requests.push({ url: request.url, method: request.method })
          }
          return
        }
        if (!this.pending.has(msg.id)) return
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
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 25000)
        this.pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v) },
          reject: (e) => { clearTimeout(timer); reject(e) },
        })
      })
    }
    close() { try { this.ws.close() } catch { /* 已断开 */ } }
  }

  let workDir = ''
  let profile = ''
  let child = null
  let browser = null
  let cdp = null
  let targetId = ''

  try {
    workDir = mkdtempSync(join(tmpdir(), 'tw-camera-'))
    profile = mkdtempSync(join(tmpdir(), 'tw-camera-chrome-'))
    child = (await import('node:child_process')).spawn(chrome, [
      '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
      '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
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
    // 验收就是 390 宽（真机常见宽度），DPR2 与截图脚本一致。
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
        await sleep(80)
      }
      throw new Error('超时：' + label)
    }
    const openPage = async (tag) => {
      await cdp.send('Page.navigate', { url: base + '/taskwatch?t=' + Date.now() + '&tag=' + tag + '#session/s-camera' })
      await sleep(400)
      await waitFor(`!!document.getElementById('camera') && !!document.querySelector('footer')
        && document.querySelector('footer').hidden === false`, 10000, '会话页输入区')
      await sleep(200)
    }
    const setFiles = async (selector, files) => {
      const doc = await cdp.send('DOM.getDocument', { depth: -1 })
      const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector })
      if (!found || !found.nodeId) throw new Error('找不到 ' + selector)
      await cdp.send('DOM.setFileInputFiles', { files, nodeId: found.nodeId })
    }
    const waitUploads = async (n, timeout) => {
      const end = Date.now() + (timeout || 25000)
      while (Date.now() < end) {
        if (uploads.length >= n) return uploads[n - 1]
        await sleep(80)
      }
      throw new Error('等不到第 ' + n + ' 个上传请求（现有 ' + uploads.length + '）')
    }
    const chipText = () => evalJs(`(function () {
      var chip = document.querySelector('#attachmentTray .attach-chip')
      return chip ? chip.textContent.replace(/\\s+/g, ' ').trim() : ''
    })()`)

    // ── [1] DOM ──────────────────────────────────────────────────────────
    console.log('\n[1] 相机输入与按钮')
    await openPage('dom')
    const dom = JSON.parse(await evalJs(`JSON.stringify((function () {
      var input = document.querySelector('input[accept="image/*"][capture="environment"]')
      var camera = document.getElementById('camera')
      var attach = document.getElementById('attach')
      var r = camera ? camera.getBoundingClientRect() : null
      var ar = attach ? attach.getBoundingClientRect() : null
      return {
        input: !!input, inputId: input ? input.id : '', hidden: input ? input.hidden : null,
        camera: !!camera, label: camera ? camera.getAttribute('aria-label') : '',
        title: camera ? camera.getAttribute('title') : '',
        cameraW: r ? Math.round(r.width) : 0, cameraH: r ? Math.round(r.height) : 0,
        attachW: ar ? Math.round(ar.width) : 0, attachH: ar ? Math.round(ar.height) : 0,
        thumb: !!document.createElement('canvas').getContext('2d')
      }
    })())`))
    check('DOM 里有 cameraInput（accept=image/* + capture=environment）',
      dom.input === true && dom.inputId === 'cameraInput', JSON.stringify(dom))
    check('相机按钮挂在输入框旁、aria-label 是「拍照发送」',
      dom.camera === true && dom.label === '拍照发送', JSON.stringify(dom.label))
    check('相机键 44×44', dom.cameraW >= 44 && dom.cameraH >= 44,
      dom.cameraW + '×' + dom.cameraH)

    // ── [2] 3000×2000 → 长边 1600 ────────────────────────────────────────
    console.log('\n[2] 3000×2000：长边 ≤1600、宽高比不变、只发图')
    const bigPath = join(workDir, 'big-3000x2000.jpg')
    writeFileSync(bigPath, await makeJpeg(evalJs, { width: 3000, height: 2000, code: '0x80070005' }))
    const beforeBig = uploads.length
    await setFiles('#cameraInput', [bigPath])
    await waitFor(`(function () {
      var chip = document.querySelector('#attachmentTray .attach-chip')
      return !!chip && /已就绪/.test(chip.textContent)
    })()`, 25000, '压缩并上传完成')
    const up1 = await waitUploads(beforeBig + 1)
    const dim1 = jpegSize(up1.body)
    check('上传体长边 ≤1600', !!dim1 && Math.max(dim1.width, dim1.height) <= 1600,
      JSON.stringify(dim1))
    check('宽高比保持 3:2（1600×1067）', !!dim1 && near(dim1.width / dim1.height, 1.5, 0.012),
      dim1 ? (dim1.width / dim1.height).toFixed(4) : 'no size')
    check('压缩后是 JPEG（mime 参数 + .jpg 文件名 + 体积 ≤2.5MB）',
      up1.query.mime === 'image/jpeg' && /\.jpg$/.test(up1.query.name || '') &&
      up1.body.length <= 2.5 * 1024 * 1024,
      JSON.stringify({ mime: up1.query.mime, name: up1.query.name, bytes: up1.body.length }))
    const chip = JSON.parse(await evalJs(`JSON.stringify((function () {
      var chip = document.querySelector('#attachmentTray .attach-chip')
      var img = chip.querySelector('img.thumb')
      var remove = chip.querySelector('.remove')
      return {
        text: chip.textContent.replace(/\\s+/g, ' ').trim(),
        hasThumb: !!img, thumbW: img ? Math.round(img.getBoundingClientRect().width) : 0,
        thumbH: img ? Math.round(img.getBoundingClientRect().height) : 0,
        remove: !!remove, removeLabel: remove ? remove.getAttribute('aria-label') : '',
        removeW: remove ? Math.round(remove.getBoundingClientRect().width) : 0,
        removeH: remove ? Math.round(remove.getBoundingClientRect().height) : 0
      }
    })())`))
    check('缩略图 + 大小 + 取消一起出现',
      chip.hasThumb && /已就绪/.test(chip.text) && /(KB|MB|B)/.test(chip.text) && chip.remove === true,
      JSON.stringify(chip))
    check('缩略图是 32×32 的 cover（不变形）',
      chip.thumbW === 32 && chip.thumbH === 32, chip.thumbW + '×' + chip.thumbH)
    check('取消键 ≥44px 且有 aria-label', chip.removeW >= 44 && chip.removeH >= 44 && !!chip.removeLabel,
      JSON.stringify(chip))
    // 只发图、不带文字：空输入框直接点发送。
    await evalJs(`document.getElementById('send').click(); 'ok'`)
    const endSend = Date.now() + 8000
    while (Date.now() < endSend && sends.length === 0) await sleep(80)
    const send1 = sends[0] || {}
    check('可只发图（text 为空、attachments 带 upload 引用）',
      sends.length === 1 && send1.text === '' && Array.isArray(send1.attachments) &&
      send1.attachments.length === 1 && send1.attachments[0] &&
      send1.attachments[0].attachmentId === 'att-1' && send1.attachments[0].kind === 'image',
      JSON.stringify(send1))

    // ── [3] EXIF Orientation=6 ──────────────────────────────────────────
    console.log('\n[3] 竖图 EXIF Orientation=6：输出不横躺')
    await openPage('exif')
    const exifPath = join(workDir, 'portrait-exif6.jpg')
    writeFileSync(exifPath, withExifOrientation(readFileSync(bigPath), 6))
    const beforeExif = uploads.length
    await setFiles('#cameraInput', [exifPath])
    const up2 = await waitUploads(beforeExif + 1)
    const dim2 = jpegSize(up2.body)
    check('EXIF 6 的图上传后是竖的（宽 < 高）', !!dim2 && dim2.width < dim2.height,
      JSON.stringify(dim2))
    check('竖图长边仍是 1600（1600×1067 旋转后 1067×1600）',
      !!dim2 && Math.max(dim2.width, dim2.height) === 1600 && near(dim2.width / dim2.height, 2 / 3, 0.012),
      dim2 ? dim2.width + '×' + dim2.height : 'no size')

    // ── [4] 选中即见 + 取消不发请求 ─────────────────────────────────────
    console.log('\n[4] 选图后出现缩略图与取消；取消后不产生上传请求')
    await openPage('cancel')
    const beforeCancel = uploads.length
    await evalJs(`(function () {
      var input = document.getElementById('cameraInput')
      // 页面自己的 change 处理先跑（同步挂上 chip），这里紧接着点 × —— 
      // 等于「刚选中就反悔」，压缩还没完成，一张图都不该上传。
      input.addEventListener('change', function () {
        var chip = document.querySelector('#attachmentTray .attach-chip')
        window.__twSawChip = !!chip && !!chip.querySelector('img.thumb') && !!chip.querySelector('.remove')
        if (chip) { var x = chip.querySelector('.remove'); if (x) x.click() }
      })
      return 'ok'
    })()`)
    await setFiles('#cameraInput', [bigPath])
    await sleep(1200)
    const cancelState = JSON.parse(await evalJs(`JSON.stringify({
      sawChip: !!window.__twSawChip,
      chips: document.querySelectorAll('#attachmentTray .attach-chip').length,
      trayHidden: document.getElementById('attachmentTray').hidden
    })`))
    check('取消前确实出现缩略图 + 取消键', cancelState.sawChip === true, JSON.stringify(cancelState))
    check('取消后不产生上传请求', uploads.length === beforeCancel,
      'before=' + beforeCancel + ' after=' + uploads.length)
    check('取消后缩略图与托盘一起收起', cancelState.chips === 0 && cancelState.trayHidden === true,
      JSON.stringify(cancelState))

    // ── [5] 上传失败 → 重试 ─────────────────────────────────────────────
    console.log('\n[5] 上传失败：保留缩略图并给「重试」')
    await openPage('fail')
    uploadFail = true
    const beforeFail = uploads.length
    await setFiles('#cameraInput', [bigPath])
    await waitFor(`!!document.querySelector('#attachmentTray .attach-chip .retry')`, 20000, '重试按钮')
    const failChip = JSON.parse(await evalJs(`JSON.stringify((function () {
      var chip = document.querySelector('#attachmentTray .attach-chip')
      return {
        bad: chip.classList.contains('bad'),
        thumb: !!chip.querySelector('img.thumb'),
        text: chip.textContent.replace(/\\s+/g, ' ').trim(),
        retry: !!chip.querySelector('.retry'),
        retryH: Math.round(chip.querySelector('.retry').getBoundingClientRect().height)
      }
    })())`))
    check('失败时保留缩略图', failChip.thumb === true && failChip.bad === true, JSON.stringify(failChip))
    check('失败文案与「重试」都在', /上传失败|不可用/.test(failChip.text) && failChip.retry === true,
      failChip.text)
    check('重试键 ≥44px', failChip.retryH >= 44, String(failChip.retryH))
    uploadFail = false
    await evalJs(`document.querySelector('#attachmentTray .attach-chip .retry').click(); 'ok'`)
    await waitFor(`/已就绪/.test(document.querySelector('#attachmentTray .attach-chip').textContent)`, 20000, '重试成功')
    check('点重试能恢复（同一条通道）', uploads.length > beforeFail, 'uploads=' + uploads.length)

    // ── [6] 390 布局 ────────────────────────────────────────────────────
    console.log('\n[6] 390 宽：输入框仍有宽度、无横向溢出、两键 ≥44px')
    await openPage('layout')
    const layout = JSON.parse(await evalJs(`JSON.stringify((function () {
      var input = document.getElementById('input')
      var camera = document.getElementById('camera').getBoundingClientRect()
      var attach = document.getElementById('attach').getBoundingClientRect()
      var send = document.getElementById('send').getBoundingClientRect()
      var ir = input.getBoundingClientRect()
      var composer = document.querySelector('.composer').getBoundingClientRect()
      return {
        viewW: window.innerWidth,
        docW: document.documentElement.scrollWidth,
        bodyW: document.body.scrollWidth,
        inputW: Math.round(ir.width), inputLeft: Math.round(ir.left), inputRight: Math.round(ir.right),
        cameraW: Math.round(camera.width), cameraH: Math.round(camera.height),
        attachW: Math.round(attach.width), attachH: Math.round(attach.height),
        cameraRight: Math.round(camera.right), inputLeft2: Math.round(ir.left),
        sendLeft: Math.round(send.left), composerRight: Math.round(composer.right),
        cameraLabel: document.getElementById('camera').getAttribute('aria-label')
      }
    })())`))
    check('输入框宽度 > 0（390 宽）', layout.inputW > 0, String(layout.inputW))
    check('390 宽无横向溢出', layout.docW <= layout.viewW + 1 && layout.bodyW <= layout.viewW + 1,
      JSON.stringify({ doc: layout.docW, body: layout.bodyW, view: layout.viewW }))
    check('相机键 / 附件键都 ≥44px',
      layout.cameraW >= 44 && layout.cameraH >= 44 && layout.attachW >= 44 && layout.attachH >= 44,
      JSON.stringify(layout))
    check('相机键在输入框左侧、输入框不被挤没（≥120px）',
      layout.cameraRight <= layout.inputLeft + 1 && layout.inputW >= 120,
      JSON.stringify({ cameraRight: layout.cameraRight, inputLeft: layout.inputLeft, inputW: layout.inputW }))

    // ── [7] 与现有附件上传同一条路径 ───────────────────────────────────
    console.log('\n[7] 上传请求 URL / 参数与现有附件一致')
    const imageUpload = uploads.find((u) => u.query.kind === 'image')
    const filePath = join(workDir, 'note.txt')
    writeFileSync(filePath, 'hello from the attachment path\n')
    const beforeFile = uploads.length
    await setFiles('#fileInput', [filePath])
    const upFile = await waitUploads(beforeFile + 1)
    check('两个入口的请求路径完全相同（/taskwatch/chat/upload）',
      !!imageUpload && upFile.pathname === imageUpload.pathname &&
      upFile.pathname === '/taskwatch/chat/upload', JSON.stringify({ image: imageUpload && imageUpload.pathname, file: upFile.pathname }))
    check('方法 / Content-Type 相同（POST + octet-stream）',
      upFile.method === 'POST' && upFile.method === imageUpload.method &&
      upFile.contentType === 'application/octet-stream' && upFile.contentType === imageUpload.contentType,
      JSON.stringify({ file: upFile.contentType, image: imageUpload.contentType }))
    const imgKeys = Object.keys(imageUpload.query).sort().join(',')
    const fileKeys = Object.keys(upFile.query).sort().join(',')
    check('参数集一致（图片只多一个 mime）',
      fileKeys === 'kind,name,sessionId' && imgKeys === 'kind,mime,name,sessionId' &&
      upFile.query.sessionId === imageUpload.query.sessionId,
      JSON.stringify({ imgKeys, fileKeys }))
    check('页面里也没有第二个上传接口（静态已验）且都走 uploadAttachment',
      /function uploadAttachment\(a\)/.test(pageHtml) && /await runUpload\(a\)/.test(pageHtml))

    try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
  } catch (e) {
    failed++
    console.log('  FAIL  页面流程异常：' + (e && e.stack ? e.stack.split('\n')[0] : e))
  } finally {
    if (cdp) cdp.close()
    if (browser) browser.close()
    if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
    try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 旧 Node */ }
    try { await new Promise((resolve) => server.close(resolve)) } catch { /* 已关 */ }
    if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
    if (workDir) { try { rmSync(workDir, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
  }
}

console.log('\n相机直发：' + passed + ' 通过 / ' + failed + ' 失败 / ' + skipped + ' 跳过')
if (failed > 0) process.exitCode = 1
