#!/usr/bin/env node
/**
 * v1.8.21 README 首屏的三个 GIF（真渲染，不是合成动画）。
 *
 * 页面是 docs/demo.html —— 由 lib/page.html 生成、只把取数换成演示假数据的那一份，
 * 所以录到的就是**当前实现**的样式与状态机。真 Chrome headless + CDP：
 *   · 390×640 CSS、DPR2 → 每帧 780×1280 PNG，最后缩到 720 宽（≤2.5MB）；
 *   · 点击走 Input.dispatchMouseEvent（真按下/抬起，能触发 :active 与真实 click），
 *     不是 el.click() 硬调；
 *   · 轮播/倒计时/过渡都是页面自己在跑，脚本只负责在时间线上按一下。
 *
 * 三条片子：
 *   flow-approve   首页「在等你」→ 待批准卡「批准一次」→ 二次确认 → 卡片落地成「已提交 · 允许一次」
 *   flow-sessions  左上角 ☰ → 抽屉（工作台 / 操作 前置）→ 列表里点一个会话进对话页
 *   flow-theme     抽屉里的字号 大 → 切换到暗色 → 关掉抽屉，首页变成暗色 + 大字号
 *
 * 两条硬约束：
 *   1. 顶部「演示数据 · 非真实状态」那条必须**一直在画面里**（每帧都从页面顶端裁起），
 *      脚本在开始与结束时各断言一次；
 *   2. 不录推送通知、锁屏、微信/系统弹窗——那条链路没在真机验证过。
 *
 * 用法：node scripts/make-gifs.mjs [approve|sessions|theme|all]
 * 输出：docs/assets/flow-*.gif + ..\_ui-review\round25\ 下的帧（首帧与中帧）
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(ROOT, 'docs', 'demo.html')
const OUT_ASSETS = join(ROOT, 'docs', 'assets')
const OUT_REVIEW = join(ROOT, '..', '_ui-review', 'round25')
const PYTHON = process.env.PYTHON || 'python'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const VW = 390
const VH = 640
// 帧先按 DPR2 出（780×1280），再由 build-gif.py 缩到 720 —— 整数 DPR 比 1.846 的
// 抓帧稳得多（实测 75ms vs 181ms/帧），多出来的那点降采样是 Pillow 的活，很便宜。
const DSF = 2

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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 30000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
    })
  }
  close() { try { this.ws.close() } catch { /* 已断开 */ } }
}

/* 每段片子开头的取数替身：给一份**时间戳是刚刚**的演示数据（demo.html 里那份是生成时
 * 写死的，expiresAt 早过了，卡片会直接显示"已退回桌面"），并让 /taskwatch/data 的轮询
 * 一直返回同一份——否则 5 秒一次的重建会把计时器打回过期。审批接口回 allowed-once，
 * 和 scripts/make-shots.mjs 里的做法一致：只替换宿主响应，UI 走真实代码路径。 */
const setupJs = (scheme, font) => `(async function(){
  var now = Date.now();
  var FRESH = {generatedAt: now, offline: false, errors: [], riskConfirm: true,
    totals: {sessions: 7, running: 4, jobs: 5, jobsRunning: 3, subagents: 2, workflows: 1, pending: 1},
    today: {since: now - 21600000, turns: 37, steps: 1291, sessions: 3, partial: false},
    pending: [{id: 'approval-demo', kind: 'approval', title: 'pwsh',
      detail: '删除 build/cache 下的 3 个过期产物目录，需要你先确认。',
      session: 'session-demo-a', sessionTitle: '重构支付模块的重试逻辑',
      at: now, canDecide: true, expiresAt: now + 112000, timeoutMs: 120000}],
    sessions: DEMO.sessions.map(function(s){ return Object.assign({}, s) }),
    jobs: DEMO.jobs, subagents: DEMO.subagents, workflows: DEMO.workflows};
  var REAL = window.fetch;
  window.fetch = function(u, o){
    var s = String(u);
    if (s.indexOf('/taskwatch/data') === 0) {
      return Promise.resolve({ok: true, status: 200, json: function(){ return Promise.resolve(FRESH) }});
    }
    if (s.indexOf('/taskwatch/approve') === 0) {
      return Promise.resolve({ok: true, status: 200, json: function(){ return Promise.resolve({ok: true, outcome: 'allowed-once'}) }});
    }
    return REAL(u, o);
  };
  document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)});
  document.documentElement.setAttribute('data-font', ${JSON.stringify(font)});
  lastData = FRESH;
  setView('home');
  // demo 页在生成时把 tick 覆盖成空函数（scripts/make-demo.mjs：「tick=async function(){}」），
  // 也没有 /taskwatch/chat/events 这个流，于是连接胶囊会一直挂在黄色「重连中」——
  // 那是演示桩的残留，不是产品状态。这里按真实环境的**稳定**分支把两个状态位摆正：
  // 上次成功时间 + 事件流已连上。改的只是这枚指示器，演示数据一个字没动。
  NET.lastOkAt = Date.now();
  NET.attempts = 0;
  S.esOpen = true;
  S.esError = false;
  syncStatus();
  renderHome();
  setSub('演示数据 · 非真实状态');
  if (typeof renderNet === 'function') renderNet();
  return 'ok'
})()`

