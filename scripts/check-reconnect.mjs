/**
 * 断线与重连（P2，v1.8.4）的行为自检。
 *
 * 为什么必须真 Chrome + CDP：这一版要证明的是**网络层的时序**，不是字符串：
 *   · 真离线时页脚要出现「连接已断开」，而上一帧内容不能被清空；
 *   · 恢复网络并派发 online 后 5 秒内必须重新取到快照；
 *   · 失败后的重试间隔必须按 1s→2s→5s… 递增，而不是固定周期；
 *   · 同一时刻只能有一个 /taskwatch/data 在飞；
 *   · 页面隐藏期间不许有任何自动重连。
 * 这些只有让 Chromium 自己断网、自己记网络日志才测得出来。
 *
 * 五条断言（对应任务书）：
 *   1. CDP offline → 页脚「连接已断开」，旧内容仍在 DOM；
 *   2. 恢复网络 + online → 5 秒内提示消失、lastOkAt 前移；
 *   3. reload 后重连计数归零，退避序列严格递增；
 *   4. 并发触发多次刷新，网络日志里 /taskwatch/data 的最大并发 = 1；
 *   5. document.hidden 期间重连计数与请求数都不再增长；visible 后立刻补一次。
 *
 * 本机没有 Chrome 就 SKIP（不算失败）；不碰真实中继，临时 profile 用完即删。
 * 服务端只回一份虚构快照；不读任何本机文件。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
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
  console.log('SKIP 断线重连自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
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
    this.listeners = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
        return
      }
      if (!msg.method) return
      const list = this.listeners.get(msg.method) || []
      for (const fn of list.slice()) {
        try { fn(msg.params) } catch { /* 监听器异常不影响 CDP */ }
      }
    }
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
    return () => {
      const list = this.listeners.get(method) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    }
  }
  once(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
        clearTimeout(timer); off(); resolve(params)
      })
      const timer = setTimeout(() => { off(); reject(new Error('等不到 ' + method)) }, timeout)
    })
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
    if (existsSync(file)) {
      // Windows runner 上 Chrome 刚写完这个文件时还可能锁着（EBUSY）；
      // 存在 != 可读，重试到超时，别把环境竞态当成失败。
      let raw = ''
      try {
        raw = readFileSync(file, 'utf8')
      } catch (e) {
        if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'ENOENT') {
          await sleep(100)
          continue
        }
        throw e
      }
      const first = raw.split(/\r?\n/)[0]
      if (first) return Number(first)
    }
    await sleep(100)
  }
  throw new Error('等不到 DevToolsActivePort')
}

