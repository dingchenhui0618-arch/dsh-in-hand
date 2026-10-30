/**
 * v1.8.17 系统通知（Web Push）设置页截图。
 *
 * 真 Chrome + CDP，DPR2，390×844。页面就是 lib/page.html 本身，宿主接口换成假数据：
 * 没有任何真实 endpoint、没有真实推送服务、不读本机文件。
 *
 * 四张图，正好是四种"人真正会遇到的状态"：
 *   1. push-on        已开启 2 台设备（亮色）
 *   2. push-ios-guide iPhone + 不在主屏幕 → 只给三步引导，不给开启按钮
 *   3. push-denied    通知权限被拒 → 只给恢复路径，且**不再请求权限**
 *   4. push-dark      已开启（暗色）
 *
 * 每张先做页面级自检：无横向溢出、可点元素 ≥44px、正文里没有完整 endpoint、
 * 状态文案与按钮组符合状态机。
 *
 * 用法：node scripts/shoot-webpush.mjs
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
const OUT = join(ROOT, '..', '_ui-review', 'round22')
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

const NOW = Date.now()
const DATA = {
  generatedAt: NOW,
  offline: false,
  errors: [],
  riskConfirm: true,
  totals: { sessions: 1, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
  today: { since: NOW - 6 * 3600_000, turns: 0, steps: 0, sessions: 0, partial: false },
  pending: [], sessions: [], jobs: [], subagents: [], workflows: [],
}
const NOTIFY = {
  ok: true,
  enabled: true,
  anyEnabled: false,
  limits: { maxChannels: 8, timeoutMs: 8000, attempts: 3, reasonMax: 30 },
  preview: '1 件事等你：pwsh · 删除 build/cache 下的…',
  channels: [
    {
      id: 'ntf-feishu', type: 'feishu', format: 'json', enabled: true,
      masked: 'https://open.feishu.cn/…/000…（已保存）',
    },
  ],
}

/** 服务器按场景切换"这台/这些设备开了几条"。摘要里同样只有掩码。 */
let pushScenario = 'on'
function pushState() {
  if (pushScenario === 'denied') {
    return {
      ok: true, vapid: 'BA' + 'A'.repeat(85), devices: 0, total: 0, mine: 0,
      limits: { total: 20, perDevice: 5, endpointMax: 1024 }, subscriptions: [],
    }
  }
  // iOS 未加到主屏幕：这台手机开不了，所以 mine=0；另一台设备已经开着。
  const ios = pushScenario === 'ios'
  const subs = [
    {
      id: 'push-phone', masked: 'https://fcm.googleapis.com/…/AbCdEf',
      uaShort: 'Chrome · Android', origin: 'https://dsh.example.com',
      createdAt: NOW - 3 * 86400_000, lastOkAt: NOW - 120000, mine: !ios,
    },
    {
      id: 'push-old', masked: 'https://fcm.googleapis.com/…/Zx9Qw3',
      uaShort: 'Safari · iOS', origin: 'https://dsh.example.com',
      createdAt: NOW - 20 * 86400_000, lastOkAt: null, mine: false,
    },
  ]
  return {
    ok: true, vapid: 'BA' + 'A'.repeat(85),
    devices: ios ? 1 : 2, total: ios ? 1 : 2, mine: ios ? 0 : 1,
    limits: { total: 20, perDevice: 5, endpointMax: 1024 },
    subscriptions: ios ? subs.slice(0, 1) : subs,
  }
}