const FLOWS = {
  approve: {
    total: 4200,
    steps: [
      // 首页第一张待办卡上按「批准一次」→ 弹二次确认。
      // hold 240ms：`.approval-allow:active{opacity:.86}` 得在片子里占住 2 帧，
      // 否则"按下去"这件事完全看不见，只剩状态突变。
      { at: 700, run: (c) => c.press('#homeTodo [data-approve]', { hold: 240, expect: '#approveConfirm:not([hidden])' }) },
      // 在确认层按「允许一次」→ 卡片落地成「已提交 · 允许一次」
      { at: 2000, run: (c) => c.press('#approveConfirm [data-confirm-ok]', { hold: 200, expect: '#homeTodo .approval-state:not([hidden])' }) },
    ],
  },
  sessions: {
    total: 6200,
    steps: [
      // ☰ → 抽屉（工作台 / 操作 前置的新版），停住 1.4 秒让人看清这两组
      { at: 700, run: (c) => c.press('#sessBtn', { hold: 160, expect: '#sheet:not([hidden])' }) },
      // 往下滑到「运行中」列表。分三次滚：一次滚到位会跳帧，分三次才看得出是"在滑"；
      // 每次之间让抓帧循环跑一轮，滚动过程才录得下来（不能 await 一口气刷完）。
      { at: 2500, run: (c) => c.wheel(195, 430, 300) },
      { at: 2780, run: (c) => c.wheel(195, 430, 300) },
      { at: 3060, run: (c) => c.wheel(195, 430, 300) },
      // 列表停稳一秒多再点，别让"滚动 + 点击"挤在同一帧里
      { at: 4300, run: (c) => c.press('#sessionList [data-sess]', { hold: 170, expect: '#sheet[hidden]' }) },
    ],
  },
  theme: {
    total: 5800,
    steps: [
      { at: 700, run: (c) => c.press('#sessBtn', { hold: 160, expect: '#sheet:not([hidden])' }) },
      // 先滑到「字号」那一排（滚轮，三次）。不滑的话 rect() 会替你来一次 scrollIntoView，
      // 那一下是瞬间跳位，在片子里会显得"画面被人拽了一把"。
      { at: 1500, run: (c) => c.wheel(195, 430, 300) },
      { at: 1780, run: (c) => c.wheel(195, 430, 300) },
      { at: 2060, run: (c) => c.wheel(195, 430, 300) },
      // 字号：中 → 大
      { at: 2800, run: (c) => c.press('#card .segbtn[data-font="large"]', { hold: 170, expect: null }) },
      // 明 → 暗。这个入口自己会收起抽屉（[data-act="theme"] → closeSheet + applyTheme），
      // 所以下一帧就是"首页在暗色、大字号下"——不需要再补一次关闭动作。
      { at: 4200, run: (c) => c.press('#card [data-act="theme"]', { hold: 170, expect: '#sheet[hidden]' }) },
    ],
  },
}

const want = (process.argv[2] || 'all').trim()
const names = want === 'all' ? Object.keys(FLOWS) : [want]
for (const n of names) {
  if (!FLOWS[n]) { console.error('未知片子：' + n + '（可选 approve / sessions / theme / all）'); process.exit(2) }
}

