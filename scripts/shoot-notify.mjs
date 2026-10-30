/**
 * P1 通知设置页截图（v1.8.15）。
 *
 * 真 Chrome + CDP，DPR2，390×844；页面就是 lib/page.html 本身，只把宿主接口换成
 * 假数据（不发真实请求、不读本机文件、没有任何真实 webhook 地址）。
 *
 * 四张图：列表（亮）→ 添加表单（通用 webhook + form）→ 测试消息成功 → 列表（暗）。
 * 每张先做页面级自检：无横向溢出、可点元素 ≥44px、正文里没有完整地址、掩码可读。
 *
 * 用法：node scripts/shoot-notify.mjs
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
// 与仓库同级的评审目录（_ui-review/round20），不把本机绝对路径写进脚本。
const OUT = join(ROOT, '..', '_ui-review', 'round20')
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
// 两个通道：飞书（启用）+ 通用 form（关闭）。地址只有掩码，和宿主算法一致。
const NOTIFY = {
  ok: true,
  enabled: true,
  anyEnabled: true,
  limits: { maxChannels: 8, timeoutMs: 8000, attempts: 3, reasonMax: 30 },
  preview: '1 件事等你：pwsh · 删除 build/cache 下的…',
  channels: [
    {
      id: 'ntf-feishu', type: 'feishu', format: 'json', enabled: true,
      masked: 'https://open.feishu.cn/…/000…（已保存）',
    },
    {
      id: 'ntf-sct', type: 'webhook', format: 'form', enabled: false,
      masked: 'https://sctapi.ftqq.com/…/SCT…（已保存）',
    },
  ],
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
    if (path === '/taskwatch/notify/test') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => sendJson(res, { ok: true, status: 200, attempts: 1, error: '', tookMs: 420 }))
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

  profile = mkdtempSync(join(tmpdir(), 'tw-notify-shots-'))
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

  async function openNotifyPage(scheme, tag) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await cdp.send('Page.navigate', { url: base + '/taskwatch?warm=' + tag })
    await sleep(500)
    await evalJs(`try { localStorage.setItem('taskwatch.theme', ${JSON.stringify(scheme)}) } catch (e) {}; 'ok'`)
    await cdp.send('Page.navigate', { url: base + '/taskwatch?shot=' + tag + '&t=' + Date.now() + '#notify' })
    await sleep(1200)
    await evalJs(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)}); 'ok'`)
    await evalJs(`location.hash = '#notify'; 'ok'`)
    await waitFor(`!!document.querySelector('#notifyView') && !document.getElementById('notifyView').hidden
      && document.querySelectorAll('.ntf-row').length >= 2`, 6000, '通知页渲染')
    await sleep(350)
  }

  async function auditShot(name) {
    const audit = JSON.parse(await evalJs(`JSON.stringify((function () {
      var rows = [].slice.call(document.querySelectorAll('.ntf-row'))
        .filter(function (r) { return r.getBoundingClientRect().height > 0 })
      var btns = [].slice.call(document.querySelectorAll('.ntf-btn, .ntf-seg button, .ntf-add'))
        .filter(function (b) { return b.getBoundingClientRect().height > 0 })
      var masks = [].slice.call(document.querySelectorAll('.ntf-url'))
        .filter(function (p) { return p.getBoundingClientRect().height > 0 })
        .map(function (p) { return { text: p.textContent, cw: p.clientWidth, sw: p.scrollWidth } })
      return {
        docW: document.documentElement.scrollWidth,
        bodyW: document.body.scrollWidth,
        viewW: window.innerWidth,
        rows: rows.map(function (r) { return { h: Math.round(r.getBoundingClientRect().height),
          w: Math.round(r.getBoundingClientRect().width) } }),
        buttons: btns.map(function (b) { var r = b.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) } }),
        masks: masks,
        banner: (document.querySelector('#ntfBanner') || {}).innerText || '',
        bannerOn: (document.querySelector('#ntfBanner') || {}).className || '',
        text: document.body.innerText,
        theme: document.documentElement.getAttribute('data-theme')
      }
    })())`))
    check(name + ' 无横向溢出', audit.docW <= audit.viewW + 1 && audit.bodyW <= audit.viewW + 1,
      'doc=' + audit.docW + ' body=' + audit.bodyW + ' view=' + audit.viewW)
    check(name + ' 可点元素 ≥44px', audit.buttons.length === 0 || audit.buttons.every((b) => b.h >= 44),
      JSON.stringify(audit.buttons))
    check(name + ' 正文不含完整地址', !/open-apis\/bot\/v2\/hook\/[0-9a-f-]{8,}/i.test(audit.text) &&
      !/sctapi\.ftqq\.com\/SCT[0-9A-Za-z]{8,}/i.test(audit.text), audit.text.slice(0, 200))
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    console.log(`  ${name}.png ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)} theme=${audit.theme} ` +
      `rows=${audit.rows.length} btns=${audit.buttons.length}`)
    return audit
  }

  console.log('\n[1] 通知列表（亮色）')
  await openNotifyPage('light', 'notify')
  const listAudit = await auditShot('notify')
  check('横幅写「推送已开启」', /推送已开启/.test(listAudit.banner), listAudit.banner)
  check('掩码可读且带「（已保存）」', listAudit.masks.length === 2 &&
    listAudit.masks.every((m) => /（已保存）/.test(m.text)), JSON.stringify(listAudit.masks))
  check('掩码行不横向溢出', listAudit.masks.every((m) => m.sw <= m.cw + 1), JSON.stringify(listAudit.masks))
  check('两个通道都在（其一关闭）', listAudit.rows.length === 2, String(listAudit.rows.length))
  check('关闭态通道有「已关闭」标记', /已关闭/.test(await evalJs(`document.getElementById('ntfList').innerText`)))

  console.log('\n[2] 添加表单：通用 webhook + form')
  await evalJs(`(function () {
    var b = document.querySelector('[data-ntf-type="webhook"]');
    if (b) b.click();
    var f = document.querySelector('[data-ntf-format="form"]');
    if (f) f.click();
    var i = document.getElementById('ntfUrl');
    if (i) { i.value = 'https://sctapi.ftqq.com/SCTdemo.send'; i.blur() }
    // 滚到「添加通道」这个小标题：让整张表单在首屏里完整出现，而不是从半截按钮开始。
    var secs = document.querySelectorAll('.ntf-sec');
    if (secs.length > 1) secs[1].scrollIntoView({ block: 'start' });
    return 'ok'
  })()`)
  await sleep(400)
  // 这一屏要展示的是整张添加表单：滚到底，让「会收到什么」正好压在上沿当分区标题。
  await evalJs(`(function () {
    var b = document.getElementById('notifyBody')
    b.scrollTop = b.scrollHeight
    return 'ok'
  })()`)
  await sleep(120)
  const addAudit = await auditShot('notify-add')
  check('form 格式选择器可见（仅通用类型需要）', await evalJs(
    `!document.getElementById('ntfFormat').hidden && document.querySelector('[data-ntf-format="form"]').getAttribute('aria-pressed') === 'true'`))
  check('输入框在 390 宽内、表单按钮 48px', await evalJs(`(function () {
    var i = document.getElementById('ntfUrl').getBoundingClientRect()
    var a = document.getElementById('ntfAdd').getBoundingClientRect()
    return i.left >= 0 && i.right <= window.innerWidth + 1 && Math.round(a.height) >= 44
  })()`))
  check('添加截图里正文仍无完整地址', !/\/hook\/[0-9a-f-]{8,}/.test(addAudit.text))

  console.log('\n[3] 发一条测试消息 → 成功')
  // 回到默认的飞书类型并清空输入：这一步只需要"结果"这一个信息，不该把上一步的
  // 表单状态带进截图。
  await evalJs(`(function () {
    var b = document.querySelector('[data-ntf-type="feishu"]');
    if (b) b.click();
    var i = document.getElementById('ntfUrl');
    if (i) i.value = '';
    document.getElementById('notifyBody').scrollTop = 0;
    return 'ok'
  })()`)
  await evalJs(`(function () {
    var b = document.querySelector('.ntf-row.on [data-ntf-test]');
    if (b) b.click();
    return 'ok'
  })()`)
  await waitFor(`!!document.querySelector('.ntf-res.ok')`, 6000, '测试结果出现')
  const testText = await evalJs(`(document.querySelector('.ntf-res.ok') || {}).textContent || ''`)
  check('结果写清楚成功与 HTTP 码', /成功/.test(testText) && /HTTP 200/.test(testText), testText)
  await evalJs(`document.getElementById('notifyBody').scrollTop = 0; 'ok'`)
  await sleep(250)
  const testAudit = await auditShot('notify-test-ok')
  check('测试成功后横幅仍是已开启', /推送已开启/.test(testAudit.banner), testAudit.banner)

  console.log('\n[4] 通知列表（暗色）')
  await openNotifyPage('dark', 'notify-dark')
  const darkAudit = await auditShot('notify-dark')
  check('暗色主题确实生效', darkAudit.theme === 'dark', String(darkAudit.theme))
  check('暗色下掩码仍可读（无溢出）', darkAudit.masks.every((m) => m.sw <= m.cw + 1), JSON.stringify(darkAudit.masks))

  // 顺带把评审图放进仓库的 docs/screenshots/current/，README 直接引用。
  try {
    copyFileSync(join(OUT, 'notify.png'), join(ROOT, 'docs', 'screenshots', 'current', 'notify.png'))
    console.log('  已同步 docs/screenshots/current/notify.png')
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
    console.log('\n四张通知页截图通过：无横向溢出、命中区 ≥44px、掩码可读、正文无完整地址。')
  }
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
