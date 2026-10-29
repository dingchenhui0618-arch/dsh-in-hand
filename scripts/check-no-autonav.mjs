#!/usr/bin/env node
/**
 * 入口自动跳转的回归自检（v1.7.5）。
 *
 * 背景：v1.6.0 – v1.7.4 的手机页会在**初始加载**与**每 12 秒的上游体检**之后
 * 重新判断「该走哪条路」，判断出「该换」就直接改地址。两条路的信号一旦互相矛盾，
 * 页面就在两个入口之间无限往返 —— 用户看到的是地址栏来回变、整页反复刷新。
 *
 * 这份自检分两层：
 *
 *   1. **静态**（任何机器都跑，缺了就是失败）
 *      - 路由脚本里只允许有一处改地址，且必须发生在 navigateOnce 里；
 *      - 没有 reload / assign / replace，没有任何定时器；
 *      - 初始加载分支（entries 的 then/catch）既不读也不写地址，也不签票；
 *      - 8 秒 sessionStorage 护栏、?t= 的 replaceState 清理与锁定都在；
 *      - service worker 的 CACHE 已经跟着升到 taskwatch-v25。
 *
 *   2. **真实浏览器**（本机有 Chrome 才跑，没有则 SKIP）
 *      用 Chrome headless + CDP 加载真实 page.html，并 mock 出「旧代码会立刻在两个
 *      入口之间往返」的那种信号：入口清单两条、上游体检失败、旧偏好是局域网。
 *      断言 20 秒（虚拟时间）内主框架只导航了 1 次、没有签过票、地址没变；
 *      再断言 ?t= 落地会被清掉并锁定入口；最后断言手动点另一个入口只跳一次。
 *
 * 不联网、不碰真实中继与用户会话；Chrome 用临时 profile，跑完即删。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { readDevToolsPort } from './devtools-port.mjs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let failures = 0
let skipped = 0
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`  ${mark}  ${label}${detail && !condition ? ' -> ' + detail : ''}`)
}
function skip(label, why) {
  skipped++
  console.log(`  SKIP  ${label}${why ? ' -> ' + why : ''}`)
}
function section(title) {
  console.log('\n' + title)
}

const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')
const sw = readFileSync(join(ROOT, 'lib', 'sw.js'), 'utf8')

// ── 1. 定位「双入口」那段脚本 ────────────────────────────────────────────
section('[1] 换路脚本的边界')

const BEGIN = '/* ROUTE-SAFETY-BEGIN'
const END = '/* ROUTE-SAFETY-END */'
const beginAt = page.indexOf(BEGIN)
const endAt = page.indexOf(END)
check('page.html 里有 ROUTE-SAFETY 标记', beginAt >= 0 && endAt > beginAt,
  `begin=${beginAt} end=${endAt}`)
if (beginAt < 0 || endAt <= beginAt) {
  console.log('\n找不到换路脚本边界，后面的静态断言无法进行。')
  process.exit(1)
}
check('边界只出现一次', page.indexOf(BEGIN, beginAt + 1) < 0 && page.indexOf(END, endAt + 1) < 0)
const route = page.slice(beginAt, endAt)
check('换路脚本不是空壳', route.length > 4000, `实际 ${route.length} 字符`)

// 每个内联脚本都要能编译：page.html 的脚本没有构建步骤，写错了只有真机才会发现。
const scripts = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1])
let compileError = ''
for (let i = 0; i < scripts.length; i++) {
  try { new Function(scripts[i]) } catch (e) { compileError = `#${i + 1}: ${e.message}`; break }
}
check('page.html 的每个内联脚本都能编译', compileError === '' && scripts.length >= 3,
  compileError || `脚本数 ${scripts.length}`)

// ── 2. 导航只能有一个出口 ────────────────────────────────────────────────
section('[2] 导航出口与初始加载路径')

