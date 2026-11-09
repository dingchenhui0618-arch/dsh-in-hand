#!/usr/bin/env node
/**
 * v1.8.25：`dsh-ui` 围栏「确认表单」的截图 + 量化自检。
 *
 * 真 Chrome + CDP，390×844、DPR2，页面是 docs/demo.html（由 lib/page.html 生成，
 * 取数换成演示假数据，左上角保留「演示数据 · 非真实状态」）。不联网、不读本机文件。
 *
 * 六张图（前三张是验收要的，第四张自查置灰态，第五、六张验 v1.8.26 的措辞分流）：
 *   1. genui-form       亮色，演示对话里那条真实表单围栏（未填 → 提交键禁用）
 *   2. genui-form-dark  同上暗色（看对比度，不是看"能显示"）
 *   3. genui-fallback   坏 JSON 围栏 → 提示一行 + 代码块
 *   4. genui-form-done  填完并提交后的置灰态（已提交、按钮禁用）
 *
 * 每张都量：卡片宽度、选项行高、提交键尺寸与字号、输入框字号（iOS 16px）、
 * 正文/标签/进度/置灰态的实际对比度（WCAG 相对亮度），以及有没有撑宽页面。
 *
 * 用法：node scripts/shoot-genui.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(ROOT, 'docs', 'demo.html')
const OUT = join(ROOT, '..', '_ui-review', 'round28')
const HINT = 'dsh-ui 围栏解析失败，按代码块显示'
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
  close() { try { this.ws.close() } catch (e) { /* 已关 */ } }
}

async function waitPort(profile, child) {
  const deadline = Date.now() + 15000
  const file = join(profile, 'DevToolsActivePort')
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Chrome 启动即退出，code=' + child.exitCode)
    const port = (() => {
      try {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/)
        return Number(lines[0]) || 0
      } catch (e) { return 0 }
    })()
    if (port) return port
    await sleep(100)
  }
  throw new Error('等不到 DevToolsActivePort')
}

const failures = []
function check(name, ok, detail) {
  if (ok) console.log('  PASS  ' + name)
  else {
    failures.push(name + (detail ? ' — ' + detail : ''))
    console.log('  FAIL  ' + name + (detail ? ' — ' + detail : ''))
  }
}

