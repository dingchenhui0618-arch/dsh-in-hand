#!/usr/bin/env node
/**
 * README 首屏 hero（1400×640，明暗 × 中英 = 四张）。
 *
 * 构图：左边**两台手机**并排、错位 24px；右边是字标 + 定位句 + 三枚事实药丸 + 版权行。
 *
 * 手机屏里是**仓库里已有的真机截图**（docs/screenshots/current/*.png，由
 * scripts/make-shots.mjs 用真 Chrome + docs/demo.html 拍出来，390×844 @DPR2）：
 *   亮色：home-pending（待批准） + chat-light（会话正文）
 *   暗色：home-pending-dark + chat-dark
 * 屏幕本身不重画、不修图、不补字，只在外面加一层「设备」：34px 圆角 + 1px 边 + 一枚
 * 极浅投影——不加刘海、不加高光、不加 3D。
 *
 * 颜色全部取 lib/tokens.css 那套令牌：
 *   亮 #f5f6f7 底 / #0f1115 字 / #61666b 次要 / #4176e6 只用在 kicker 一行；
 *   暗 #0f1115 底 / #f9fafb 字 / #adb2b8 次要 / #8fb0f5 kicker。
 * 没有渐变、没有辉光、没有漂浮卡片；间距只走 4/8 栅格。
 *
 * 做法：真 Chrome headless + CDP，DPR2 渲染后按 clip.scale=0.5 缩到 1400×640，
 * 等于「2 倍渲染再降采样」——小字不糊，边缘有真正的抗锯齿。
 *
 * 用法：node scripts/make-hero.mjs
 * 输出：<会话上级>\_ui-review\round30\hero-<lang>-<scheme>.png（PNG 只在审阅目录，
 *       转 webp 后放 docs/assets/hero-<lang>-<scheme>.webp，命令见脚本末尾）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs', 'screenshots', 'current')
const OUT_REVIEW = join(ROOT, '..', '_ui-review', 'round30')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const W = 1400
const H = 640
const BEZEL = 7 // 设备外框厚度（屏比外框小一圈）
const SCR_W = 250 // 屏：390×844 等比缩到 250 宽 → 540.7 高
const SCR_H = 550 // 取 550：对 390:844 只横向裁 1.6%，肉眼看不出
const DEV_W = SCR_W + BEZEL * 2 // 264
const DEV_H = SCR_H + BEZEL * 2 // 564
const DEV_GAP = 24
const DEV_OFFSET = 24 // 第二台往下错开
const PAD = 64
const GROUP_W = DEV_W * 2 + DEV_GAP // 552
const COPY_LEFT = PAD + GROUP_W + 48 // 664
const COPY_W = W - COPY_LEFT - PAD // 672
const DEV_A_TOP = 28
const DEV_B_TOP = DEV_A_TOP + DEV_OFFSET // 56

const COPY = {
  zh: {
    h1: '掌上 DSH',
    kicker: 'dsh-in-hand',
    pitch: '不用装 App。手机上把 DSH 的待批准一次点掉。',
    pills: ['不用装 App', '零依赖', '自带中继'],
    foot: 'DSH ≥0.2.1-rc.2 · Apache-2.0 · npm dsh-in-hand',
    altHome: '亮色首页：在等你 2 件，第一张待批准卡可以直接「批准一次」',
    altChat: '暗色会话：步骤、代码块与图表都在同一页里',
  },
  en: {
    h1: 'DSH in Hand',
    kicker: '掌上 DSH',
    pitch: 'No app to install. One tap on your phone settles a DSH approval.',
    pills: ['No install', 'Zero deps', 'Built-in relay'],
    foot: 'DSH ≥0.2.1-rc.2 · Apache-2.0 · npm dsh-in-hand',
    altHome: 'Light home screen: two items waiting, the first approval card is one tap away',
    altChat: 'Dark session view: steps, code block and a chart on one page',
  },
}

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

function page({ lang, scheme }) {
  const c = COPY[lang]
  const shots = scheme === 'dark'
    ? { a: dataUri('home-pending-dark.png'), b: dataUri('chat-dark.png') }
    : { a: dataUri('home-pending.png'), b: dataUri('chat-light.png') }
  const langAttr = lang === 'en' ? 'en' : 'zh-CN'
  return `<!doctype html><html lang="${langAttr}" data-scheme="${scheme}"><head><meta charset="utf-8">
<title>${c.h1} — hero</title>
<style>
  /* 令牌照抄 lib/tokens.css：亮 #f5f6f7/#0f1115 · 暗 #0f1115/#f9fafb · 品牌蓝 #4176e6 */
  html{
    --bg:#f5f6f7; --h1:#0f1115; --body:#353638; --dim:#61666b;
    --accent:#4176e6; --edge:rgba(15,17,21,.12); --pill-edge:rgba(15,17,21,.14);
    --frame:#0f1115; --frame-edge:rgba(15,17,21,.55);
    --shadow:0 2px 8px -3px rgba(15,17,21,.14), 0 28px 52px -34px rgba(15,17,21,.55);
  }
  html[data-scheme='dark']{
    --bg:#0f1115; --h1:#f9fafb; --body:#e1e5ee; --dim:#adb2b8;
    --accent:#8fb0f5; --edge:rgba(255,255,255,.12); --pill-edge:rgba(255,255,255,.16);
    --frame:#23262c; --frame-edge:rgba(255,255,255,.15);
    --shadow:0 2px 8px -3px rgba(0,0,0,.5), 0 28px 52px -34px rgba(0,0,0,.95);
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    position:relative;width:${W}px;height:${H}px;overflow:hidden;
    background:var(--bg);color:var(--h1);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",
      "Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;
  }
  /* 两台设备：${BEZEL}px 外框 + 33px 内圆角 + 1px 边 + 一枚极浅投影，屏里就是真机截图 */
  .dev{
    position:absolute;left:${PAD}px;width:${DEV_W}px;height:${DEV_H}px;
    padding:${BEZEL}px;border-radius:40px;background:var(--frame);
    box-shadow:0 0 0 1px var(--frame-edge), var(--shadow);
  }
  .dev.a{top:${DEV_A_TOP}px}
  .dev.b{top:${DEV_B_TOP}px;left:${PAD + DEV_W + DEV_GAP}px}
  .dev img{
    display:block;width:100%;height:100%;border-radius:33px;
    object-fit:cover;object-position:top;
  }
  .copy{
    position:absolute;left:${COPY_LEFT}px;top:0;width:${COPY_W}px;height:${H}px;
    display:flex;flex-direction:column;justify-content:center;
  }
  h1{font-size:68px;line-height:1.08;font-weight:600;letter-spacing:-.012em;word-spacing:-.08em;color:var(--h1)}
  .kicker{margin-top:12px;font-size:13px;line-height:1.4;letter-spacing:.18em;color:var(--accent)}
  p.pitch{margin-top:24px;font-size:22px;line-height:1.7;letter-spacing:.01em;color:var(--dim);max-width:30em;text-wrap:balance}
  .pills{margin-top:32px;display:flex;gap:8px}
  .pill{
    height:32px;padding:0 16px;border-radius:999px;border:1px solid var(--pill-edge);
    font-size:14px;line-height:30px;letter-spacing:.002em;color:var(--body);white-space:nowrap;
  }
  .rule{width:100%;height:1px;background:var(--edge);margin-top:40px}
  .foot{margin-top:16px;font-size:13px;line-height:1.4;letter-spacing:.02em;color:var(--dim);
    font-variant-numeric:tabular-nums}