const navWrites = route.match(/location\.(?:href|assign|replace)\s*=/g) || []
check('路由脚本里只有一处改地址', navWrites.length === 1, `实际 ${navWrites.length} 处`)
check('没有 location.reload', !/location\.reload\s*\(/.test(route))
check('没有 location.replace', !/location\.replace\s*\(/.test(route))
check('没有 location.assign', !/location\.assign\s*\(/.test(route))
check('没有任何定时器（自动判定最怕这个）',
  !/\b(?:setInterval|setTimeout|requestAnimationFrame)\s*\(/.test(route))

const navIdx = route.search(/location\.href\s*=/)
const navFnIdx = route.indexOf('function navigateOnce(')
const fnAfterNav = route.indexOf('\n    function ', navFnIdx + 1)
check('唯一改地址发生在 navigateOnce 的函数体里',
  navFnIdx >= 0 && navIdx > navFnIdx && (fnAfterNav < 0 || navIdx < fnAfterNav),
  `navigateOnce@${navFnIdx} location.href@${navIdx} next@${fnAfterNav}`)

const navFn = route.slice(navFnIdx, fnAfterNav > 0 ? fnAfterNav : undefined)
check('navigateOnce 先过 8 秒护栏再写标记',
  /guardWait\(\)/.test(navFn) && /if\s*\(wait\s*>\s*0\)/.test(navFn) &&
  navFn.indexOf('guardWait()') < navFn.indexOf('writeSession(JUMP_KEY'))
check('navigateOnce 是唯一的跳转调用点',
  (route.match(/navigateOnce\s*\(/g) || []).length === 2, // 定义 + 调用
  `实际 ${(route.match(/navigateOnce\s*\(/g) || []).length} 次`)

const jumpIdx = route.indexOf('function jump(')
const applyIdx = route.indexOf('function apply(')
check('jump() 在读响应后才调用 navigateOnce',
  jumpIdx >= 0 && route.slice(jumpIdx, applyIdx).includes('navigateOnce(j.url, kind)'))

const applyEnd = route.indexOf('var css = document.createElement')
const applyBody = route.slice(applyIdx, applyEnd > applyIdx ? applyEnd : undefined)
check('apply() 只渲染：不读地址、不签票、不跳转',
  applyBody.length > 100 && !/location\./.test(applyBody) &&
  !/\/taskwatch\/ticket/.test(applyBody) && !/navigateOnce/.test(applyBody),
  applyBody.slice(0, 120))

const entriesIdx = route.indexOf("fetch('/taskwatch/entries'")
const entriesBranch = route.slice(entriesIdx)
check('初始加载的 entries 分支不导航、不签票',
  entriesIdx > 0 && !/location\./.test(entriesBranch) &&
  !/navigateOnce/.test(entriesBranch) && !/\/taskwatch\/ticket/.test(entriesBranch))
check('页面不再请求 upstream-health（自动体检已删）',
  !/['"]\/taskwatch\/upstream-health['"]/.test(page))
check('旧的三态偏好（tw-route-pref）已从页面移除', !page.includes('tw-route-pref'))

// ── 3. 双重护栏 ──────────────────────────────────────────────────────────
section('[3] 双重护栏：8 秒跳转标记 + ?t= 清理与锁定')

check('护栏常量是 8 秒', /JUMP_GUARD_MS\s*=\s*8000/.test(route))
check('跳转标记写在 sessionStorage', /JUMP_KEY\s*=\s*'tw-route-jump'/.test(route) &&
  /writeSession\(JUMP_KEY,\s*JSON\.stringify\(\{\s*at:\s*at/.test(route))
check('8 秒内已有标记就拒绝（返回 false 而不是继续）',
  /return false/.test(navFn) && /guardWait\(\)/.test(navFn))
check('落地时用 history.replaceState 清掉 ?t=', /history\.replaceState\(null,\s*''/.test(route) &&
  /searchParams/.test(route) && /has\('t'\)/.test(route) && /delete\('t'\)/.test(route))
check('落地后把入口锁起来', /LAND|locked/.test(route) &&
  /LOCK_KEY\s*=\s*'tw-route-lock'/.test(route) && /writeSession\(LOCK_KEY,\s*locked\)/.test(route))
check('锁定入口优先于服务端判断（地址是事实，锁兜底）',
  /function currentKind\(\)[\s\S]{0,400}?guessCurrent\(\)/.test(route))

check("sw.js 的 CACHE 已升到 taskwatch-v25", /const CACHE = 'taskwatch-v25'/.test(sw))
check('page.html 里不再出现 taskwatch-v14', !page.includes('taskwatch-v14'))

// ── 4. 真实浏览器：初始加载不自跳 ───────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────
async function dynamicChecks(chrome) {
  const profile = mkdtempSync(join(tmpdir(), 'tw-autonav-chrome-'))
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=390,844',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let serverA = null
  let serverB = null
  let browserWs = null
  try {
    const port = await waitForDevToolsPort(profile, child)
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    browserWs = await Cdp.connect(version.webSocketDebuggerUrl)
    browserWs.port = port

    const started = await startServers()
    serverA = started.a
    serverB = started.b
    const baseA = `http://127.0.0.1:${serverA.address().port}`
    const baseB = `http://127.0.0.1:${serverB.address().port}`

    // ── 场景 1：旧代码会在这组信号下立刻在两个入口之间往返 ──────────────
    const mock1 = `
      (function () {
        var orig = window.fetch;
        var prev = 0;
        try { var m = /^tw-tickets:(\\d+)$/.exec(window.name); if (m) prev = Number(m[1]); } catch (e) {}
        window.__ticketCalls = prev;
        window.__healthCalls = 0;
        function json(v) {
          return Promise.resolve(new Response(JSON.stringify(v), {
            status: 200, headers: { 'content-type': 'application/json' } }))
        }
        window.fetch = function (u, o) {
          var p = String(u).split('?')[0];
          if (p === '/taskwatch/entries') return json({ ok: true,
            remote: 'https://remote.example', lan: ['http://10.0.0.9:3099/taskwatch'],
            current: 'remote' });
          if (p === '/taskwatch/upstream-health') {
            window.__healthCalls++;
            return json({ ok: false });
          }
          if (p === '/taskwatch/ticket') {
            window.__ticketCalls++;
            try { window.name = 'tw-tickets:' + window.__ticketCalls; } catch (e) {}
            return json({ ok: true, to: 'lan',
              url: 'http://10.0.0.9:3099/taskwatch?t=demo' });
          }
          return orig.apply(this, arguments);
        };
        try { localStorage.setItem('tw-route-pref', 'lan'); } catch (e) {}
      })();
    `
    const s1 = await openPage(browserWs, mock1)
    let navs1 = 0
    s1.cdp.on('Page.frameNavigated', (p) => { if (!p.frame.parentId) navs1++ })
    const load1 = s1.cdp.waitFor('Page.loadEventFired', 10000)
    await s1.cdp.send('Page.navigate', { url: baseA + '/taskwatch' })
    await load1
    await sleep(400)
    const afterLoad = await s1.eval(`({ href: location.href, tickets: window.__ticketCalls || 0,
      health: window.__healthCalls || 0 })`)
    const virtual = await advanceVirtualTime(s1.cdp, 20000)
    await sleep(300)
    const after20 = await s1.eval(`({ href: location.href, tickets: window.__ticketCalls || 0,
      health: window.__healthCalls || 0, pill: !!(document.getElementById('tw-route-pill') &&
      document.getElementById('tw-route-pill').style.display !== 'none') })`)
    check('初始加载后地址没变', afterLoad.href === baseA + '/taskwatch', afterLoad.href)
    check('初始加载没有签换路票', afterLoad.tickets === 0, `ticket 调用 ${afterLoad.tickets} 次`)
    check('初始加载不请求上游体检', afterLoad.health === 0, `health 调用 ${afterLoad.health} 次`)
    check('20 秒（虚拟时间）内主框架只导航 1 次', navs1 === 1,
      `实际 ${navs1} 次（虚拟时间预算已用尽：${virtual}）`)
    check('20 秒后地址仍然没变', after20.href === baseA + '/taskwatch', after20.href)
    check('20 秒后仍然没有签票', after20.tickets === 0, `ticket 调用 ${after20.tickets} 次`)
    check('两条入口都已知时胶囊显示', after20.pill === true)
    await s1.close()

    // ── 场景 2：?t= 落地 → 立刻清参数并锁定入口 ──────────────────────────
    const s2 = await openPage(browserWs, mock1)
    let navs2 = 0
    s2.cdp.on('Page.frameNavigated', (p) => { if (!p.frame.parentId) navs2++ })
    const load2 = s2.cdp.waitFor('Page.loadEventFired', 10000)
    await s2.cdp.send('Page.navigate', { url: baseA + '/taskwatch?t=v2.demo.ticket' })
    await load2
    await sleep(500)
    const landed = await s2.eval(`({ href: location.href, search: location.search,
      lock: sessionStorage.getItem('tw-route-lock'), navs: ${navs2} })`)
    check('?t= 被 replaceState 清掉', landed.search === '' && landed.href === baseA + '/taskwatch',
      landed.href)
    check('落地后入口被锁定（当前项）', landed.lock === 'remote', String(landed.lock))
    check('落地本身只算一次导航', navs2 === 1, `实际 ${navs2} 次`)
    await s2.close()

    // ── 场景 3：8 秒护栏 + 手动切换只跳一次 ─────────────────────────────
    const mock3 = mock1.replace("lan: ['http://10.0.0.9:3099/taskwatch']", `lan: ['${baseB}/taskwatch']`)
      .replace("url: 'http://10.0.0.9:3099/taskwatch?t=demo'", `url: '${baseB}/taskwatch?t=demo'`)
    const s3 = await openPage(browserWs, mock3)
    let navs3 = 0
    s3.cdp.on('Page.frameNavigated', (p) => { if (!p.frame.parentId) navs3++ })
    const load3 = s3.cdp.waitFor('Page.loadEventFired', 10000)
    await s3.cdp.send('Page.navigate', { url: baseA + '/taskwatch' })
    await load3
    await sleep(500)

    // 3a. 先种一个「刚刚跳过」的标记：点另一个入口必须被拒绝，且不签票。
    const guarded = await s3.eval(`(function () {
      sessionStorage.setItem('tw-route-jump', JSON.stringify({ at: Date.now(), to: 'lan' }));
      document.getElementById('tw-route-pill').click();
      var row = document.querySelector('#tw-route-menu .tw-entry[data-kind="lan"]');
      if (row) row.click();
      return { tickets: window.__ticketCalls || 0,
        status: (document.querySelector('#tw-route-menu .tw-mstatus') || {}).textContent || '',
        href: location.href };
    })()`)
    await sleep(400)
    const guardedAfter = await s3.eval(`({ tickets: window.__ticketCalls || 0, href: location.href,
      status: (document.querySelector('#tw-route-menu .tw-mstatus') || {}).textContent || '' })`)
    check('8 秒内第二次跳转被拒绝（不签票）', guardedAfter.tickets === 0,
      `ticket 调用 ${guardedAfter.tickets} 次`)
    check('8 秒内第二次跳转有静态提示', /刚刚切换过/.test(guardedAfter.status),
      guardedAfter.status)
    check('被护栏拦下时地址没变', guardedAfter.href === baseA + '/taskwatch', guardedAfter.href)

    // 3b. 清掉标记后再点一次：签一张票、跳一次，落到另一个 origin。
    const jump = await s3.eval(`(function () {
      sessionStorage.removeItem('tw-route-jump');
      document.getElementById('tw-route-pill').click();
      var row = document.querySelector('#tw-route-menu .tw-entry[data-kind="lan"]');
      if (!row) return { clicked: false };
      row.click();
      return { clicked: true };
    })()`)
    check('胶囊里列得出两个入口（另一个可点）', jump.clicked === true)
    await sleep(1200)
    const afterJump = await s3.eval(`({ href: location.href, search: location.search,
      origin: location.origin, tickets: window.__ticketCalls || 0 })`)
    check('手动切换真的跳到了另一个入口', afterJump.origin === baseB, afterJump.origin)
    check('落地地址的 ?t= 已经清掉', afterJump.search === '', afterJump.href)
    check('手动切换只签一次票', afterJump.tickets === 1, `ticket 调用 ${afterJump.tickets} 次`)
    await sleep(2500)
    check('落地后没有自动跳回去（总导航 2 次：初始 + 手动）', navs3 === 2,
      `实际 ${navs3} 次`)
    await s3.close()

    // 浏览器层：会话结束，关掉临时 target 即可（Chrome 由 finally 收掉）。
  } finally {
    if (browserWs) browserWs.close()
    if (serverA) serverA.close()
    if (serverB) serverB.close()
    await stopChrome(child)
    try { rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  }
}

// ── 本地两个 origin：服务真实 page.html，接口由页面内 mock 接住 ───────────
async function startServers() {
  const make = (label) => createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/taskwatch' || url.pathname === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(page)
      return
    }
    if (url.pathname === '/taskwatch/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(sw)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(label + ' not found')
  })
  const a = make('A')
  const b = make('B')
  await new Promise((resolve) => a.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => b.listen(0, '127.0.0.1', resolve))
  return { a, b }
}

// ── 极简 CDP 客户端 ─────────────────────────────────────────────────────
class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    return new Cdp(ws)
  }
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.waiters = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
        return
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) {
          try { fn(msg.params) } catch (e) {}
        }
        const waiting = this.waiters.get(msg.method)
        if (waiting && waiting.length) {
          const w = waiting.shift()
          clearTimeout(w.timer)
          w.resolve(msg.params)
        }
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }
  waitFor(method, timeout = 10000) {
    if (!this.waiters.has(method)) this.waiters.set(method, [])
    return new Promise((resolve) => {
      const entry = { resolve, timer: setTimeout(() => resolve(null), timeout) }
      this.waiters.get(method).push(entry)
    })
  }
  close() { try { this.ws.close() } catch (e) {} }
}

async function openPage(browser, injectSource) {
  const created = await browser.send('Target.createTarget', { url: 'about:blank' })
  const targetId = created.targetId
  const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()
  const info = list.find((t) => t.id === targetId)
  if (!info || !info.webSocketDebuggerUrl) throw new Error('找不到 target 的调试地址')
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  cdp.port = browser.port
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  })
  if (injectSource) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injectSource })
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }
  return {
    cdp,
    targetId,
    eval: evaluate,
    close: async () => {
      try { await browser.send('Target.closeTarget', { targetId }) } catch (e) {}
      cdp.close()
    },
  }
}

async function advanceVirtualTime(cdp, budget) {
  const expired = cdp.waitFor('Emulation.virtualTimeBudgetExpired', 6000)
  await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget })
  const ok = await expired
  // 兜底：Chrome 没回事件时用真实时间补足，避免把「没等到」当成「没导航」。
  if (!ok) await sleep(Math.min(21000, budget + 500))
  return ok !== null
}