let server = null
let child = null
let profile = ''
let cdp = null
try {
  mkdirSync(OUT, { recursive: true })
  const html = readFileSync(DEMO, 'utf8')
  const icon = readFileSync(join(ROOT, 'lib', 'icons', 'icon-192.png'))
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (path === '/taskwatch/icon-192.png' || path === '/lib/icons/icon-192.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(icon)
      return
    }
    res.writeHead(404); res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-genui-shots-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const port = await waitPort(profile, child)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  let targetId = ''

  async function newPage() {
    if (targetId) { try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ } }
    const created = await browser.send('Target.createTarget', { url: 'about:blank' })
    targetId = created.targetId
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const info = targets.find((t) => t.id === targetId)
    if (!info) throw new Error('找不到 target')
    cdp = await Cdp.connect(info.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  }
  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500))
    return r.result && r.result.value
  }

  // 页面内量测：尺寸 + WCAG 对比度（含祖先 opacity 的混合，置灰态才算得准）。
  const AUDIT = `
    function __rgb(s){
      var m = /rgba?\\(([^)]+)\\)/.exec(s || '')
      if (!m) return null
      var p = m[1].split(',').map(function(x){ return parseFloat(x) })
      return { r:p[0], g:p[1], b:p[2], a:p.length > 3 ? p[3] : 1 }
    }
    function __bg(el){
      for (var n = el; n; n = n.parentElement) {
        var c = __rgb(getComputedStyle(n).backgroundColor)
        if (c && c.a >= 0.9) return c
      }
      return { r:255, g:255, b:255, a:1 }
    }
    function __lum(c){
      function f(v){ v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }
    function __ratio(a, b){
      var l1 = __lum(a), l2 = __lum(b)
      return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100
    }
    function __contrast(el){
      if (!el) return null
      var cs = getComputedStyle(el), fg = __rgb(cs.color), bg = __bg(el)
      if (!fg) return null
      var op = 1
      for (var n = el; n; n = n.parentElement) {
        var o = parseFloat(getComputedStyle(n).opacity)
        if (isFinite(o)) op *= o
      }
      var mixed = { r:fg.r * op + bg.r * (1 - op), g:fg.g * op + bg.g * (1 - op), b:fg.b * op + bg.b * (1 - op), a:1 }
      return __ratio(mixed, bg)
    }
    function __px(el, prop){ return el ? Math.round(parseFloat(getComputedStyle(el)[prop]) * 10) / 10 : null }
    function __rect(el){ return el ? el.getBoundingClientRect() : null }
    function __scrollTo(el){
      var log = document.getElementById('log')
      var lr = log.getBoundingClientRect(), er = el.getBoundingClientRect()
      log.scrollTop += (er.top - lr.top) - 2
      return true
    }
    function __audit(){
      var cards = document.querySelectorAll('.gu')
      var card = cards[cards.length - 1] || null
      var fallback = document.querySelectorAll('.gu-fallback')
      var fb = fallback[fallback.length - 1] || null
      var log = document.getElementById('log')
      var opts = card ? card.querySelectorAll('.gu-opt') : []
      var btn = card ? card.querySelector('.gu-btn') : null
      var inp = card ? card.querySelector('.gu-input') : null
      var area = card ? card.querySelector('.gu-area') : null
      var prog = card ? card.querySelector('.gu-progress') : null
      var note = fb ? fb.querySelector('.gu-note') : null
      var code = fb ? fb.querySelector('.code') : null
      var cr = __rect(card), br = __rect(btn), lr = __rect(log), fr = __rect(fb)
      var minOpt = 999
      for (var i = 0; i < opts.length; i++) minOpt = Math.min(minOpt, __rect(opts[i]).height)
      var firstOpt = opts.length ? opts[0] : null
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        sub: (document.getElementById('sessSub') || {}).textContent || '',
        iw: innerWidth,
        docW: document.documentElement.scrollWidth,
        logW: log.scrollWidth,
        cardFound: !!card,
        isDone: card ? card.classList.contains('is-done') : false,
        title: card && card.querySelector('.gu-title') ? card.querySelector('.gu-title').textContent : '',
        cardW: cr ? Math.round(cr.width) : null,
        cardH: cr ? Math.round(cr.height) : null,
        cardTop: cr ? Math.round(cr.top) : null,
        cardBottom: cr ? Math.round(cr.bottom) : null,
        logTop: lr ? Math.round(lr.top) : null,
        logBottom: lr ? Math.round(lr.bottom) : null,
        opts: opts.length,
        minOptH: opts.length ? Math.round(minOpt) : null,
        optFont: __px(firstOpt, 'fontSize'),
        btnW: br ? Math.round(br.width) : null,
        btnH: br ? Math.round(br.height) : null,
        btnFont: __px(btn, 'fontSize'),
        btnDisabled: btn ? btn.disabled : null,
        btnText: btn ? btn.textContent : '',
        progress: prog ? prog.textContent : '',
        inputFont: __px(inp, 'fontSize'),
        areaFont: __px(area, 'fontSize'),
        titleContrast: __contrast(card ? card.querySelector('.gu-title') : null),
        bodyContrast: __contrast(card ? (card.querySelector('.gu-text') || card.querySelector('.gu-title') || card.querySelector('.gu-label')) : null),
        labelContrast: __contrast(card ? card.querySelector('.gu-label') : null),
        optionContrast: __contrast(firstOpt ? firstOpt.querySelector('span') : null),
        progressContrast: __contrast(prog),
        btnContrast: __contrast(btn),
        placeholder: inp ? inp.getAttribute('placeholder') : '',
        fallbackFound: !!fb,
        fallbackNote: note ? note.textContent : '',
        fallbackCode: !!code,
        fallbackCodeLang: code && code.querySelector('.codebar .lang') ? code.querySelector('.codebar .lang').textContent : '',
        fallbackNoteAbove: !!(fb && note && code && (fb.firstElementChild === note)),
        fallbackNoteText: note ? note.textContent : '',
        skipNote: card && card.querySelector('.gu-skip') ? card.querySelector('.gu-skip').textContent : '',
        skipContrast: __contrast(card ? card.querySelector('.gu-skip') : null),
        fallbackW: fr ? Math.round(fr.width) : null,
        noteContrast: __contrast(note),
        unreadable: []
      }
    }
    true
  `
  async function shot(name, { scheme = 'light', mode = 'form' } = {}) {
    await newPage()
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await cdp.send('Page.navigate', { url: base + '/taskwatch' })
    await sleep(1600)
    await evalJs(AUDIT)
    await evalJs(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)}); 'ok'`)
    await sleep(150)
    await evalJs(`(async function(){
      showSession('session-demo-a')
      // 演示会话里还挂着一条「待回答」提问，它按设计占 52vh、会把对话区压到 ~180px，
      // 表单根本放不下。截图时先把那条提问条收起（页面在首页也会这么做），
      // 让画面聚焦本次的新功能；不改页面代码，也不改演示数据。
      var ask = document.getElementById('askBar')
      if (ask) ask.hidden = true
      try { localStorage.removeItem('taskwatch.genuiSent') } catch (e) {}
      await new Promise(function(r){ setTimeout(r, 250) })
      return true
    })()`)

    if (mode === 'fallback') {
      // 坏 JSON 围栏：演示数据里不放坏数据（那会像真 bug），截图时临时插一条。
      await evalJs(`(function(){
        var host = document.createElement('div'); host.className = 'row ai'
        host.appendChild(bubNode('下面这条围栏的 JSON 被截断了（演示）：\\n\\n\\u0060\\u0060\\u0060dsh-ui\\n{"title":"执行前确认","items":[{"type":"text","content":"这条渲染不出来"}\\n\\u0060\\u0060\\u0060', { noFold:true }))
        document.getElementById('log').appendChild(host)
        return true
      })()`)
    }
    if (mode === 'unsupported') {
      // 语法完全合法、只是手机端没有 table：提示措辞必须与「解析失败」分开（v1.8.26）。
      await evalJs(`(function(){
        var host = document.createElement('div'); host.className = 'row ai'
        host.appendChild(bubNode('这张卡里只有表格（演示）：\\n\\n\\u0060\\u0060\\u0060dsh-ui\\n{"title":"发布窗口","items":[{"type":"table","columns":["环境","时间"],"rows":[["生产","今天 18:00"]]}]}\\n\\u0060\\u0060\\u0060', { noFold:true }))
        document.getElementById('log').appendChild(host)
        return true
      })()`)
    }
    if (mode === 'mixed') {
      // 部分节点被丢弃：卡片照画，底部如实说明少了什么。
      await evalJs(`(function(){
        var host = document.createElement('div'); host.className = 'row ai'
        host.appendChild(bubNode('一半能画、一半不能（演示）：\\n\\n\\u0060\\u0060\\u0060dsh-ui\\n{"title":"发布窗口","items":[{"type":"text","content":"表格手机端不画，这行正文照常显示。"},{"type":"table","columns":["环境","时间"],"rows":[["生产","今天 18:00"]]}]}\\n\\u0060\\u0060\\u0060', { noFold:true }))
        document.getElementById('log').appendChild(host)
        return true
      })()`)
    }
    if (mode === 'done') {
      // 填完再提交：选 radio、勾 checkbox、填 input，然后点提交（走真实路径）。
      await evalJs(`(function(){
        var card = document.querySelectorAll('.gu')[document.querySelectorAll('.gu').length - 1]
        var opts = card.querySelectorAll('.gu-opt input')
        var boxes = card.querySelectorAll('.gu-opt input[type=checkbox]')
        for (var i = 0; i < opts.length; i++) if (opts[i].type === 'radio') { opts[i].checked = true; opts[i].dispatchEvent(new Event('change', { bubbles:true })); break }
        if (boxes[0]) { boxes[0].checked = true; boxes[0].dispatchEvent(new Event('change', { bubbles:true })) }
        var inp = card.querySelector('.gu-input')
        inp.value = '今天 18:00'
        inp.dispatchEvent(new Event('input', { bubbles:true }))
        return true
      })()`)
      await sleep(150)
      await evalJs(`(function(){
        var card = document.querySelectorAll('.gu')[document.querySelectorAll('.gu').length - 1]
        card.querySelector('.gu-btn').click()
        return true
      })()`)
      await sleep(400)
    }

    // 滚到目标卡片（表单 / 回退块），留 2px 上边距。提交消息会重新唤起「待回答」
    // 提问条，所以滚动前再收一次 —— 否则对话区又被压到 ~180px。
    await evalJs(`(function(){
      var ask = document.getElementById('askBar'); if (ask) ask.hidden = true
      var cards = document.querySelectorAll('.gu')
      var fb = document.querySelectorAll('.gu-fallback')
      var el = ${mode === 'fallback' || mode === 'unsupported' ? '(fb[fb.length - 1])' : '(cards[cards.length - 1])'}
      return __scrollTo(el)
    })()`)
    await sleep(160)
    const a = JSON.parse(await evalJs('(function(){ return JSON.stringify(__audit()) })()'))

    check(`[${name}] 演示标记仍在（不把演示数据说成真实状态）`, a.sub.indexOf('演示数据 · 非真实状态') >= 0, a.sub)
    check(`[${name}] 主题生效`, a.theme === scheme, a.theme)

    if (mode === 'form') {
      check(`[${name}] 表单卡片在，标题与提交键都是演示里的那条`, a.cardFound && a.title === '执行前确认' && a.btnText === '确认并发送', JSON.stringify({ title:a.title, btn:a.btnText }))
      check(`[${name}] 五类组件都在：2 单选 + 2 复选 + 输入 + 多行`, a.opts === 4 && a.inputFont === 16 && a.areaFont === 16, JSON.stringify({ opts:a.opts, input:a.inputFont, area:a.areaFont }))
      check(`[${name}] 可点行 ≥44px、提交键 ≥44px 高且撑满宽度`, a.minOptH >= 44 && a.btnH >= 44 && a.btnW >= 320, JSON.stringify({ minOpt:a.minOptH, btnW:a.btnW, btnH:a.btnH }))
      check(`[${name}] 未填完时提交禁用，进度「已填 0/3」`, a.btnDisabled === true && a.progress === '已填 0/3', JSON.stringify({ disabled:a.btnDisabled, progress:a.progress }))
      check(`[${name}] 卡片整块在视口内（标题与提交键同屏）`, a.cardTop >= a.logTop - 1 && a.cardBottom <= a.logBottom + 1, JSON.stringify({ top:a.cardTop, bottom:a.cardBottom, logBottom:a.logBottom, h:a.cardH }))
      check(`[${name}] 正文 / 选项 / 进度对比度 ≥ 4.5`, a.bodyContrast >= 4.5 && a.optionContrast >= 4.5 && a.progressContrast >= 4.5 && a.labelContrast >= 4.5,
        JSON.stringify({ body:a.bodyContrast, option:a.optionContrast, progress:a.progressContrast, label:a.labelContrast }))
      check(`[${name}] 390 宽无横向溢出`, a.docW <= a.iw + 1 && a.logW <= a.iw + 1 && a.cardW <= a.iw - 20, JSON.stringify({ iw:a.iw, doc:a.docW, log:a.logW, card:a.cardW }))
    } else if (mode === 'fallback') {
      check(`[${name}] 回退块在：提示一行 + 代码块（提示在上，lang 仍是 dsh-ui）`,
        a.fallbackFound && a.fallbackNote === HINT && a.fallbackCode && a.fallbackCodeLang === 'dsh-ui' && a.fallbackNoteAbove,
        JSON.stringify({ found:a.fallbackFound, note:a.fallbackNote, code:a.fallbackCode, lang:a.fallbackCodeLang, above:a.fallbackNoteAbove }))
      check(`[${name}] 提示行对比度 ≥ 4.5`, a.noteContrast >= 4.5, String(a.noteContrast))
      check(`[${name}] 回退块不撑宽页面`, a.docW <= a.iw + 1 && a.fallbackW <= a.iw - 20, JSON.stringify({ doc:a.docW, w:a.fallbackW }))
    } else if (mode === 'unsupported') {
      check(`[${name}] 合法 JSON 不支持时不说「解析失败」`,
        a.fallbackFound && /^手机端不支持 /.test(a.fallbackNoteText) && a.fallbackNoteText.indexOf('解析失败') < 0 && a.fallbackCode,
        JSON.stringify({ note:a.fallbackNoteText, code:a.fallbackCode }))
      check(`[${name}] 提示行对比度 ≥ 4.5、回退块不撑宽`,
        a.noteContrast >= 4.5 && a.docW <= a.iw + 1 && a.fallbackW <= a.iw - 20,
        JSON.stringify({ contrast:a.noteContrast, doc:a.docW, w:a.fallbackW }))
    } else if (mode === 'mixed') {
      check(`[${name}] 能画的照画（标题与正文都在）`,
        a.cardFound && a.title === '发布窗口' && !!a.skipNote,
        JSON.stringify({ card:a.cardFound, title:a.title, skip:a.skipNote }))
      check(`[${name}] 底部如实说明「已隐藏 1 个…：table」`,
        a.skipNote === '已隐藏 1 个手机端不支持的组件：table', JSON.stringify(a.skipNote))
      check(`[${name}] 说明行对比度 ≥ 4.5、不撑宽`,
        a.skipContrast >= 4.5 && a.docW <= a.iw + 1 && a.cardW <= a.iw - 20,
        JSON.stringify({ contrast:a.skipContrast, doc:a.docW, card:a.cardW }))
    } else if (mode === 'done') {
      check(`[${name}] 提交后整卡置灰、按钮禁用并显示「已提交」`,
        a.isDone && a.btnDisabled === true && a.btnText === '已提交' && a.progress === '',
        JSON.stringify({ done:a.isDone, disabled:a.btnDisabled, btn:a.btnText, progress:a.progress }))
      check(`[${name}] 置灰态仍读得清（选项文字对比度 ≥ 3.5）`, a.optionContrast >= 3.5, String(a.optionContrast))
      check(`[${name}] 置灰态不撑宽页面`, a.docW <= a.iw + 1 && a.cardW <= a.iw - 20, JSON.stringify({ doc:a.docW, card:a.cardW }))
    }

    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    console.log(`  ${name}.png ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} theme=${a.theme} ` +
      `card=${a.cardW}x${a.cardH} 选项行=${a.minOptH} 按钮=${a.btnW}x${a.btnH}/${a.btnFont}px ` +
      `对比度 正文${a.bodyContrast} 选项${a.optionContrast} 进度${a.progressContrast} 置灰${a.optionContrast}`)
    console.log(`    进度「${a.progress}」 按钮「${a.btnText}」 disabled=${a.btnDisabled} 卡片 top=${a.cardTop} bottom=${a.cardBottom} logBottom=${a.logBottom}`)
    return a
  }

  console.log('\n[1] 确认表单（亮色，390×844）')
  await shot('genui-form', { scheme: 'light', mode: 'form' })

  console.log('\n[2] 确认表单（暗色，390×844）')
  await shot('genui-form-dark', { scheme: 'dark', mode: 'form' })

  console.log('\n[3] 坏 JSON 回退（亮色，390×844）')
  await shot('genui-fallback', { scheme: 'light', mode: 'fallback' })

  console.log('\n[4] 已提交的置灰态（亮色，390×844，自查用）')
  await shot('genui-form-done', { scheme: 'light', mode: 'done' })

  console.log('\n[5] 合法但不支持的组件（亮色，390×844）')
  await shot('genui-unsupported', { scheme: 'light', mode: 'unsupported' })

  console.log('\n[6] 部分节点被丢弃的卡片（亮色，390×844）')
  await shot('genui-mixed', { scheme: 'light', mode: 'mixed' })

  try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
  if (cdp) cdp.close()
  browser.close()

  if (failures.length) {
    console.error('\n截图自检失败：\n  ' + failures.join('\n  '))
    process.exitCode = 1
  } else {
    console.log('\n六张图通过：尺寸/禁用/进度/对比度/无横向溢出/措辞分流。')
    console.log('输出目录：' + OUT)
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