let server = null
let child = null
let profile = ''
try {
  mkdirSync(OUT_ASSETS, { recursive: true })
  mkdirSync(OUT_REVIEW, { recursive: true })
  const html = readFileSync(DEMO, 'utf8')
  // 首页品牌行要用到真图标，缺了就是一张破图——渲染出来一眼就能看见，必须喂给它。
  const icon192 = readFileSync(join(ROOT, 'lib', 'icons', 'icon-192.png'))
  const icon512 = readFileSync(join(ROOT, 'lib', 'icons', 'icon-512.png'))
  const manifest = readFileSync(join(ROOT, 'lib', 'manifest.webmanifest'))

  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (path === '/taskwatch/icon-192.png') {
      res.writeHead(200, { 'content-type': 'image/png' }); res.end(icon192); return
    }
    if (path === '/taskwatch/icon-512.png') {
      res.writeHead(200, { 'content-type': 'image/png' }); res.end(icon512); return
    }
    if (path === '/taskwatch/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' }); res.end(manifest); return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-gifs-'))
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

  let cdp = null
  let targetId = ''
  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500))
    return r.result && r.result.value
  }
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
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: VW, height: VH, deviceScaleFactor: DSF, mobile: true })
  }

  const mouse = (type, p) => cdp.send('Input.dispatchMouseEvent', {
    type, x: p.x, y: p.y, button: 'left', clickCount: 1,
    ...(type === 'mousePressed' ? { buttons: 1 } : {}),
  })

  const ctx = {
    async rect(sel) {
      return evalJs(`(function(){
        var el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        var r = el.getBoundingClientRect();
        var inView = r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
        if (!inView) el.scrollIntoView({block: 'center'});
        r = el.getBoundingClientRect();
        return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                w: Math.round(r.width), h: Math.round(r.height)};
      })()`)
    },
    async press(sel, { hold = 90, expect = null } = {}) {
      const p = await this.rect(sel)
      if (!p || !p.w) throw new Error('点不到：' + sel)
      await mouse('mousePressed', p)
      await sleep(hold)
      await mouse('mouseReleased', p)
      if (expect) {
        await sleep(300)
        const ok = await evalJs(`!!document.querySelector(${JSON.stringify(expect)})`)
        if (!ok) {
          // 合成鼠标事件被吞时退回 element.click()（仍然是页面自己的 click 处理器）
          await evalJs(`(function(){var el=document.querySelector(${JSON.stringify(sel)}); if(el) el.click(); return 'ok'})()`)
          await sleep(250)
          const ok2 = await evalJs(`!!document.querySelector(${JSON.stringify(expect)})`)
          if (!ok2) throw new Error('点了没反应：' + sel + ' （期待 ' + expect + '）')
        }
      }
    },
    async wheel(x, y, dy) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, button: 'none', clickCount: 0,
      })
    },
  }

  const results = []
  for (const name of names) {
    const flow = FLOWS[name]
    console.log('\n[录制] ' + name + '  目标 ' + (flow.total / 1000).toFixed(1) + 's')
    await newPage()
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await cdp.send('Page.navigate', { url: base + '/taskwatch?gif=' + name })
    await sleep(1300)
    await evalJs(setupJs('light', 'medium'))
    // 页面刚加载的 1-2 秒里 Chrome 还在栅格化字体/图标，抓帧会慢到 180ms/帧；
    // 等它静下来再开录，实测能从 6fps 回到 10fps 以上。这段等待也不进片子。
    await sleep(1600)

    const bannerOk = await evalJs(`document.body.innerText.indexOf('演示数据') >= 0`)
    if (!bannerOk) throw new Error(name + '：页面顶部没有「演示数据」条，录出来会像是真实状态')

    const dir = join(OUT_REVIEW, 'frames-' + name)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })

    const t0 = Date.now()
    const frames = []
    let si = 0
    const steps = flow.steps.slice()
    while (Date.now() - t0 < flow.total) {
      const el = Date.now() - t0
      while (si < steps.length && el >= steps[si].at) {
        const st = steps[si++]
        try {
          await st.run(ctx)
        } catch (e) {
          console.error('  步骤失败 @' + st.at + 'ms：' + e.message)
          throw e
        }
      }
      // 抓 JPEG 而不是 PNG：真正慢的是 PNG 编码（每帧 ~90ms）。
      // optimizeForSpeed 是 CDP 专为录屏加的开关，q92 的这点噪声在收回 128 色调色板后
      // 本来就看不出来，用它把抓帧从 5-6fps 拉到 8-10fps。
      const png = await cdp.send('Page.captureScreenshot',
        { format: 'jpeg', quality: 90, optimizeForSpeed: true })
      const file = 'f' + String(frames.length).padStart(3, '0') + '.jpg'
      writeFileSync(join(dir, file), Buffer.from(png.data, 'base64'))
      frames.push({ file, t: Date.now() - t0 })
    }
    const fps = (frames.length / ((frames[frames.length - 1].t - frames[0].t) / 1000)).toFixed(1)
    const tailOk = await evalJs(`document.body.innerText.indexOf('演示数据') >= 0`)
    console.log(`  帧 ${frames.length} 张，实测 ${fps} fps，跨度 ${(frames[frames.length - 1].t - frames[0].t) / 1000}s`)
    console.log(`  「演示数据」条：开头 ${bannerOk ? '在' : '不在'} / 结尾 ${tailOk ? '在' : '不在'}`)
    if (!tailOk) throw new Error(name + '：结尾时演示数据条不见了')

    writeFileSync(join(dir, 'timings.json'), JSON.stringify(frames))
    results.push({ name, dir })
  }

  try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
  if (cdp) cdp.close()
  browser.close()

  // 合成 GIF + 抽两帧存档（首帧 / 中帧），全部交给 Pillow（见 scripts/build-gif.py）
  for (const r of results) {
    const out = join(OUT_ASSETS, 'flow-' + r.name + '.gif')
    const py = spawnSync(PYTHON, [join(ROOT, 'scripts', 'build-gif.py'), r.dir, out, OUT_REVIEW,
      '--width', '720', '--max-mb', '2.5'], { encoding: 'utf8' })
    if (py.status !== 0) {
      console.error('\nGIF 合成失败（' + PYTHON + '）：\n' + (py.stderr || '').slice(0, 1200))
      console.error('PNG 帧留在 ' + r.dir + '，可手工执行：')
      console.error('  ' + PYTHON + ' scripts/build-gif.py "' + r.dir + '" "' + out + '" "' + OUT_REVIEW + '"')
      process.exitCode = 1
      continue
    }
    process.stdout.write(py.stdout)
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
