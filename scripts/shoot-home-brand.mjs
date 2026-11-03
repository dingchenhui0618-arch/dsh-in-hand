#!/usr/bin/env node
/**
 * v1.8.20 首页品牌行截图。
 *
 * 真 Chrome + CDP，DPR2，390 宽。页面是 docs/demo.html（由 lib/page.html 生成，
 * 取数换成演示假数据），不联网、不读本机文件。
 *
 * 三张图：
 *   1. home-brand       390×844 亮色，默认演示数据（有待办 + 在跑）
 *   2. home-brand-dark  同上暗色（看图标圆角在暗底上有没有白边/脏边）
 *   3. home-idle        390×844 亮色，注入「无待办、无在跑」的空闲态
 *
 * 每张都做量化自检：品牌行在 #home 最上方、图标 28px、整行约 40px、
 * 不与标题相撞、与第一张待办卡的间距、无横向溢出、首页品牌行没有动效、
 * 计数行不含「子代理」。
 *
 * 用法：node scripts/shoot-home-brand.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(ROOT, 'docs', 'demo.html')
const OUT = join(ROOT, '..', '_ui-review', 'round24')
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
  const icon = readFileSync(join(ROOT, 'lib', 'icons', 'icon-192.png'))
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    // 首页品牌图与对话页空态用同一张图标；演示页不连真实中继，这里补上静态文件。
    // 演示页从 v1.8.24 起用相对路径（../lib/icons/…），两个路径都给同一张 PNG。
    if (path === '/taskwatch/icon-192.png' || path === '/lib/icons/icon-192.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(icon)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-home-brand-shots-'))
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

  // 首页品牌行的通用量测。idle=true 时先注入「无待办、无在跑」的假数据。
  async function auditHome(theme, { idle = false } = {}) {
    if (idle) {
      await evalJs(`(async function(){
        lastData = {generatedAt:Date.now(), offline:false, errors:[],
          totals:{sessions:7,running:0,jobs:0,jobsRunning:0,subagents:0,workflows:1,pending:0},
          today:{since:Date.now()-21600000,turns:0,steps:0,sessions:0,partial:false},
          pending:[],
          sessions:DEMO.sessions.map(function(s){ return Object.assign({}, s, {running:false, turnStartedAt:0}) }),
          jobs:[], subagents:[], workflows:DEMO.workflows};
        renderHome();
        await new Promise(function(r){ setTimeout(r, 250) });
        return 'ok'
      })()`)
    }
    return JSON.parse(await evalJs(`(function(){
      var home=document.getElementById('home');
      var brand=home.querySelector('.home-brand');
      var logo=brand?brand.querySelector('img.brand'):null;
      var header=document.querySelector('header');
      var headerRect=header?header.getBoundingClientRect():null;
      var br=brand?brand.getBoundingClientRect():null;
      var lr=logo?logo.getBoundingClientRect():null;
      var todo=home.querySelector('#homeTodo');
      var firstCard=home.querySelector('#homeTodo [data-pending-id]');
      var counts=home.querySelector('#homeCounts');
      var cs=logo?getComputedStyle(logo):null;
      var last=home.lastElementChild;
      return JSON.stringify({
        theme: document.documentElement.getAttribute('data-theme'),
        brandFound: !!logo,
        brandLoaded: !!logo && logo.complete && logo.naturalWidth > 0,
        brandSrc: logo?logo.getAttribute('src'):'',
        brandAlt: logo?logo.getAttribute('alt'):null,
        brandName: brand?brand.textContent.replace(/\\s+/g,' ').trim():'',
        firstChild: home.firstElementChild === brand,
        logoW: lr?Math.round(lr.width):0,
        logoH: lr?Math.round(lr.height):0,
        rowH: br?Math.round(br.height):0,
        rowTop: br?Math.round(br.top):0,
        rowLeft: br?Math.round(br.left):0,
        headerBottom: headerRect?Math.round(headerRect.bottom):null,
        gapHeaderBrand: br&&headerRect?Math.round(br.top-headerRect.bottom):null,
        todoTop: todo?Math.round(todo.getBoundingClientRect().top):null,
        gapBrandTodo: br&&todo?Math.round(todo.getBoundingClientRect().top-br.bottom):null,
        firstCardTop: firstCard?Math.round(firstCard.getBoundingClientRect().top):null,
        gapBrandCard: br&&firstCard?Math.round(firstCard.getBoundingClientRect().top-br.bottom):null,
        badge: brand?brand.querySelector('.name')?getComputedStyle(brand.querySelector('.name')).fontSize:'':null,
        badgeColor: brand?brand.querySelector('.name')?getComputedStyle(brand.querySelector('.name')).color:'':null,
        logoRadius: cs?cs.borderRadius:'',
        logoBg: cs?cs.backgroundColor:'',
        logoAnim: cs?cs.animationName:'',
        homeAnim: brand?getComputedStyle(brand).animationName:'',
        idle: !!home.querySelector('#homeRun .home-idle'),
        runs: home.querySelectorAll('#homeRun .runrow').length,
        cards: home.querySelectorAll('#homeTodo [data-pending-id]').length,
        title: document.getElementById('sessTitle').textContent.trim(),
        counts: counts?counts.textContent:'',
        countsHidden: counts?counts.hidden:true,
        countHasSub: counts?counts.textContent.indexOf('子代理')>=0:false,
        iw: innerWidth,
        docW: document.documentElement.scrollWidth,
        bodyW: document.body.scrollWidth,
        homeW: home.scrollWidth,
        scrollH: home.scrollHeight,
        viewH: home.clientHeight,
        lastTag: last?last.id||last.className:''
      })
    })()`))
  }

  async function shot(name, { width = 390, height = 844, scheme = 'light', idle = false } = {}) {
    await newPage()
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await cdp.send('Page.navigate', { url: base + '/taskwatch' })
    await sleep(1500)
    await evalJs(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)}); 'ok'`)
    await sleep(120)
    const a = await auditHome(scheme, { idle })

    check(name + ' 主题生效', a.theme === scheme, a.theme)
    check(name + ' 品牌行在 #home 最上方（28px 虎鲸 + 掌上 DSH）',
      a.brandFound && a.brandLoaded && a.brandSrc === '../lib/icons/icon-192.png' && a.brandAlt === '' &&
      a.brandName === '掌上 DSH' && a.firstChild && a.logoW === 28 && a.logoH === 28,
      JSON.stringify({ found: a.brandFound, src: a.brandSrc, alt: a.brandAlt, name: a.brandName,
        first: a.firstChild, w: a.logoW, h: a.logoH }))
    check(name + ' 整行约 40px，左对齐，不压住标题',
      a.rowH >= 36 && a.rowH <= 44 && a.gapHeaderBrand >= 0 && a.rowLeft < 30,
      JSON.stringify({ rowH: a.rowH, gapHeader: a.gapHeaderBrand, left: a.rowLeft }))
    check(name + ' 与待办区只用间距令牌，没有分割线',
      a.gapBrandTodo !== null && a.gapBrandTodo >= 4 && a.gapBrandTodo <= 20,
      JSON.stringify({ gapBrandTodo: a.gapBrandTodo, gapBrandCard: a.gapBrandCard }))
    check(name + ' 首页品牌行没有动效（breathe 不带过来）',
      a.logoAnim === 'none' && a.homeAnim === 'none',
      JSON.stringify({ logo: a.logoAnim, row: a.homeAnim }))
    check(name + ' 计数行不含「子代理」',
      !a.countHasSub, JSON.stringify(a.counts))
    check(name + ' 390 宽无横向溢出',
      a.docW <= a.iw + 1 && a.bodyW <= a.iw + 1 && a.homeW <= a.iw + 1,
      JSON.stringify({ iw: a.iw, doc: a.docW, body: a.bodyW, home: a.homeW }))
    if (idle) {
      check(name + ' 空闲态：无待办、无在跑，品牌行仍在',
        a.cards === 0 && a.runs === 0 && a.idle && a.title.indexOf('暂时没有需要你的') >= 0 && a.brandFound,
        JSON.stringify({ cards: a.cards, runs: a.runs, idleText: a.idle, title: a.title }))
    }

    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    console.log(`  ${name}.png ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} theme=${a.theme}`)
    console.log(`    品牌行 top=${a.rowTop} h=${a.rowH} 图标=${a.logoW}x${a.logoH} 圆角=${a.logoRadius} 底色=${a.logoBg}`)
    console.log(`    间距：标题底→品牌行 ${a.gapHeaderBrand}px，品牌行→待办区 ${a.gapBrandTodo}px，` +
      `→首张卡 ${a.gapBrandCard}px；首张卡 top=${a.firstCardTop}`)
    console.log(`    文案：${a.brandName} / ${a.badge} / ${a.badgeColor}`)
    console.log(`    计数：${a.countsHidden ? '（隐藏）' : a.counts}`)
    return a
  }

  console.log('\n[1] 首页品牌行（亮色，390×844）')
  const light = await shot('home-brand', { scheme: 'light' })
  check('亮色首页仍能看到第一张待办卡（品牌行没有把它挤出首屏）',
    light.firstCardTop !== null && light.firstCardTop < 844,
    JSON.stringify({ firstCardTop: light.firstCardTop }))

  console.log('\n[2] 首页品牌行（暗色，390×844）')
  await shot('home-brand-dark', { scheme: 'dark' })

  console.log('\n[3] 首页空闲态（亮色，390×844）')
  await shot('home-idle', { scheme: 'light', idle: true })

  try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
  if (cdp) cdp.close()
  browser.close()

  if (failures.length) {
    console.error('\n截图自检失败：\n  ' + failures.join('\n  '))
    process.exitCode = 1
  } else {
    console.log('\n三张首页截图通过：品牌行位置/尺寸/间距、无动效、无子代理计数、无横向溢出。')
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
