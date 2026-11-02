#!/usr/bin/env node
/**
 * v1.8.18 会话抽屉（☰ → 会话）截图。
 *
 * 真 Chrome + CDP，DPR2，390 宽。页面是 docs/demo.html（由 lib/page.html 生成，
 * 取数换成演示假数据），不联网、不读本机文件。
 *
 * 三张图：
 *   1. sheet-new       390×1200 亮色，抽屉顶部：工作台 / 操作 前置后的整段动作区
 *   2. sheet-new-dark  同上暗色（分组标题、发丝分割线、pill 边界都得在暗底上站得住）
 *   3. sheet-390       390×844 亮色，真实首屏高度（第一眼能看到的就这么多）
 *
 * 每张都做量化自检：无横向溢出、pill ≥44px、两个分组标题之间仍夹着 3 个入口、
 * 抽屉里没有 [data-act="poker"]，并打印各段在抽屉里的纵向位置，供"头重不重"判断。
 *
 * 用法：node scripts/shoot-sheet.mjs
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(ROOT, 'docs', 'demo.html')
const OUT = join(ROOT, '..', '_ui-review', 'round23')
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
  const html = readFileSync(DEMO, 'utf8')
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-sheet-shots-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=2',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const port = await waitPort(profile, child)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)

  let cdp = null
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }

  async function shot(name, { width = 390, height = 1200, scheme = 'light' } = {}) {
    await newPage()
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await cdp.send('Page.navigate', { url: base + '/taskwatch' })
    await sleep(1400)
    await evalJs(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)}); 'ok'`)
    const audit = JSON.parse(await evalJs(`(async function(){
      await openSessions();
      await new Promise(function(r){ setTimeout(r, 500) });
      var card=document.querySelector('#sheet .card');
      card.scrollTop=0;
      await new Promise(function(r){ setTimeout(r, 120) });
      var all=[].slice.call(card.querySelectorAll('*'));
      function idx(el){ return el ? all.indexOf(el) : -1 }
      var h3s=[].slice.call(card.querySelectorAll('h3'));
      var wb=null,ops=null;
      for(var i=0;i<h3s.length;i++){ var t=h3s[i].textContent.trim(); if(t==='工作台') wb=h3s[i]; if(t==='操作') ops=h3s[i] }
      var pills=[].slice.call(card.querySelectorAll('.pill'));
      var between=0;
      for(var p=0;p<pills.length;p++){ var pi=idx(pills[p]); if(pi>idx(wb)&&pi<idx(ops)) between++ }
      var head=card.querySelector('.sheet-head');
      function y(el){ if(!el) return -1; var r=el.getBoundingClientRect(); return Math.round(r.top - card.getBoundingClientRect().top + card.scrollTop) }
      var vis=pills.filter(function(b){var r=b.getBoundingClientRect();return r.height>0});
      var small=vis.filter(function(b){return b.getBoundingClientRect().height<43.5}).map(function(b){return b.getAttribute('data-act')});
      var listEl=card.querySelector('#sessionList');
      var search=card.querySelector('.sheet-search');
      return JSON.stringify({
        theme: document.documentElement.getAttribute('data-theme'),
        poker: card.querySelectorAll('[data-act="poker"]').length,
        between: between,
        order:{ workbench:idx(wb), actions:idx(ops), search:idx(search), list:idx(listEl) },
        y:{ head:y(head), workbench:y(wb), actions:y(ops), search:y(search), list:y(listEl),
            firstSession:y(card.querySelector('.session-group')) },
        gapHead: Math.round(wb.getBoundingClientRect().top - head.getBoundingClientRect().bottom),
        gapBetween: Math.round(ops.getBoundingClientRect().top - pills[2].getBoundingClientRect().bottom),
        pillCount: vis.length,
        small: small,
        scroll: { content: card.scrollHeight, visible: card.clientHeight, at: card.scrollTop },
        docW: document.documentElement.scrollWidth,
        cardW: Math.round(card.getBoundingClientRect().width),
        iw: innerWidth,
        title: document.querySelector('#sheet .sheet-head h3').textContent.trim(),
        listText: listEl.textContent.slice(0,40)
      })
    })()`))

    const o = audit.order
    check(name + ' 主题生效', audit.theme === scheme, audit.theme)
    check(name + ' 工作台 / 操作 都在列表之前',
      o.workbench > -1 && o.actions > -1 && o.list > -1 && o.workbench < o.list && o.actions < o.list,
      JSON.stringify(o))
    check(name + ' 没有 [data-act="poker"]', audit.poker === 0, String(audit.poker))
    check(name + ' 两标题之间夹着 3 个入口', audit.between === 3, String(audit.between))
    check(name + ' pill ≥44px', audit.small.length === 0, JSON.stringify(audit.small))
    check(name + ' 无横向溢出', audit.docW <= audit.iw + 1 && audit.cardW <= audit.iw + 1,
      JSON.stringify({ docW: audit.docW, cardW: audit.cardW, iw: audit.iw }))

    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    console.log(`  ${name}.png ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} theme=${audit.theme} `
      + `viewport=${width}x${height} content=${audit.scroll.content} visible=${audit.scroll.visible}`)
    console.log(`    纵向：head=${audit.y.head} 工作台=${audit.y.workbench} 操作=${audit.y.actions} `
      + `搜索=${audit.y.search} 列表=${audit.y.list} 首条会话=${audit.y.firstSession}`)
    console.log(`    间距：标题栏→工作台 ${audit.gapHead}px，末个入口→操作 ${audit.gapBetween}px，pill ${audit.pillCount} 个`)
    return audit
  }

  console.log('\n[1] 抽屉顶部（亮色，390×1200）')
  await shot('sheet-new', { width: 390, height: 1200, scheme: 'light' })

  console.log('\n[2] 抽屉顶部（暗色，390×1200）')
  const dark = await shot('sheet-new-dark', { width: 390, height: 1200, scheme: 'dark' })
  check('暗色下标题与内容都在', /^会话\d*$/.test(dark.title) && dark.listText.length > 0, JSON.stringify({ t: dark.title }))

  console.log('\n[3] 真实首屏（390×844）')
  const small = await shot('sheet-390', { width: 390, height: 844, scheme: 'light' })
  check('首屏至少能看到「工作台」三条入口', small.y.workbench > 0 && small.scroll.visible > small.y.workbench,
    JSON.stringify(small.y))

  try {
    copyFileSync(join(OUT, 'sheet-390.png'), join(ROOT, 'docs', 'screenshots', 'current', 'drawer.png'))
    console.log('  已同步 docs/screenshots/current/drawer.png')
  } catch (e) {
    console.log('  跳过同步仓库截图：' + (e && e.message))
  }

  try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
  if (cdp) cdp.close()
  browser.close()

  if (failures.length) {
    console.error('\n截图自检失败：\n  ' + failures.join('\n  '))
    process.exitCode = 1
  } else {
    console.log('\n三张会话抽屉截图通过：结构顺序、无 poker、无横向溢出、按钮 ≥44px。')
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
