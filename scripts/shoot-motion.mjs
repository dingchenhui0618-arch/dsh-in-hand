#!/usr/bin/env node
/**
 * 首屏动效的「真渲染」录像（v1.10.3）。
 *
 * 静态截图证明不了动效：这里从页面开始加载就抓帧，录下虎鲸入场（淡入 + 12px 声纳）
 * 与「在跑」几行的第一次上浮，再交给 scripts/build-gif.py 合成 GIF。
 *
 * 用法：node scripts/shoot-motion.mjs
 *   输出 docs/assets/motion-entry.gif（720 宽）与 _ui-review/round37/ 下的帧 / 两张定格。
 *   和 make-gifs 一样用 Chrome headless + CDP；本机没有 Chrome 就退出 1。
 *   合成需要 Pillow：PYTHON 指向装了 Pillow 的解释器（默认 python）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDevToolsPort } from './devtools-port.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(ROOT, 'docs', 'demo.html')
const OUT_ASSETS = join(ROOT, 'docs', 'assets')
const OUT_REVIEW = join(ROOT, '..', '_ui-review', 'round37')
const PYTHON = process.env.PYTHON || 'python'
const TOTAL_MS = 3000
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
  process.exit(1)
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
  mkdirSync(OUT_REVIEW, { recursive: true })
  mkdirSync(OUT_ASSETS, { recursive: true })
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
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-motion-shot-'))
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
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

  const dir = join(OUT_REVIEW, 'frames-motion')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  await cdp.send('Page.navigate', { url: base + '/taskwatch?motion=1' })
  // 等页面加载完（图标、字体都到位），再把入场重放一遍：
  // 去掉 .boot → 强制 reflow → 加回 .boot，动画从第 0ms 重新开始。
  // 这样每一帧都对得上时间轴，而不是赌导航与抓帧之间的那几十毫秒。
  await sleep(1400)
  // 0.45 倍慢放：320ms 的入场在 ~7fps 的抓帧下只剩两帧，慢放后才看得清。
  // GIF 的播放时长按真实抓帧时间算，所以片子里看到的是慢动作（回复里会注明）。
  await cdp.send('Animation.enable')
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.45 })
  await cdp.send('Runtime.evaluate', {
    expression: `(function(){
      var hero=document.querySelector('.home-hero');
      if (hero) { hero.classList.remove('boot'); void hero.offsetWidth; hero.classList.add('boot'); }
      if (typeof homeRunEntered !== 'undefined') { homeRunEntered = false; renderHomeRun(); }
      window.scrollTo(0, 0);
      return 'replay';
    })()`,
    returnByValue: true,
  }).catch(() => {})
  const t0 = Date.now()
  const frames = []
  while (Date.now() - t0 < TOTAL_MS) {
    const png = await cdp.send('Page.captureScreenshot',
      { format: 'jpeg', quality: 90, optimizeForSpeed: true })
    const file = 'f' + String(frames.length).padStart(3, '0') + '.jpg'
    writeFileSync(join(dir, file), Buffer.from(png.data, 'base64'))
    frames.push({ file, t: Date.now() - t0 })
    await sleep(30)
  }
  writeFileSync(join(dir, 'timings.json'), JSON.stringify(frames))
  const fps = frames.length / ((frames[frames.length - 1].t - frames[0].t) / 1000)
  console.log(`帧 ${frames.length} 张，实测 ${fps.toFixed(1)} fps，跨度 ${((frames[frames.length - 1].t - frames[0].t) / 1000).toFixed(2)}s`)
  console.log('帧目录 ' + dir)

  // 两张定格：入场中段（声纳最明显）与落定后 —— 人工看图用，不进 GIF。
  for (const [name, idx] of [['entry-mid', Math.min(2, frames.length - 1)], ['entry-settled', frames.length - 1]]) {
    const src = join(dir, frames[idx].file)
    writeFileSync(join(OUT_REVIEW, name + '.jpg'), readFileSync(src))
  }
  writeFileSync(join(OUT_REVIEW, 'timings.json'), JSON.stringify(frames))

  try { await browser.send('Target.closeTarget', { targetId }) } catch (e) {}
  cdp.close()
  browser.close()

  const out = join(OUT_ASSETS, 'motion-entry.gif')
  const py = spawnSync(PYTHON, [join(ROOT, 'scripts', 'build-gif.py'), dir, out, OUT_REVIEW,
    '--width', '720', '--max-mb', '2.5'], { encoding: 'utf8' })
  if (py.status !== 0) {
    console.error('GIF 合成失败（' + PYTHON + '）：\n' + ((py.stderr || '') + (py.stdout || '')).slice(0, 1500))
    process.exitCode = 1
  } else {
    process.stdout.write(py.stdout || '')
    console.log('已写出 ' + out)
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch (e) {} }
  if (server) server.close()
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch (e) {} }
}
