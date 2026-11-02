#!/usr/bin/env node
/**
 * v1.8.21 README 首屏 hero（1280×560，明暗各一张）。
 *
 * 左边是**仓库里已有的真机截图**：docs/screenshots/current/home-pending(-dark).png，
 * 由 scripts/make-shots.mjs 用真 Chrome + docs/demo.html 拍出来（390×844 @DPR2）；
 * 这里只做等比裁切（顶部 628 CSS px：标题行 + 「演示数据 · 非真实状态」条 + 待批准卡 +
 * 「还有 1 件」+ 「在跑」三条），下沿正好落在最后一条的边框上，不把任何一行切一半。
 * 不重画、不修图、不补字。
 *
 * 右边是排版文字，颜色全部取 lib/tokens.css 里那套令牌：
 *   亮 #fff 底 / #0f1115 字 / #61666b 次要 / #4176e6 只当三枚 5px 圆点；
 *   暗 #151517 底 / #f9fafb 字 / #adb2b8 次要。
 * 没有渐变、没有辉光、没有 3D、没有漂浮卡片——只留 1px 边和一枚极浅的投影。
 *
 * 做法：真 Chrome headless + CDP，DPR2 渲染后按 clip.scale=0.5 缩到 1280×560，
 * 等于「2 倍渲染再降采样」——小字不会糊，边缘有真正的抗锯齿。
 *
 * 用法：node scripts/make-hero.mjs
 * 输出：docs/assets/_hero-zh-<scheme>.png（随后用 Pillow 转 webp，见脚本末尾）
 *      同时把同名 PNG 放进 ..\_ui-review\round25\ 供人工看。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs', 'screenshots', 'current')
const OUT_ASSETS = join(ROOT, 'docs', 'assets')
const OUT_REVIEW = join(ROOT, '..', '_ui-review', 'round25')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const W = 1280
const H = 560
const SHOT_W = 302
const SHOT_H = 486

const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p))
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

function dataUri(file) {
  return 'data:image/png;base64,' + readFileSync(join(SHOTS, file)).toString('base64')
}

function page({ scheme, shot }) {
  return `<!doctype html><html lang="zh-CN" data-scheme="${scheme}"><head><meta charset="utf-8">
<title>掌上 DSH — hero</title>
<style>
  /* 令牌照抄 lib/tokens.css：亮 #fff/#0f1115 · 暗 #151517/#f9fafb · 品牌蓝 #4176e6 */
  html{
    --bg:#f5f6f7; --h1:#0f1115; --body:#353638; --dim:#61666b;
    --brand:#4176e6; --screen-edge:rgba(15,17,21,.12);
    --shadow:0 1px 2px rgba(15,17,21,.05), 0 20px 40px -30px rgba(15,17,21,.42);
  }
  html[data-scheme='dark']{
    --bg:#0f1115; --h1:#f9fafb; --body:#e1e5ee; --dim:#adb2b8;
    --brand:#4176e6; --screen-edge:rgba(255,255,255,.11);
    --shadow:0 1px 2px rgba(0,0,0,.35), 0 20px 40px -30px rgba(0,0,0,.85);
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    width:${W}px;height:${H}px;overflow:hidden;
    background:var(--bg);color:var(--h1);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;
    display:flex;align-items:center;gap:76px;padding:0 72px;
  }
  /* 真机截图：等比裁掉底部（顶 628 CSS px），只加 1px 边 + 一张几乎看不见的投影 */
  .shot{
    flex:0 0 auto;width:${SHOT_W}px;height:${SHOT_H}px;border-radius:22px;overflow:hidden;
    border:1px solid var(--screen-edge);box-shadow:var(--shadow);background:transparent;
  }
  .shot img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
  .copy{flex:1 1 auto;min-width:0}
  h1{font-size:56px;line-height:1.14;font-weight:700;letter-spacing:-.012em;color:var(--h1)}
  p.sub{margin-top:17px;font-size:20px;line-height:1.7;letter-spacing:.004em;color:var(--dim);max-width:33em}
  ul{margin-top:36px;list-style:none;display:flex;flex-direction:column;gap:15px}
  li{display:flex;align-items:center;gap:12px;font-size:16px;line-height:1.5;letter-spacing:.002em;color:var(--body)}
  li i{width:5px;height:5px;border-radius:50%;background:var(--brand);flex:0 0 auto}
</style></head>
<body>
  <div class="shot"><img src="${shot}" alt="手机上的掌上 DSH 首页：在等你 2 件，第一张待批准卡可点「批准一次」"></div>
  <div class="copy">
    <h1>掌上 DSH</h1>
    <p class="sub">不用装 App。手机上把 DSH 的待批准一次点掉。</p>
    <ul>
      <li><i></i>首页就是待办</li>
      <li><i></i>一次点击批准</li>
      <li><i></i>没人的时候自动退回桌面</li>
    </ul>
  </div>
