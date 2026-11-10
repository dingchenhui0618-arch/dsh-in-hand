#!/usr/bin/env node
/**
 * README 首屏 hero（1400×640，明暗 × 中英 = 四张）。
 *
 * 构图：左边**电脑端的 DSH 窗口**，右边**手机端的掌上 DSH**，两台物件下方各一行小字
 * 说明「这是什么」，别让人猜。
 *
 * 右边手机屏里是**仓库里已有的真机截图**（docs/screenshots/current/home-pending(.dark).png，
 * 由 scripts/make-shots.mjs 用真 Chrome + docs/demo.html 拍出来，390×844 @DPR2），
 * 外面只加一层设备框（7px 外框 + 33px 内圆角 + 1px 边 + 极浅投影）。
 *
 * 左边窗口是**渲染出来的**：布局照 DSH 桌面端（左会话列表 + 右对话 + 底部输入），
 * 内容用演示数据（与页面截图同一套），窗口右上角明写「演示数据 · 非真实状态」——
 * 它不是 DSH 的真截图，不能让人误会成真机照片。
 *
 * 颜色全部取 lib/tokens.css 那套令牌：
 *   亮 #f5f6f7 底 / #0f1115 字 / #61666b 次要 / #4176e6 只当发送键；
 *   暗 #0f1115 底 / #f9fafb 字 / #adb2b8 次要。
 * 没有渐变、没有辉光、没有 3D；间距只走 4/8 栅格。
 *
 * 做法：真 Chrome headless + CDP，DPR2 渲染后按 clip.scale=0.5 缩到 1400×640，
 * 等于「2 倍渲染再降采样」——小字不糊，边缘有真正的抗锯齿。
 *
 * 用法：node scripts/make-hero.mjs
 * 输出：<仓库上级>\_ui-review\round32\hero-<lang>-<scheme>.png（PNG 只在审阅目录，
 *       webp 放 docs/assets/，转换命令见脚本末尾）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'docs', 'screenshots', 'current')
const OUT_REVIEW = join(ROOT, '..', '_ui-review', 'round32')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const W = 1400
const H = 640

// 电脑端窗口：880×528，左上角 (100,64)
const WIN = { x: 100, y: 64, w: 880, h: 528 }
const WIN_RAIL = 236
// 手机：外框 264×552，右上边与窗口齐平（x 靠右、底对齐到 592）
const BEZEL = 7
const DEV_W = 264
const DEV_H = 552
const DEV = { x: 1036, y: 40, w: DEV_W, h: DEV_H }
const CAPTION_Y = 604

const COPY = {
  zh: {
    title: 'DSH — 重构支付模块的重试逻辑',
    demo: '演示数据 · 非真实状态',
    railTitle: '会话',
    sessions: [
      { t: '重构支付模块的重试逻辑', m: '运行命令 · 第 7 步', on: true },
      { t: '核对接口字段', m: '搜索内容 · 第 2 步' },
      { t: '整理季度报表导出', m: '修改文件 · 第 3 步' },
      { t: '掌上 DSH 的入口设计', m: '空闲' },
    ],
    railFoot: '设备 2 · 子代理 2 · 今日 37 轮',
    say: '改完了：基础 2 秒、上限 60 秒，保留最后一次失败的原始异常。',
    code: 'const delay = Math.min(60000, 2000 * 2 ** attempt)',
    cardBadge: '待批准',
    cardTool: 'pssh',
    cardText: '删除 build/cache 下的 3 个过期产物目录，需要你先确认。',
    cardMeta: '需要批准 · 重构支付模块的重试逻辑',
    cardLeft: '剩余 01:52',
    allow: '批准一次',
    deny: '拒绝',
    cardHint: '120 秒无响应会退回桌面',
    input: '说点什么…',
    capWin: '电脑端 · DSH 桌面',
    capPhone: '手机端 · 掌上 DSH',
    altHome: '手机上的掌上 DSH 首页：品牌块、待批准卡与底部对话框',
  },
  en: {
    title: 'DSH — retry logic for the payment module',
    demo: 'Sample data · not a real session',
    railTitle: 'Sessions',
    sessions: [
      { t: 'Retry logic for the payment module', m: 'Running a command · step 7', on: true },
      { t: 'Check the interface fields', m: 'Searching · step 2' },
      { t: 'Export the quarterly report', m: 'Editing files · step 3' },
      { t: 'Entry design for DSH in Hand', m: 'Idle' },
    ],
    railFoot: '2 devices · 2 subagents · 37 turns today',
    say: 'Done: base 2s, cap 60s, and the last failure keeps its original exception.',
    code: 'const delay = Math.min(60000, 2000 * 2 ** attempt)',
    cardBadge: 'Pending',
    cardTool: 'pssh',
    cardText: 'Delete 3 stale output folders under build/cache. This needs your confirmation.',
    cardMeta: 'Needs approval · retry logic for the payment module',
    cardLeft: '01:52 left',
    allow: 'Approve once',
    deny: 'Reject',
    cardHint: 'Returns to the desktop after 120s of silence',
    input: 'Say something…',
    capWin: 'Desktop · DSH',
    capPhone: 'Phone · DSH in Hand',
    altHome: 'The DSH in Hand home screen: brand block, a pending approval card, and a composer',
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
  const shot = scheme === 'dark' ? dataUri('home-pending-dark.png') : dataUri('home-pending.png')
  const langAttr = lang === 'en' ? 'en' : 'zh-CN'
  const rows = c.sessions.map((s) => `<div class="sess${s.on ? ' on' : ''}">` +
    `<span class="t">${s.t}</span><span class="m">${s.m}</span></div>`).join('')
  return `<!doctype html><html lang="${langAttr}" data-scheme="${scheme}"><head><meta charset="utf-8">
<title>hero</title>
<style>
  /* 令牌照抄 lib/tokens.css：亮 #f5f6f7/#0f1115 · 暗 #0f1115/#f9fafb · 品牌蓝 #4176e6 */
  html{
    --bg:#f5f6f7; --win:#fff; --h1:#0f1115; --body:#353638; --dim:#61666b; --faint:#81858c;
    --line:#0f11151a; --line2:#0f11151a; --panel2:#f5f6f7;
    --accent:#4176e6; --accent-fg:#fff; --badge:#b9550a; --badge-bg:#fdf2e5;
    --edge:#0f11151f;
    --shadow:0 2px 8px -3px rgba(15,17,21,.14), 0 28px 52px -34px rgba(15,17,21,.55);
  }
  html[data-scheme='dark']{
    --bg:#0f1115; --win:#151517; --h1:#f9fafb; --body:#e1e5ee; --dim:#adb2b8; --faint:#81858c;
    --line:#ffffff1f; --line2:#ffffff1f; --panel2:#1d1e21;
    --accent:#4176e6; --accent-fg:#fff; --badge:#f0b56a; --badge-bg:#2a2015;
    --edge:#ffffff26;
    --shadow:0 2px 8px -3px rgba(0,0,0,.5), 0 28px 52px -34px rgba(0,0,0,.95);
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    position:relative;width:${W}px;height:${H}px;overflow:hidden;background:var(--bg);color:var(--h1);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",
      "Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;
  }
  /* ── 电脑端窗口 ───────────────────────────────────────────────── */
  .win{
    position:absolute;left:${WIN.x}px;top:${WIN.y}px;width:${WIN.w}px;height:${WIN.h}px;
    border-radius:12px;overflow:hidden;display:flex;flex-direction:column;
    background:var(--win);border:1px solid var(--edge);box-shadow:var(--shadow);
  }
  .bar{flex:0 0 auto;height:44px;display:flex;align-items:center;gap:8px;padding:0 16px;
    border-bottom:1px solid var(--line);background:var(--panel2)}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--line2);flex:0 0 auto}
  .bar .ttl{margin-left:8px;font-size:13px;font-weight:600;color:var(--h1)}
  .bar .demo{margin-left:auto;font-size:11.5px;color:var(--faint);letter-spacing:.01em}
  .body{flex:1 1 auto;display:flex;min-height:0}
  .rail{flex:0 0 ${WIN_RAIL}px;border-right:1px solid var(--line);padding:12px;
    display:flex;flex-direction:column;gap:4px}
  .rail h4{font-size:11.5px;font-weight:600;color:var(--faint);letter-spacing:.1em;
    padding:4px 8px 8px;text-transform:uppercase}
  .sess{display:flex;flex-direction:column;gap:2px;padding:8px;border-radius:8px}
  .sess.on{background:var(--panel2)}
  .sess .t{font-size:13px;font-weight:600;color:var(--h1);line-height:1.35;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sess .m{font-size:11.5px;color:var(--dim);line-height:1.35;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rail .foot{margin-top:auto;padding:8px;font-size:11.5px;color:var(--faint);
    font-variant-numeric:tabular-nums}
  .main{flex:1 1 auto;display:flex;flex-direction:column;min-width:0}
  .main-h{flex:0 0 auto;height:44px;display:flex;align-items:center;gap:8px;padding:0 20px;
    border-bottom:1px solid var(--line);font-size:14px;font-weight:600}
  .main-h .model{margin-left:auto;font-size:11.5px;font-weight:500;color:var(--faint);
    border:1px solid var(--line);border-radius:999px;padding:2px 10px;line-height:1.6}
  .main-b{flex:1 1 auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px;min-height:0}
  .msg{font-size:13.5px;line-height:1.65;color:var(--body)}
  .code{border:1px solid var(--line);border-radius:8px;background:var(--panel2);
    padding:8px 12px;font-family:"SF Mono","JetBrains Mono",Consolas,Menlo,monospace;
    font-size:12px;line-height:1.6;color:var(--body);white-space:nowrap;overflow:hidden}
  .card{border:1px solid var(--line);border-radius:12px;background:var(--panel2);padding:12px 14px;
    display:flex;flex-direction:column;gap:8px}
  .card .row{display:flex;align-items:center;gap:8px}
  .badge{flex:0 0 auto;padding:2px 8px;border-radius:999px;background:var(--badge-bg);
    color:var(--badge);font-size:11.5px;font-weight:600;line-height:1.6}
  .card .tool{font-size:13.5px;font-weight:600}
  .card .txt{font-size:13px;line-height:1.65;color:var(--body)}
  .card .meta{font-size:11.5px;color:var(--dim)}
  .card .btns{display:flex;gap:8px;margin-top:2px}
  .btn{min-height:36px;padding:0 16px;border-radius:8px;font-size:13px;font-weight:600;
    display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line)}
  .btn.allow{background:var(--h1);color:var(--bg);border-color:transparent}
  .btn.deny{color:#c62828;border-color:#c6282855;background:transparent}
  .card .hint{font-size:11.5px;color:var(--faint)}
  .main-f{flex:0 0 auto;height:60px;display:flex;align-items:center;gap:8px;
    padding:0 20px;border-top:1px solid var(--line)}
  .fakein{flex:1 1 auto;height:36px;border-radius:18px;border:1px solid var(--line);
    background:var(--panel2);display:flex;align-items:center;padding:0 14px;
    font-size:12.5px;color:var(--faint)}
  .send{flex:0 0 auto;width:36px;height:36px;border-radius:50%;background:var(--accent);
    color:var(--accent-fg);display:grid;place-items:center}
  .send svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;
    stroke-linecap:round;stroke-linejoin:round}
  /* ── 手机端 ───────────────────────────────────────────────────── */
  .dev{
    position:absolute;left:${DEV.x}px;top:${DEV.y}px;width:${DEV.w}px;height:${DEV.h}px;
    padding:${BEZEL}px;border-radius:40px;
    background:${scheme === 'dark' ? '#23262c' : '#0f1115'};
    box-shadow:0 0 0 1px var(--edge), var(--shadow);
  }
  .dev img{display:block;width:100%;height:100%;border-radius:33px;
    object-fit:cover;object-position:top}
  /* ── 两行说明 ─────────────────────────────────────────────────── */
  .cap{position:absolute;top:${CAPTION_Y}px;font-size:12.5px;line-height:1.4;
    color:var(--dim);letter-spacing:.01em;white-space:nowrap}
  .cap.left{left:${WIN.x}px;width:${WIN.w}px;text-align:center}
  .cap.right{left:${DEV.x}px;width:${DEV.w}px;text-align:center}
</style></head>
<body>
  <div class="win">
    <div class="bar">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="ttl">DSH</span>
      <span class="demo">${c.demo}</span>
    </div>
    <div class="body">
      <div class="rail">
        <h4>${c.railTitle}</h4>
        ${rows}
        <div class="foot">${c.railFoot}</div>
      </div>
      <div class="main">
        <div class="main-h">${c.title}<span class="model">deepseek-flash</span></div>
        <div class="main-b">
          <p class="msg">${c.say}</p>
          <div class="code">${c.code}</div>
          <div class="card">
            <div class="row"><span class="badge">${c.cardBadge}</span><span class="tool">${c.cardTool}</span></div>
            <p class="txt">${c.cardText}</p>
            <p class="meta">${c.cardMeta}</p>
            <div class="row"><span class="meta">${c.cardLeft}</span></div>
            <div class="btns">
              <span class="btn allow">${c.allow}</span>
              <span class="btn deny">${c.deny}</span>
            </div>
            <p class="hint">${c.cardHint}</p>
          </div>
        </div>
        <div class="main-f">
          <div class="fakein">${c.input}</div>
          <span class="send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M12 6l6 6-6 6"/></svg></span>
        </div>
      </div>
    </div>
  </div>
  <div class="dev"><img src="${shot}" alt="${c.altHome}"></div>
  <div class="cap left">${c.capWin}</div>
  <div class="cap right">${c.capPhone}</div>
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
        var img = document.querySelector('.dev img');
        var box = function(sel){
          var b = document.querySelector(sel).getBoundingClientRect();
          return { x: Math.round(b.left), y: Math.round(b.top),
                   w: Math.round(b.width), h: Math.round(b.height),
                   right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
        var card = document.querySelector('.card').getBoundingClientRect();
        var mainB = document.querySelector('.main-b').getBoundingClientRect();
        var capW = document.querySelector('.cap.left');
        var capP = document.querySelector('.cap.right');
        return {
          iw: innerWidth, ih: innerHeight,
          docW: document.documentElement.scrollWidth,
          docH: document.documentElement.scrollHeight,
          imgOk: !!(img && img.complete && img.naturalWidth > 0),
          win: box('.win'), dev: box('.dev'), cardBottom: Math.round(card.bottom),
          mainBottom: Math.round(mainB.bottom),
          capWin: box('.cap.left'), capPhone: box('.cap.right'),
          capWinText: capW.textContent.trim(), capPhoneText: capP.textContent.trim(),
          cardVisible: card.height > 0,
          over: [].filter.call(document.querySelectorAll('body *'), function(n){
            var b = n.getBoundingClientRect();
            return b.bottom > ${H} + 0.5 && getComputedStyle(n).position !== 'fixed';
          }).slice(0, 5).map(function(n){
            return n.tagName.toLowerCase() + '.' + String(n.className) + '@' + Math.round(n.getBoundingClientRect().bottom);
          }),
          bg: getComputedStyle(document.body).backgroundColor
        };
      })())`))

      check(`${name} 画布 ${W}×${H} 无滚动`,
        a.iw === W && a.ih === H && a.docW <= W && a.docH <= H,
        `doc=${a.docW}×${a.docH}` + (a.over && a.over.length ? ' 溢出=' + a.over.join(' ') : ''))
      check(`${name} 手机截图已加载`, a.imgOk)
      check(`${name} 窗口 880×528 @ (100,64)`,
        a.win.x === WIN.x && a.win.y === WIN.y && a.win.w === WIN.w && a.win.h === WIN.h,
        `${a.win.x},${a.win.y} ${a.win.w}×${a.win.h}`)
      check(`${name} 手机 264×552 @ (1036,40)`,
        a.dev.x === DEV.x && a.dev.y === DEV.y && a.dev.w === DEV.w && a.dev.h === DEV.h,
        `${a.dev.x},${a.dev.y} ${a.dev.w}×${a.dev.h}`)
      check(`${name} 两个物件不重叠、都在画布内`,
        a.win.right + 24 <= a.dev.x && a.dev.right <= W - 64 && a.dev.bottom <= CAPTION_Y - 8,
        `win.right=${a.win.right} dev.x=${a.dev.x} dev.right=${a.dev.right} dev.bottom=${a.dev.bottom}`)
      check(`${name} 窗口里的待批准卡没被裁`,
        a.cardVisible && a.cardBottom <= a.mainBottom,
        `cardBottom=${a.cardBottom} mainBottom=${a.mainBottom}`)
      check(`${name} 两行说明都在、位置正确`,
        a.capWin.w === WIN.w && a.capWin.y === CAPTION_Y &&
        a.capPhone.w === DEV.w && a.capPhone.y === CAPTION_Y &&
        a.capWinText === COPY[lang].capWin && a.capPhoneText === COPY[lang].capPhone,
        `${a.capWinText} / ${a.capPhoneText}`)

      const png = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: W, height: H, scale: 0.5 },
        captureBeyondViewport: false,
      })
      const buf = Buffer.from(png.data, 'base64')
      writeFileSync(join(OUT_REVIEW, `hero-${name}.png`), buf)
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
    console.log('转 webp（quality 88）后放进 docs/assets/：')
    console.log('  python -c "from PIL import Image; import sys; ' +
      'Image.open(sys.argv[1]).convert(\'RGB\').save(sys.argv[2], quality=88, method=6)" in.png out.webp')
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