const BASE = Date.now()
const FIXTURE = {
  generatedAt: BASE,
  offline: false,
  errors: [],
  totals: { sessions: 1, running: 1, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
  today: { since: BASE - 3600_000, turns: 3, steps: 12, sessions: 1, partial: false },
  pending: [],
  sessions: [{
    id: 'session-offline-check',
    title: '断线时这条标题必须还在',
    running: true,
    activeJobs: 0,
    live: true,
    origin: 'root',
    depth: 0,
    cwd: '~/projects/reconnect-check',
    updatedAt: BASE - 1000,
    lastActivity: BASE - 1000,
    lastTool: 'pwsh',
    lastToolAt: BASE - 2000,
    turnStartedAt: BASE - 10000,
    stepsInTurn: 2,
    goal: null,
  }],
  jobs: [],
  subagents: [],
  workflows: [],
}

let mode = 'ok'
function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

let server = null
let child = null
let profile = ''
try {
  const html = readFileSync(PAGE, 'utf8')
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (path === '/taskwatch/data') {
      if (mode === 'fail') { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('bad gateway'); return }
      if (mode === 'slow') { setTimeout(() => sendJson(res, { ...FIXTURE, generatedAt: Date.now() }), 900); return }
      sendJson(res, { ...FIXTURE, generatedAt: Date.now() })
      return
    }
    if (path === '/taskwatch/chat/sessions') {
      // 页面要有会话页（footer 才存在，断线横幅才落在页脚里），
      // 所以这里给一条根会话；对话正文由下面的 SSE 快照喂。
      sendJson(res, { sessions: [FIXTURE.sessions[0]] })
      return
    }
    if (path === '/taskwatch/chat/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const now = Date.now()
      res.write('data: ' + JSON.stringify({
        type: 'snapshot',
        cursor: 2,
        records: [
          { type: 'event', event: { type: 'user/message', seq: 1, time: now - 60000, data: {
            role: 'user', content: [{ type: 'text', text: '断线前的旧消息：把缓存目录清理掉。' }],
          } } },
          { type: 'event', event: { type: 'assistant/message', seq: 2, time: now - 55000, data: {
            message: { content: [{ type: 'text', text: '断线前的最后一条回复：缓存清理还没执行，等你确认。' }] },
          } } },
        ],
      }) + '\n\n')
      return
    }
    if (path === '/taskwatch/chat/usage') { sendJson(res, {}); return }
    if (path === '/taskwatch/pair') { res.writeHead(200); res.end(); return }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = 'http://127.0.0.1:' + server.address().port + '/taskwatch'

  profile = mkdtempSync(join(tmpdir(), 'tw-reconnect-chrome-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const port = await waitPort(profile, child)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  browser.port = port

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const info = list.find((t) => t.id === targetId)
  if (!info) throw new Error('找不到 target')
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await cdp.send('Page.bringToFront')

  // 网络日志：只统计 /taskwatch/data 的在飞数量（CDP 的 requestWillBeSent →
  // loadingFinished/loadingFailed 是浏览器真实发出的生命周期，不靠页面自报）。
  const stat = { total: 0, inflight: 0, max: 0 }
  const open = new Set()
  cdp.on('Network.requestWillBeSent', (p) => {
    const u = String(p.request && p.request.url || '')
    if (u.indexOf('/taskwatch/data') < 0) return
    stat.total++
    stat.inflight++
    if (stat.inflight > stat.max) stat.max = stat.inflight
    open.add(p.requestId)
  })
  const done = (p) => {
    if (!open.delete(p.requestId)) return
    stat.inflight = Math.max(0, stat.inflight - 1)
  }
  cdp.on('Network.loadingFinished', done)
  cdp.on('Network.loadingFailed', done)
  const resetStat = () => { stat.total = 0; stat.inflight = 0; stat.max = 0; open.clear() }

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
  const load = async (targetUrl) => {
    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url: targetUrl })
    await loaded
  }
  const reload = async () => {
    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.reload', { ignoreCache: true })
    await loaded
  }
  const setOnline = () => cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  })
  const setOffline = () => cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  })

  console.log('\n[1] 离线：页脚提示 + 旧内容保留')
  await load(url + '?case=1')
  await waitFor(`!!window.__twNet && __twNet.lastOkAt > 0`, 8000, '首次快照成功')
  await waitFor(`document.body.innerText.indexOf('断线时这条标题必须还在') >= 0`, 5000, '首页渲染出在跑会话')
  // 断线提示在页脚，而首页（v1.8.2 起）有意不显示输入区；所以进会话页做这组断言。
  await evalJs(`location.hash = '#session/session-offline-check'; true`)
  await waitFor(`(function(){
    var log=document.getElementById('log');
    return !!log && !document.querySelector('main').hidden &&
      log.innerText.indexOf('断线前的最后一条回复') >= 0;
  })()`, 5000, '会话页渲染出旧正文')
  const beforeLastOk = await evalJs('__twNet.lastOkAt')
  await setOffline()
  // CDP 的离线不保证在所有版本都派发 offline 事件；显式派发一次，
  // 断言的是页面自己的 online/offline 分支，而不是浏览器实现细节。
  await evalJs(`window.dispatchEvent(new Event('offline')); true`)
  await waitFor(`(function(){
    var b=document.getElementById('netBanner');
    return !!b && !b.hidden && b.innerText.indexOf('连接已断开') >= 0;
  })()`, 4000, '页脚出现断线提示')
  const offlineState = await evalJs(`(function(){
    var banner=document.getElementById('netBanner');
    var input=document.getElementById('input');
    var br=banner.getBoundingClientRect(), ir=input.getBoundingClientRect();
    return {
      text: banner.innerText,
      old: document.body.innerText.indexOf('断线前的最后一条回复') >= 0,
      pill: (document.getElementById('netq').innerText || '').trim(),
      aboveInput: br.bottom <= ir.top + 1,
      lastOk: __twNet.lastOkAt
    };
  })()`)
  check('离线后页脚出现「连接已断开」', /连接已断开/.test(offlineState.text), JSON.stringify(offlineState.text))
  check('离线时旧内容仍在 DOM（标题没有被清空）', offlineState.old === true)
  check('离线时三点胶囊带文字「离线」', offlineState.pill.indexOf('离线') >= 0, '实际=' + JSON.stringify(offlineState.pill))
  check('提示条在输入框上方（不遮挡输入）', offlineState.aboveInput === true)
  check('离线不清 lastOkAt', offlineState.lastOk === beforeLastOk, beforeLastOk + ' -> ' + offlineState.lastOk)

  console.log('\n[2] 恢复网络 + online：5 秒内自动续上')
  await setOnline()
  const tRestore = Date.now()
  await evalJs(`window.dispatchEvent(new Event('online')); true`)
  await waitFor(`(function(){
    var b=document.getElementById('netBanner');
    return !!b && b.hidden && __twNet.lastOkAt > ${beforeLastOk};
  })()`, 5000, '恢复后提示消失且 lastOkAt 前移')
  const restoreMs = Date.now() - tRestore
  check('恢复后 5 秒内提示消失、lastOkAt 更新', restoreMs < 5000, restoreMs + 'ms')
  check('恢复后三点胶囊回到稳定（无「离线/重连中」文字）',
    (await evalJs(`(document.getElementById('netqText')||{}).textContent || ''`)) === '')

  console.log('\n[3] reload：重连计数归零、退避严格递增')
  await reload()
  await waitFor(`!!window.__twNet && __twNet.lastOkAt > 0`, 8000, 'reload 后首次快照成功')
  const fresh = await evalJs(`({ reconnects: __twNet.reconnects, history: __twNet.history.slice() })`)
  check('reload 后重连计数从 0 开始', fresh.reconnects === 0 && fresh.history.length === 0,
    JSON.stringify(fresh))
  mode = 'fail'
  await evalJs(`window.dispatchEvent(new Event('online')); true`)
  await waitFor(`__twNet.history.length >= 3`, 8000, '至少三次退避')
  const backoff = await evalJs(`({ history: __twNet.history.slice(), reconnects: __twNet.reconnects })`)
  const increasing = backoff.history.every((v, i) => i === 0 || v > backoff.history[i - 1])
  check('退避序列单调递增（1s → 2s → 5s 档）', increasing, JSON.stringify(backoff.history))
  check('退避首档在 1s ±20% 内', backoff.history[0] >= 800 && backoff.history[0] <= 1200,
    String(backoff.history[0]))
  check('重连计数随退避次数增长', backoff.reconnects === backoff.history.length,
    JSON.stringify(backoff))
  mode = 'ok'
  await evalJs(`window.dispatchEvent(new Event('online')); true`)
  await waitFor(`__twNet.attempts === 0 && !document.getElementById('netBanner').hidden === false`, 5000, '恢复稳定')

  console.log('\n[4] 同一时刻只有一个 /taskwatch/data 在飞')
  mode = 'slow'
  resetStat()
  await evalJs(`(function(){
    for (var i=0;i<6;i++) window.dispatchEvent(new Event('online'));
    return true;
  })()`)
  await sleep(1800)
  check('CDP 网络日志里最大并发 = 1', stat.max === 1, 'max=' + stat.max)
  // 允许 1 个 5 秒周期 tick 恰好落进这 1.8 秒窗口；关键是 6 次触发没有变成 6 个请求。
  check('6 次触发被合并（最多 2 个请求）', stat.total <= 2, 'total=' + stat.total)
  mode = 'ok'
  await waitFor(`__twNet.inflight === false`, 5000, '慢请求结束')
  await evalJs(`window.dispatchEvent(new Event('online')); true`)
  await waitFor(`__twNet.attempts === 0 && __twNet.inflight === false`, 5000, '并发测试后恢复')
  await sleep(300)

  console.log('\n[5] document.hidden 期间不重连；visible 立刻补一次')
  mode = 'fail'
  await evalJs(`window.dispatchEvent(new Event('online')); true`)
  await waitFor(`__twNet.attempts >= 1`, 3000, '先进入退避')
  // 页面内 stub（任务书允许的第二种方式）：只改 getter 与派发事件，
  // 不碰 CDP 的页面生命周期，避免 headless 下 visibilityState 的差异。
  await evalJs(`(function(){
    Object.defineProperty(document,'hidden',{configurable:true,get:function(){return true}});
    Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'hidden'}});
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  })()`)
  const hiddenSnap = await evalJs(`({ attempts: __twNet.attempts, hist: __twNet.history.length })`)
  resetStat()
  await sleep(3200)
  const hiddenAfter = await evalJs(`({ attempts: __twNet.attempts, hist: __twNet.history.length, hidden: document.hidden })`)
  check('hidden 期间重连计数不增长', hiddenAfter.attempts === hiddenSnap.attempts && hiddenAfter.hist === hiddenSnap.hist,
    JSON.stringify(hiddenSnap) + ' -> ' + JSON.stringify(hiddenAfter))
  check('hidden 期间没有新的 /taskwatch/data 请求', stat.total === 0, 'total=' + stat.total)
  mode = 'ok'
  await evalJs(`(function(){
    Object.defineProperty(document,'hidden',{configurable:true,get:function(){return false}});
    Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'visible'}});
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  })()`)
  await waitFor(`__twNet.lastOkAt > 0 && __twNet.attempts === 0`, 3000, 'visible 后立即续上')
  check('visible 后立即补了一次快照', stat.total >= 1, 'total=' + stat.total)

  try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
  cdp.close()
  browser.close()

  console.log(`\n断线与重连：${passed} 通过 / ${failed} 失败`)
  if (failed) process.exitCode = 1
} finally {
  if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
}