</style></head>
<body>
  <div class="dev a"><img src="${shots.a}" alt="${c.altHome}"></div>
  <div class="dev b"><img src="${shots.b}" alt="${c.altChat}"></div>
  <div class="copy">
    <h1>${c.h1}</h1>
    <div class="kicker">${c.kicker}</div>
    <p class="pitch">${c.pitch}</p>
    <div class="pills">${c.pills.map((t) => `<span class="pill">${t}</span>`).join('')}</div>
    <div class="rule"></div>
    <div class="foot">${c.foot}</div>
  </div>
</body></html>`
}

let server = null
let child = null
let profile = ''
const failures = []
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  ' + detail : ''))
  if (!ok) failures.push(name)
}

try {
  mkdirSync(OUT_REVIEW, { recursive: true })

  const html = {}
  for (const lang of ['zh', 'en']) {
    for (const scheme of ['light', 'dark']) html[`${lang}-${scheme}`] = page({ lang, scheme })
  }

  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const name = path.replace(/^\/taskwatch\/?/, '').replace(/\/$/, '') || 'zh-light'
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

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }

  for (const lang of ['zh', 'en']) {
    for (const scheme of ['light', 'dark']) {
      const name = `${lang}-${scheme}`
      await cdp.send('Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: scheme }] })
      await cdp.send('Page.navigate', { url: base + '/taskwatch/' + name + '?t=' + Date.now() })
      await sleep(900)

      const a = JSON.parse(await evalJs(`JSON.stringify((function(){
        var imgs = [].map.call(document.querySelectorAll('.dev img'), function(n){
          return { ok: !!(n.complete && n.naturalWidth > 0), nw: n.naturalWidth } });
        var r = function(sel){
          var b = document.querySelector(sel).getBoundingClientRect();
          return { x: Math.round(b.left), y: Math.round(b.top),
                   w: Math.round(b.width), h: Math.round(b.height),
                   right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
        var h1 = document.querySelector('h1');
        var pills = [].map.call(document.querySelectorAll('.pill'), function(n){
          var b = n.getBoundingClientRect();
          return { text: n.textContent, y: Math.round(b.top), right: Math.round(b.right) }; });
        var pitch = document.querySelector('p.pitch');
        var copy = document.querySelector('.copy');
        return {
          iw: innerWidth, ih: innerHeight,
          docW: document.documentElement.scrollWidth,
          docH: document.documentElement.scrollHeight,
          imgs: imgs, a: r('.dev.a'), b: r('.dev.b'), copy: r('.copy'),
          h1: r('h1'), h1Text: h1.textContent, h1Size: parseFloat(getComputedStyle(h1).fontSize),
          pitch: r('.pitch'),
          pitchLine: parseFloat(getComputedStyle(pitch).lineHeight),
          pills: pills,
          foot: r('.foot'), rule: r('.rule'),
          bg: getComputedStyle(document.body).backgroundColor,
          scheme: document.documentElement.getAttribute('data-scheme'),
          lang: document.documentElement.getAttribute('lang')
        };
      })())`))

      check(`${name} 画布 ${W}×${H} 无滚动`,
        a.iw === W && a.ih === H && a.docW <= W && a.docH <= H, `doc=${a.docW}×${a.docH}`)
      check(`${name} 两张截图都加载了`, a.imgs.length === 2 && a.imgs.every((i) => i.ok),
        a.imgs.map((i) => i.nw).join('/'))
      check(`${name} 设备 A 顶 ${DEV_A_TOP}、B 错位 ${DEV_OFFSET}`,
        a.a.y === DEV_A_TOP && a.b.y === DEV_B_TOP &&
        a.a.w === DEV_W && a.a.h === DEV_H && a.b.x - a.a.right === DEV_GAP,
        `A=${a.a.x},${a.a.y} ${a.a.w}×${a.a.h}  B=${a.b.x},${a.b.y}  gap=${a.b.x - a.a.right}`)
      check(`${name} 两台设备不出画布`, a.b.bottom <= H && a.b.right <= COPY_LEFT - 24,
        `B bottom=${a.b.bottom} right=${a.b.right}`)
      check(`${name} 标题一行`,
        a.h1.h <= Math.round(a.h1Size * 1.08) + 2, `h=${a.h1.h} 字号=${a.h1Size} 「${a.h1Text}」`)
      check(`${name} 标题不顶到右边`, a.h1.right <= W - PAD, `right=${a.h1.right} 上限=${W - PAD}`)
      check(`${name} 定位句 ≤2 行`, a.pitch.h <= a.pitchLine * 2 + 2,
        `h=${Math.round(a.pitch.h)} 行高=${a.pitchLine}`)
      check(`${name} 三枚药丸同一行且不出右边界`,
        a.pills.length === 3 && new Set(a.pills.map((p) => p.y)).size === 1 &&
        a.pills.every((p) => p.right <= W - PAD),
        a.pills.map((p) => `${p.text}@${p.y}/${p.right}`).join(' '))
      check(`${name} 文字块左侧留够 48`, a.copy.x === COPY_LEFT && a.copy.w === COPY_W,
        `copy=${a.copy.x},${a.copy.y} ${a.copy.w}×${a.copy.h}`)
      check(`${name} 文字块垂直居中`,
        Math.abs((a.copy.y + a.copy.h / 2) - H / 2) <= 1, `中心=${a.copy.y + a.copy.h / 2}`)

      const png = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: W, height: H, scale: 0.5 },
        captureBeyondViewport: false,
      })
      const buf = Buffer.from(png.data, 'base64')
      const out = join(OUT_REVIEW, `hero-${name}.png`)
      writeFileSync(out, buf)
      console.log(`  ${name}: ${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}  ` +
        `${(buf.length / 1024).toFixed(0)}KB  背景 ${a.bg}`)
    }
  }

  cdp.close()
  await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  browser.close()
  if (failures.length) {
    console.error('\nhero 自检失败：\n  ' + failures.join('\n  '))
    process.exitCode = 1
  } else {
    console.log('\n四张 hero PNG 已生成到 ' + OUT_REVIEW)
    console.log('转 webp（quality 88，≤120KB）后放进 docs/assets/：')
    console.log('  python -c "from PIL import Image; import sys; ' +
      'im=Image.open(sys.argv[1]).convert(\'RGB\'); im.save(sys.argv[2], quality=88, method=6)" ' +
      'in.png out.webp')
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}