async function waitForDevToolsPort(profile, child) {
  const file = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Chrome 启动即退出，exitCode=' + child.exitCode)
    const port = readDevToolsPort(file)
    if (port) return Number(port)
    await sleep(100)
  }
  throw new Error('等不到 DevToolsActivePort（Chrome 没有启动？）')
}

async function stopChrome(child) {
  if (child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGTERM')
    }
  } catch (e) {}
  await sleep(300)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ── 执行第 4 节（放在所有声明之后：class 不会提升）──────────────────────
section('[4] 真实浏览器（Chrome headless + CDP）')

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chromePath) {
  skip('初始加载 20 秒内不导航', '本机没有 Chrome（设 CHROME_PATH 可启用）')
  skip('?t= 清理与锁定', '本机没有 Chrome')
  skip('手动切换只跳一次', '本机没有 Chrome')
} else {
  try {
    await dynamicChecks(chromePath)
  } catch (e) {
    failures++
    console.log('  FAIL  真实浏览器自检异常 -> ' + ((e && e.stack) || e))
  }
}

console.log('')
if (failures) {
  console.log(`FAIL: ${failures} 项未通过${skipped ? `，${skipped} 项跳过` : ''}`)
  process.exit(1)
}
console.log(`PASS: 入口自动跳转自检通过${skipped ? `（${skipped} 项因无 Chrome 跳过）` : ''}`)