const sendJson = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
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
  const html = readFileSync(PAGE, 'utf8')
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (path === '/taskwatch/data') { sendJson(res, DATA); return }
    if (path === '/taskwatch/chat/sessions') { sendJson(res, { sessions: [] }); return }
    if (path === '/taskwatch/chat/usage') { sendJson(res, {}); return }
    if (path === '/taskwatch/chat/titles') { sendJson(res, {}); return }
    if (path === '/taskwatch/notify') { sendJson(res, NOTIFY); return }
    if (path === '/taskwatch/push/state') { sendJson(res, pushState()); return }
    if (path === '/taskwatch/push/test') {
      req.resume()
      req.on('end', () => sendJson(res, {
        ok: true, sent: 1, failed: 0,
        results: [{ id: 'push-phone', masked: 'https://fcm.googleapis.com/…/AbCdEf', ok: true, status: 201, error: '' }],
        tookMs: 380,
      }))
      return
    }
    if (path === '/taskwatch/approvals/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      res.write(': connected\n\n')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-push-shots-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=2',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const port = await waitPort(profile, child)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const info = targets.find((t) => t.id === targetId)
  if (!info) throw new Error('找不到 target')
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }
  const waitFor = async (expression, timeout, label) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evalJs(expression)) return true
      await sleep(100)
    }
    throw new Error('超时：' + label)
  }

  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'

  /** 打开通知页。#focus 里给要断言的那一块让路：滚到「系统通知」标题。 */
  let denyScriptId = ''
  async function openNotifyPage({ scheme, ua, tag, deny }) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'zh-CN' })
    // addScriptToEvaluateOnNewDocument 会对**之后每一次**导航生效：不摘掉的话，
    // 后面那张暗色图也会带着"权限已拒绝"启动，状态就错了。
    if (denyScriptId) {
      try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: denyScriptId }) } catch { /* 已移除 */ }
      denyScriptId = ''
    }
    // 把"权限已被拒绝"装进页面加载前：这样 page 脚本里第一次读 Notification.permission
    // 就是 denied，走的是真实的 denied 分支，而不是被 JS 事后改出来的。
    if (deny) {
      const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: "Object.defineProperty(window,'Notification',{configurable:true,value:{"
          + "permission:'denied',"
          + "requestPermission:function(){window.__twAsk=(window.__twAsk||0)+1;return Promise.resolve('denied')}"
          + "}});",
      })
      denyScriptId = added.identifier
    }
    await cdp.send('Page.navigate', { url: base + '/taskwatch?warm=' + tag })
    await sleep(500)
    await evalJs(`try { localStorage.setItem('taskwatch.theme', ${JSON.stringify(scheme)}) } catch (e) {}; 'ok'`)
    await cdp.send('Page.navigate', { url: base + '/taskwatch?shot=' + tag + '&t=' + Date.now() + '#notify' })
    await sleep(1200)
    await evalJs(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)}); 'ok'`)
    await evalJs(`location.hash = '#notify'; 'ok'`)
    await waitFor(`!!document.querySelector('#notifyView') && !document.getElementById('notifyView').hidden
      && document.getElementById('ntfPushState').textContent !== '正在读取…'`, 8000, '系统通知区块渲染')
    // 从顶部开始：首屏要同时看到「推送已开启」横幅与系统通知卡片。
    // （滚动到 .ntf-sec 的话，h3 会正好躲进顶部那条固定标题栏后面。）
    await evalJs(`(function () {
      var body = document.getElementById('notifyBody')
      if (body) body.scrollTop = 0
      return 'ok'
    })()`)
    await sleep(350)
  }

  async function auditShot(name) {
    const audit = JSON.parse(await evalJs(`JSON.stringify((function () {
      var vis = function (el) { var r = el.getBoundingClientRect(); return r.height > 0 && r.width > 0 }
      var btns = [].slice.call(document.querySelectorAll('#ntfPush button')).filter(vis)
      var card = document.getElementById('ntfPush').getBoundingClientRect()
      var guide = document.getElementById('ntfPushGuide')
      var res = document.getElementById('ntfPushRes')
      return {
        docW: document.documentElement.scrollWidth,
        bodyW: document.body.scrollWidth,
        viewW: window.innerWidth,
        state: document.getElementById('ntfPushState').textContent,
        note: document.getElementById('ntfPushNote').textContent,
        count: document.getElementById('ntfPushCount').textContent,
        banner: document.getElementById('ntfBanner').innerText,
        bannerOn: document.getElementById('ntfBanner').className,
        buttons: btns.map(function (b) { var r = b.getBoundingClientRect();
          return { text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) } }),
        onVisible: !!document.getElementById('ntfPushOn').getBoundingClientRect().height,
        testVisible: !!document.getElementById('ntfPushTest').getBoundingClientRect().height,
        offVisible: !!document.getElementById('ntfPushOff').getBoundingClientRect().height,
        guideVisible: !guide.hidden && guide.getBoundingClientRect().height > 0,
        result: res.textContent,
        card: { x: Math.round(card.left), w: Math.round(card.width), h: Math.round(card.height) },
        theme: document.documentElement.getAttribute('data-theme'),
        text: document.body.innerText,
        asks: window.__twAsk || 0
      }
    })())`))
    check(name + ' 无横向溢出', audit.docW <= audit.viewW + 1 && audit.bodyW <= audit.viewW + 1,
      'doc=' + audit.docW + ' body=' + audit.bodyW + ' view=' + audit.viewW)
    check(name + ' 可点元素 ≥44px', audit.buttons.every((b) => b.h >= 44), JSON.stringify(audit.buttons))
    check(name + ' 卡片不超出视口', audit.card.x >= 0 && audit.card.x + audit.card.w <= audit.viewW + 1,
      JSON.stringify(audit.card))
    check(name + ' 正文/界面里没有完整 endpoint',
      !/fcm\.googleapis\.com\/(?!…)/.test(audit.text) && !/AbCdEf\b/.test(audit.text.replace(/…\/AbCdEf/g, '')),
      audit.text.slice(0, 240))
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    console.log(`  ${name}.png ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} theme=${audit.theme} `
      + `state="${audit.state}" btns=${audit.buttons.length}`)
    return audit
  }

  console.log('\n[1] 已开启 2 台设备（亮色）')
  pushScenario = 'on'
  await openNotifyPage({ scheme: 'light', ua: DESKTOP_UA, tag: 'push-on' })
  const on = await auditShot('push-on')
  check('状态写「已开启 2 台设备」', on.state === '已开启 2 台设备', on.state)
  check('横幅把系统通知算进「推送已开启」', /推送已开启/.test(on.banner) && /2 台设备的系统通知/.test(on.banner), on.banner)
  check('这台设备已开 → 只出「测试 / 关闭」，不出「开启」', on.testVisible && on.offVisible && !on.onVisible,
    JSON.stringify({ on: on.onVisible, test: on.testVisible, off: on.offVisible }))
  check('两个按钮文案对得上', on.buttons.map((b) => b.text).join('|') === '发一条测试通知|关闭此设备',
    on.buttons.map((b) => b.text).join('|'))
  check('订阅条数小字可见', on.count === '2 条订阅', on.count)
  check('没有 iOS 引导', !on.guideVisible)

  console.log('\n[2] iPhone 未添加到主屏幕')
  pushScenario = 'ios'
  await openNotifyPage({ scheme: 'light', ua: IPHONE_UA, tag: 'push-ios' })
  const ios = await auditShot('push-ios-guide')
  check('状态是「需要添加到主屏幕」', ios.state === '需要添加到主屏幕', ios.state)
  check('出现三步引导', ios.guideVisible)
  check('引导里没有任何动作按钮（点了也没用）', ios.buttons.length === 0,
    JSON.stringify({ on: ios.onVisible, test: ios.testVisible, off: ios.offVisible }))
  check('说明里写清 iOS 16.4 与主屏幕', /iOS 16\.4/.test(ios.text) && /主屏幕/.test(ios.text) &&
    /分享/.test(ios.text), ios.text.slice(0, 260))

  console.log('\n[3] 通知权限被拒绝')
  pushScenario = 'denied'
  await openNotifyPage({ scheme: 'light', ua: DESKTOP_UA, tag: 'push-denied', deny: true })
  const denied = await auditShot('push-denied')
  check('状态是「未开启」', denied.state === '未开启', denied.state)
  check('说明给出恢复路径且说明不再弹窗', /恢复办法/.test(denied.note) && /不会再弹窗/.test(denied.note),
    denied.note)
  check('被拒时没有任何按钮（不引诱用户重试）', denied.buttons.length === 0, JSON.stringify(denied.buttons))
  check('页面从未调用 requestPermission', denied.asks === 0, String(denied.asks))

  console.log('\n[4] 已开启（暗色）')
  pushScenario = 'on'
  await openNotifyPage({ scheme: 'dark', ua: DESKTOP_UA, tag: 'push-dark' })
  const dark = await auditShot('push-dark')
  check('暗色主题确实生效', dark.theme === 'dark', String(dark.theme))
  check('暗色下状态相同', dark.state === '已开启 2 台设备', dark.state)

  // 四张图里都没有「未开启」这个状态，但它是新用户第一眼看到的那一屏 ——
  // 主按钮（.ntf-btn.primary）用的是 accent 令牌，明暗两套都得能读。
  // 不额外截图，直接在两种主题下算对比度。
  console.log('\n[5] 「未开启」主按钮的对比度（亮 / 暗）')
  const contrast = JSON.parse(await evalJs(`(function () {
    PUSH.mine = 0; PUSH.devices = 0; PUSH.supported = true; PUSH.permission = 'default';
    PUSH.ios = false; PUSH.standalone = false; renderPush();
    var btn = document.getElementById('ntfPushOn')
    function lum(c) {
      var nums = String(c).match(/[0-9.]+/g) || ['0', '0', '0']
      var rgb = nums.slice(0, 3).map(Number).map(function (v) {
        v = v / 255
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    }
    function ratio() {
      var s = getComputedStyle(btn)
      var a = lum(s.color), b = lum(s.backgroundColor)
      var hi = Math.max(a, b), lo = Math.min(a, b)
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
    }
    var bg = getComputedStyle(btn).backgroundColor
    var light = ratio()
    document.documentElement.setAttribute('data-theme', 'dark')
    var darkRatio = ratio()
    document.documentElement.setAttribute('data-theme', 'light')
    var h = Math.round(btn.getBoundingClientRect().height)
    var txt = btn.textContent.trim()
    loadPush()
    return JSON.stringify({ light: light, dark: darkRatio, bg: bg, h: h, text: txt })
  })()`))
  check('主按钮有实底色（不是透明）', /^rgb/.test(contrast.bg) && contrast.bg !== 'rgba(0, 0, 0, 0)', contrast.bg)
  check('主按钮亮色对比度 ≥4.5', contrast.light >= 4.5, String(contrast.light))
  check('主按钮暗色对比度 ≥4.5', contrast.dark >= 4.5, String(contrast.dark))
  check('主按钮文案与高度（≥44px）', contrast.text === '开启系统通知' && contrast.h >= 44,
    JSON.stringify({ text: contrast.text, h: contrast.h }))

  try {
    copyFileSync(join(OUT, 'push-on.png'), join(ROOT, 'docs', 'screenshots', 'current', 'push-on.png'))
    console.log('  已同步 docs/screenshots/current/push-on.png')
  } catch (e) {
    console.log('  跳过同步仓库截图：' + (e && e.message))
  }

  try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
  cdp.close()
  browser.close()

  if (failures.length) {
    console.error('\n截图自检失败：\n  ' + failures.join('\n  '))
    process.exitCode = 1
  } else {
    console.log('\n四张系统通知截图通过：无横向溢出、命中区 ≥44px、状态机与按钮一致、界面无完整 endpoint。')
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