</body></html>`
}

let server = null
let child = null
let profile = ''
try {
  mkdirSync(OUT_ASSETS, { recursive: true })
  mkdirSync(OUT_REVIEW, { recursive: true })

  const html = {
    light: page({ scheme: 'light', shot: dataUri('home-pending.png') }),
    dark: page({ scheme: 'dark', shot: dataUri('home-pending-dark.png') }),
  }

  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const name = path.replace(/^\/taskwatch\/?/, '').replace(/\/$/, '') || 'light'
    if (!html[name]) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html[name])
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-hero-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=2', '--force-color-profile=srgb',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let port = 0
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !port) {
    if (child.exitCode !== null) throw new Error('Chrome 启动即退出，code=' + child.exitCode)
    const f = join(profile, 'DevToolsActivePort')
    if (existsSync(f)) {
      try {
        const raw = readFileSync(f, 'utf8').split(/\r?\n/)[0]
        if (raw) port = Number(raw)
      } catch { /* EBUSY：稍后再读 */ }
    }
    if (!port) await sleep(100)
  }
  if (!port) throw new Error('等不到 DevToolsActivePort')

  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const info = targets.find((t) => t.id === targetId)
  if (!info) throw new Error('找不到 target')
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 2, mobile: false })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }

  const failures = []
  const check = (name, ok, detail) => {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  ' + detail : ''))
    if (!ok) failures.push(name)
  }

  for (const scheme of ['light', 'dark']) {
    await cdp.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await cdp.send('Page.navigate', { url: base + '/taskwatch/' + scheme + '?t=' + Date.now() })
    await sleep(900)

    // 自检：画布真的是 1280×560、没有滚动条；截图已加载；文字块没有溢出画布。
    const audit = JSON.parse(await evalJs(`JSON.stringify((function(){
      var img = document.querySelector('.shot img');
      var copy = document.querySelector('.copy');
      var r = copy.getBoundingClientRect();
      var sub = document.querySelector('p.sub');
      return {
        scheme: document.documentElement.getAttribute('data-scheme'),
        iw: innerWidth, ih: innerHeight,
        docW: document.documentElement.scrollWidth,
        docH: document.documentElement.scrollHeight,
        imgOk: !!(img && img.complete && img.naturalWidth > 0),
        h1: document.querySelector('h1').textContent,
        subLines: Math.round(sub.getBoundingClientRect().height / (20 * 1.7)),
        copyRight: Math.round(r.right), copyLeft: Math.round(r.left),
        copyW: Math.round(r.width),
        bullets: [].map.call(document.querySelectorAll('li'), function(n){ return n.textContent.length }),
        bg: getComputedStyle(document.body).backgroundColor
      }
    })())`))

    check(scheme + ' 画布 1280×560 无滚动', audit.iw === W && audit.ih === H &&
      audit.docW <= W && audit.docH <= H, `doc=${audit.docW}×${audit.docH}`)
    check(scheme + ' 截图已加载', audit.imgOk)
    check(scheme + ' 副标题一行排得下', audit.subLines === 1, `约 ${audit.subLines} 行`)
    check(scheme + ' 右侧文字块没顶到画布边', audit.copyRight <= W - 60,
      `right=${audit.copyRight} width=${audit.copyW}`)
    check(scheme + ' 三条要点各 ≤14 字', audit.bullets.every((n) => n <= 14), JSON.stringify(audit.bullets))

    const png = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: W, height: H, scale: 0.5 },
      captureBeyondViewport: false,
    })
    const buf = Buffer.from(png.data, 'base64')
    const out = join(OUT_ASSETS, `_hero-zh-${scheme}.png`)
    writeFileSync(out, buf)
    writeFileSync(join(OUT_REVIEW, `hero-zh-${scheme}.png`), buf)
    console.log(`  ${scheme}: ${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}  ` +
      `${(buf.length / 1024).toFixed(0)}KB  背景 ${audit.bg}  副标题 ${audit.subLines} 行`)
  }

  cdp.close()
  await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  browser.close()
  if (failures.length) {
    console.error('\nhero 自检失败：\n  ' + failures.join('\n  '))
    process.exitCode = 1
  } else {
    console.log('\n两张 hero PNG 已生成。转 webp（≤180KB）：')
    console.log('  python -c "from PIL import Image; im=Image.open(\'docs/assets/_hero-zh-light.png\'); ' +
      'im.save(\'docs/assets/hero-zh-light.webp\', quality=86, method=6)"')
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
