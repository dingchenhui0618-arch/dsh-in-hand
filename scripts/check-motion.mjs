#!/usr/bin/env node
/**
 * 首屏虎鲸动效（v1.10.3）的自检。
 *
 * 断言的是「体感」这一层的硬事实，不是好看：
 *   1. 入场由 JS 门控（.home-hero.boot）：动画名里同时有 heroIn / heroRing / whaleFloat，
 *      而且入场之后仍然是 whaleFloat（不是一帧就停）；
 *   2. 动效跑完不改变布局：图标仍 52px、品牌块高度不变（只动 transform/opacity/box-shadow）；
 *   3. prefers-reduced-motion: reduce 下全部压成静态，图标 opacity 仍是 1（内容不许被藏）；
 *   4. 没有 JS 时页面完整：没有 .boot 类、图标可见、品牌块照样占位；
 *   5. 对话空态的虎鲸带 .appear（JS 加），动画名里有 breathe + heroRing —— 只在进场响一次。
 *
 * 用 Chrome headless + CDP 打开 docs/demo.html（与 page.html 同源构建），
 * 本机没有 Chrome 就 SKIP；不联网、不碰真实中继。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDevToolsPort } from './devtools-port.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(ROOT, 'docs', 'demo.html')
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
  console.log('SKIP 首屏动效自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
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
  close() { try { this.ws.close() } catch (e) {} }
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
    const port = readDevToolsPort(file)
    if (port) return Number(port)
    await sleep(100)
  }
  throw new Error('等不到 DevToolsActivePort')
}

let server = null
let child = null
let profile = ''
try {
  const html = readFileSync(DEMO, 'utf8')
  const iconPng = readFileSync(join(ROOT, 'lib', 'icons', 'icon-192.png'))
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (path === '/taskwatch/icon-192.png' || path === '/lib/icons/icon-192.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(iconPng)
      return
    }
    res.writeHead(404); res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = 'http://127.0.0.1:' + server.address().port + '/taskwatch'

  profile = mkdtempSync(join(tmpdir(), 'tw-motion-chrome-'))
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
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result && r.result.value
  }
  // CI 的 Windows runner 系统层就是「减少动态效果」，Chrome 会跟着报 reduce；
  // 不显式钉成 no-preference 的话，这里量到的是 reduced-motion 分支，而不是入场本身。
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  })
  const load = async () => {
    await cdp.send('Page.navigate', { url: url + '?m=' + Date.now() })
    // 等到 .boot 出现（脚本在首帧就加）—— 最多 1.5s
    const deadline = Date.now() + 1500
    let st = null
    while (Date.now() < deadline) {
      st = await evalJs(`(function(){
        var h=document.querySelector('.home-hero');
        return h && h.classList.contains('boot') ? 'boot' : ''
      })()`).catch(() => '')
      if (st === 'boot') break
      await sleep(50)
    }
    return st === 'boot'
  }

  const snap = () => evalJs(`(function(){
    var hero=document.querySelector('.home-hero');
    var logo=hero?hero.querySelector('img.logo'):null;
    var hn=hero?hero.querySelector('.hn'):null;
    var hs=hero?hero.querySelector('.hs'):null;
    function anim(el){return el?String(getComputedStyle(el).animationName||''):''}
    function op(el){return el?Number(getComputedStyle(el).opacity):null}
    function rect(el){var r=el?el.getBoundingClientRect():null;return r?{w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top)}:null}
    return {
      boot:!!hero && hero.classList.contains('boot'),
      logo:anim(logo), hn:anim(hn), hs:anim(hs),
      logoOpacity:op(logo),
      // 布局尺寸用 offsetWidth（不受 transform 影响），rect 只用来量位置
      logoW:logo?logo.offsetWidth:0, logoH:logo?logo.offsetHeight:0,
      heroH:rect(hero)?rect(hero).h:0, heroTop:rect(hero)?rect(hero).top:0,
      logoShadow:String(logo?getComputedStyle(logo).boxShadow:''),
    }
  })()`)

  console.log('\n[390] 首页虎鲸：入场与漂浮')
  const booted = await load()
  check('JS 门控入场：.home-hero 带上 .boot', booted)
  const first = await snap()
  check('入场时三条动画都挂着：heroIn + heroRing + whaleFloat',
    /heroIn/.test(first.logo) && /heroRing/.test(first.logo) && /whaleFloat/.test(first.logo),
    JSON.stringify({ logo: first.logo }))
  check('名字与状态行也参与入场（heroIn）', /heroIn/.test(first.hn) && /heroIn/.test(first.hs),
    JSON.stringify({ hn: first.hn, hs: first.hs }))
  check('图标仍是 52×52（只动 transform，不改变布局）',
    first.logoW === 52 && first.logoH === 52, JSON.stringify({ w: first.logoW, h: first.logoH }))

  await sleep(1500)
  const settled = await snap()
  check('入场是一次性的：1.3s 后 .boot 摘掉，动画里只剩 whaleFloat',
    settled.boot === false && /whaleFloat/.test(settled.logo) && !/heroIn/.test(settled.logo),
    JSON.stringify({ boot: settled.boot, logo: settled.logo }))
  check('动画跑完内容完全可见：opacity=1', settled.logoOpacity === 1, String(settled.logoOpacity))
  check('布局没有位移：品牌块高度 / 顶部与入场时一致',
    settled.heroH === first.heroH && settled.heroTop === first.heroTop,
    JSON.stringify({ before: [first.heroH, first.heroTop], after: [settled.heroH, settled.heroTop] }))

  console.log('\n[reduced-motion] 关掉动效之后')
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await cdp.send('Page.reload')
  await sleep(700)
  const rm = await snap()
  check('图标 / 名字 / 状态行都没有动画', rm.logo === 'none' && rm.hn === 'none' && rm.hs === 'none',
    JSON.stringify({ logo: rm.logo, hn: rm.hn, hs: rm.hs }))
  check('压成瞬变后图标仍然可见（不许把内容藏起来）', rm.logoOpacity === 1 && rm.heroH > 0,
    JSON.stringify({ opacity: rm.logoOpacity, heroH: rm.heroH }))

  console.log('\n[无 JS] 静态兜底')
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  })
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: true })
  await cdp.send('Page.reload')
  await sleep(700)
  const nojs = await snap()
  check('没有 .boot 类（入场只由 JS 触发）', nojs.boot === false)
  check('没有 JS 时图标照样完整可见', nojs.logoOpacity === 1 && nojs.heroH > 0 && nojs.logoW === 52,
    JSON.stringify({ opacity: nojs.logoOpacity, heroH: nojs.heroH, w: nojs.logoW }))

  console.log('\n[空态] 对话空态的虎鲸')
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: false })
  await cdp.send('Page.reload')
  await sleep(900)
  const empty = await evalJs(`(async function(){
    // 空态只有在会话视图里才会现身；这里直接把 log 打开，不造假数据。
    document.getElementById('log').hidden = false;
    document.getElementById('home').hidden = true;
    renderEmpty();
    var b=document.querySelector('#log .empty .brand');
    if (b && !b.complete) { await new Promise(function(r){ b.onload = r; b.onerror = r }) }
    return {
      one:document.querySelectorAll('#log .empty .brand').length===1,
      cls:b?String(b.className):'',
      anim:b?String(getComputedStyle(b).animationName||''):'',
      w:b?Math.round(b.getBoundingClientRect().width):0,
      h:b?Math.round(b.getBoundingClientRect().height):0,
      natural:b?b.naturalWidth:0,
      src:b?b.getAttribute('src'):''
    }
  })()`)
  check('空态虎鲸由 JS 标记 .appear（进场声纳只响一次）', empty.one && /(^|\s)appear(\s|$)/.test(empty.cls),
    JSON.stringify({ cls: empty.cls }))
  check('空态虎鲸：breathe + heroRing，64×64',
    /breathe/.test(empty.anim) && /heroRing/.test(empty.anim) &&
    empty.w === 64 && empty.h === 64 && empty.natural > 0,
    JSON.stringify({ anim: empty.anim, w: empty.w, h: empty.h, natural: empty.natural }))
  check('空态图标来自 /taskwatch 图标（不多一次请求）', /icon-192\.png$/.test(String(empty.src)), empty.src)

  console.log(`\n首屏动效：${passed} 通过 / ${failed} 失败`)
  try { await browser.send('Target.closeTarget', { targetId }) } catch (e) {}
  cdp.close()
  browser.close()
  if (failed) process.exitCode = 1
} finally {
  if (child && child.exitCode === null) child.kill()
  if (server) server.close()
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch (e) {} }
}
