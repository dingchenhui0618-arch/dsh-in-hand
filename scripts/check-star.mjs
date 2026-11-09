#!/usr/bin/env node
/**
 * 「给掌上 DSH 点个星」入口、授权面板与一次性提示的结构自检（v1.8.23）。
 *
 * v1.8.23 起点星不再直接跳外链，改成打开 GitHub 设备码授权面板；页面本身
 * 仍然不接触 token、不调用 GitHub API（换 token 全在宿主，见
 * scripts/check-github-star.mjs）。自检分两层：
 *
 *   1. 静态源码：入口是按钮、面板存在、没有 GitHub API 调用、提示文案没有
 *      感叹号也没有「求」、SW 缓存号已升到 v36、版本 1.8.23。
 *   2. 真 Chrome + CDP 打开 docs/demo.html（DPR2 / 390×844），在真实 DOM 里：
 *      · 抽屉「操作」区最后一项是 [data-act="star"]，文案完全等于「给掌上 DSH 点个星」，
 *        与「主题」那一行同高、图标同为 16px；
 *      · 点它打开授权面板（抽屉不关），显示 XXXX-XXXX 的码、状态行，开始轮询；
 *      · 关面板后 timer=0、active=false，不留后台循环；
 *      · 第一次「允许一次」成功后提示条出现，且不压住输入框 / 发送键；
 *      · 第二次成功不再出现；
 *      · starTapped / starPromptDone 任一存在时，成功后都不出现（两个 case）；
 *      · 8 秒后自动淡出。
 *
 * 本机没有 Chrome 就 SKIP（不算失败），不联网，临时 profile 用完即删。
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
const PAGE = join(ROOT, 'lib', 'page.html')
const SW = join(ROOT, 'lib', 'sw.js')
const PKG = join(ROOT, 'package.json')
const PROMPT_TEXT = '如果它替你省过一次等待，点个星就行。'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0, failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}

// ── 1. 静态源码 ────────────────────────────────────────────────────────────
console.log('\n[静态] 页面源码')
const page = readFileSync(PAGE, 'utf8')
const demo = readFileSync(DEMO, 'utf8')
const sw = readFileSync(SW, 'utf8')
const pkg = JSON.parse(readFileSync(PKG, 'utf8'))

check('页面存在 data-act="star"', page.includes('data-act="star"'))
check('入口文案完全等于「给掌上 DSH 点个星」',
  page.includes('<span class="label">给掌上 DSH 点个星</span>'))
check('入口不再直接挂仓库外链（v1.8.23 改成打开授权面板）',
  page.includes('data-act="star"') && !new RegExp('data-act="star"[^>]*href=').test(page))
check('入口是按钮（不再 target=_blank）',
  /<button[^>]*data-act="star"[^>]*>/.test(page) && !/data-act="star"[^>]*target="_blank"/.test(page))
check('页面里有 GitHub 设备码授权面板', page.includes('function openStarPanel'))
check('页面里没有 api.github.com', !page.includes('api.github.com'))
check('页面里没有 /user/starred', !page.includes('/user/starred'))
check('页面里没有任何 GitHub API 域名调用', !/api\.github\.com|github\.com\/api|graphql\.api\.github/i.test(page))
const promptBlock = (page.match(/<div id="starPrompt"[\s\S]*?<\/div>/) || [''])[0]
const promptText = promptBlock.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '')
check('提示条文案完全等于「' + PROMPT_TEXT + '」', promptText.includes(PROMPT_TEXT), promptText)
check('提示文案不含「求」', !promptText.includes('求'))
check('提示文案不含半角感叹号', !promptText.includes('!'))
check('提示文案不含全角感叹号', !promptText.includes('！'))
check('提示有两个文字按钮「去点星」「不用了」',
  promptText.includes('去点星') && promptText.includes('不用了'))
check('「去点星」是打开授权面板的按钮', /id="starGo"[^>]*type="button"/.test(promptBlock) &&
  /openStarPanel\(\)/.test(page))
check('提示只在「已提交 · 允许一次」分支触发',
  /if \(text === '已提交 · 允许一次'\) maybeStarPrompt\(el\)/.test(page))
check('demo.html 已同步新入口（npm run demo）', demo.includes('data-act="star"'))
check('sw.js CACHE 已升到 taskwatch-v39', /const CACHE = 'taskwatch-v39'/.test(sw))
check('package.json 版本是 1.8.26', pkg.version === '1.8.26', pkg.version)

// ── 2. 真 Chrome + CDP ────────────────────────────────────────────────────
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
  console.log('\nSKIP 点星入口自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
  console.log(`\n点星入口：${passed}/${passed + failed} 通过`)
  process.exit(failed ? 1 : 0)
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
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    })
  }
  close() { try { this.ws.close() } catch (e) { /* 已断开 */ } }
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
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    res.writeHead(404); res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = 'http://127.0.0.1:' + server.address().port + '/taskwatch'

  profile = mkdtempSync(join(tmpdir(), 'tw-star-chrome-'))
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
  if (!info) throw new Error('找不到 target')
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await cdp.send('Page.navigate', { url })
  await sleep(1600)

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }
  const reload = async () => {
    await cdp.send('Page.reload', { ignoreCache: true })
    await sleep(1600)
  }
  const stubApprove = () => evalJs(`(function(){
    var orig = window.fetch
    window.fetch = function(u, o){
      if (String(u).indexOf('/taskwatch/approve') >= 0) {
        return Promise.resolve({ ok:true, status:200, json:function(){ return Promise.resolve({ok:true}) } })
      }
      return orig(u, o)
    }
    return true
  })()`)
  // 授权面板：start 回一个固定 flow，poll 一直 pending。只验证面板与停止轮询，
  // 真实换 token / PUT star 的契约在 check-github-star.mjs 里用假 GitHub 钉。
  const stubStar = () => evalJs(`(function(){
    var orig = window.fetch
    window.fetch = function(u, o){
      var s = String(u)
      if (s.indexOf('/taskwatch/star/start') >= 0) {
        return Promise.resolve({ ok:true, status:200, json:function(){ return Promise.resolve({
          ok:true, flowId:'flow-demo', userCode:'ABCD-1234',
          verificationUri:'https://github.com/login/device', expiresIn:900, interval:5
        }) } })
      }
      if (s.indexOf('/taskwatch/star/poll') >= 0) {
        return Promise.resolve({ ok:true, status:200, json:function(){ return Promise.resolve({
          ok:true, status:'pending', interval:5
        }) } })
      }
      return orig(u, o)
    }
    return true
  })()`)
  const promptState = () => evalJs(`(function(){
    var el = document.getElementById('starPrompt')
    if (!el) return { missing:true }
    var r = el.getBoundingClientRect()
    var cs = getComputedStyle(el)
    var inp = document.getElementById('input')
    var send = document.getElementById('send')
    var foot = document.querySelector('footer')
    var fr = foot ? foot.getBoundingClientRect() : null
    var footerVisible = !!(foot && !foot.hidden && fr.height > 0)
    var ir = inp && inp.offsetParent ? inp.getBoundingClientRect() : null
    var sr = send && send.offsetParent ? send.getBoundingClientRect() : null
    function hit(a,b){ return !!(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) }
    var actions = [].slice.call(document.querySelectorAll('[data-reject],[data-approve]')).filter(function(b){
      return b.offsetParent && b.getBoundingClientRect().width > 0
    })
    var hits = actions.filter(function(b){ return hit(r, b.getBoundingClientRect()) }).length
    var parent = el.parentElement
    var prev = el.previousElementSibling
    return {
      hidden: el.hidden, on: el.classList.contains('on'), opacity: Number(cs.opacity),
      position: cs.position,
      parentClass: parent ? String(parent.className || '') : '',
      prevPending: prev ? String(prev.getAttribute('data-pending-id') || '') : '',
      inViewport: r.top >= -1 && r.bottom <= innerHeight + 1,
      text: el.innerText.replace(/\\s+/g,''),
      rect: { x:Math.round(r.left), y:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height), bottom:Math.round(r.bottom) },
      overInput: hit(r, ir), overSend: hit(r, sr), overActions: hits,
      footerVisible: footerVisible,
      composerTop: footerVisible ? Math.round(fr.top) : -1,
      viewBottom: innerHeight
    }
  })()`)

  console.log('\n[浏览器] 抽屉入口')
  const opened = await evalJs(`(async function(){
    localStorage.clear()
    await openSessions()
    await new Promise(function(r){ setTimeout(r, 500) })
    return true
  })()`)
  const row = await evalJs(`(function(){
    var card = document.querySelector('#sheet .card')
    var star = card && card.querySelector('[data-act="star"]')
    if (!star) return { found:false }
    var theme = card.querySelector('[data-act="theme"]')
    var acts = [].slice.call(card.querySelectorAll('.sheet-actions [data-act]'))
    var label = star.querySelector('.label')
    var icon = star.querySelector('svg')
    var ir = icon ? icon.getBoundingClientRect() : null
    var r = star.getBoundingClientRect(), tr = theme ? theme.getBoundingClientRect() : null
    var cs = getComputedStyle(star)
    return {
      found:true,
      tag: star.tagName.toLowerCase(),
      label: label ? label.textContent : '',
      full: star.textContent.replace(/\\s+/g,''),
      href: star.getAttribute('href'),
      target: star.getAttribute('target'),
      rel: star.getAttribute('rel'),
      last: acts.length ? acts[acts.length-1] === star : false,
      height: Math.round(r.height), themeHeight: tr ? Math.round(tr.height) : -1,
      icon: ir ? { w:Math.round(ir.width), h:Math.round(ir.height) } : null,
      marginBottom: cs.marginBottom,
      docW: document.documentElement.scrollWidth, iw: innerWidth
    }
  })()`)
  check('抽屉打开后能找到入口', opened && row.found, JSON.stringify(row))
  check('入口是「操作」区最后一项', row.found && row.last)
  check('入口文案的 label 完全等于「给掌上 DSH 点个星」', row.found && row.label === '给掌上 DSH 点个星', row.label)
  check('入口是按钮、不再直接挂仓库 href / target',
    row.found && row.tag === 'button' && !row.href && !row.target,
    JSON.stringify({ tag:row.tag, href:row.href, target:row.target }))
  check('入口与「主题」行同高', row.found && Math.abs(row.height - row.themeHeight) <= 1,
    `star=${row.height} theme=${row.themeHeight}`)
  check('图标与同区其它 pico 同为 16×16', row.found && row.icon && row.icon.w === 16 && row.icon.h === 16,
    JSON.stringify(row.icon))
  check('抽屉不横向溢出', row.found && row.docW <= row.iw + 1, JSON.stringify({ docW:row.docW, iw:row.iw }))

  await stubStar()
  const clicked = await evalJs(`(async function(){
    var a = document.querySelector('#sheet [data-act="star"]')
    if (!a) return { found:false }
    a.click()
    await new Promise(function(r){ setTimeout(r, 600) })
    var sheet = document.getElementById('sheet')
    var card = document.querySelector('#sheet .card')
    var code = card && card.querySelector('[data-star-code]')
    var state = card && card.querySelector('[data-star-state]')
    var title = card && card.querySelector('.sheet-head h3')
    var cr = code ? code.getBoundingClientRect() : null
    var fs = code ? parseFloat(getComputedStyle(code).fontSize) : 0
    return {
      found:true, open: !!(sheet && !sheet.hidden),
      title: title ? title.textContent : '',
      code: code ? code.textContent : '',
      state: state ? state.textContent : '',
      codeRight: cr ? Math.round(cr.right) : -1, codeFont: fs,
      tapped: localStorage.getItem('taskwatch.starTapped'),
      flowId: STAR.flowId, timer: STAR.timer, active: STAR.active,
      interval: STAR.interval
    }
  })()`)
  check('点入口打开授权面板（抽屉不关，面板在抽屉里）',
    clicked && clicked.found && clicked.open, JSON.stringify(clicked))
  check('面板标题是「用 GitHub 账号点个星」', clicked && clicked.title === '用 GitHub 账号点个星', clicked && clicked.title)
  check('面板显示 XXXX-XXXX 的 8 位码', clicked && clicked.code === 'ABCD-1234', clicked && clicked.code)
  check('8 位码字号 ≥24px 且不横向溢出',
    clicked && clicked.codeFont >= 24 && clicked.codeRight <= 391,
    JSON.stringify({ font:clicked && clicked.codeFont, right:clicked && clicked.codeRight }))
  check('面板状态行是「等待你在 GitHub 上确认…」',
    clicked && clicked.state === '等待你在 GitHub 上确认…', clicked && clicked.state)
  check('还没点上时不写 starTapped', clicked && clicked.tapped === null, clicked && clicked.tapped)
  check('面板已开始轮询（active + timer）',
    clicked && clicked.active === true && clicked.timer > 0,
    JSON.stringify({ active:clicked && clicked.active, timer:clicked && clicked.timer }))
  const slow = await evalJs('starIntervalAfter(5, "slow_down")')
  check('slow_down 把轮询间隔加 5 秒', slow === 10, String(slow))
  const closed = await evalJs(`(function(){
    closeSheet()
    var sheet = document.getElementById('sheet')
    return { hidden: !!(sheet && sheet.hidden), timer: STAR.timer, active: STAR.active,
             gen: STAR.gen, flowId: STAR.flowId }
  })()`)
  check('关面板会停掉轮询（timer=0、active=false、flow 清空）',
    closed && closed.hidden && closed.timer === 0 && closed.active === false && closed.flowId === '',
    JSON.stringify(closed))

  console.log('\n[浏览器] 首次「允许一次」后出现')
  await evalJs(`localStorage.clear()`)
  await reload()
  await stubApprove()
  const first = await evalJs(`(async function(){
    await submitApproval('approval-demo', 'allow')
    await new Promise(function(r){ setTimeout(r, 350) })
    return true
  })()`)
  const ps1 = await promptState()
  check('第一次允许成功后提示出现', first && ps1.on && ps1.hidden === false,
    JSON.stringify({ hidden:ps1.hidden, on:ps1.on, opacity:ps1.opacity }))
  check('提示文案完全等于「' + PROMPT_TEXT + '」并含两个按钮',
    ps1.text === PROMPT_TEXT + '去点星不用了', ps1.text)
  check('提示文案不含「求」', !ps1.text.includes('求'))
  check('提示文案不含感叹号', !ps1.text.includes('!') && !ps1.text.includes('！'))
  check('提示条在内容流内（不是 fixed/absolute 浮层）',
    ps1.position !== 'fixed' && ps1.position !== 'absolute', ps1.position)
  check('提示条挂在首页待办卡片后面，紧跟刚处理的那张',
    /home-todo/.test(ps1.parentClass) && ps1.prevPending === 'approval-demo',
    JSON.stringify({ parentClass:ps1.parentClass, prevPending:ps1.prevPending }))
  check('提示条在视口内', ps1.inViewport === true, JSON.stringify(ps1.rect))
  check('提示条不压住输入框', ps1.overInput === false, JSON.stringify(ps1))
  check('提示条不压住发送键', ps1.overSend === false, JSON.stringify(ps1))
  check('提示条不压住任何可见的批准 / 拒绝按钮', ps1.overActions === 0, JSON.stringify({ overActions:ps1.overActions }))
  check('提示条是一行（高度 ≤64px）', ps1.rect && ps1.rect.h <= 64, JSON.stringify(ps1.rect))

  const survived = await evalJs(`(function(){
    renderHomeTodo(true)
    var e = document.getElementById('starPrompt')
    return { exists:!!e, hidden:!!(e && e.hidden), on:!!(e && e.classList.contains('on')),
             parent: e && e.parentElement ? String(e.parentElement.className) : '' }
  })()`)
  check('首页 5 秒轮询重建后提示仍在（不会被 innerHTML 清掉）',
    survived.exists && survived.hidden === false && survived.on === true && /home-todo/.test(survived.parent),
    JSON.stringify(survived))

  console.log('\n[浏览器] 8 秒后自动淡出')
  await sleep(8300)
  const faded = await promptState()
  check('8 秒后提示自动消失', faded.hidden === true || (faded.on === false && faded.opacity === 0),
    JSON.stringify({ hidden:faded.hidden, on:faded.on, opacity:faded.opacity }))

  console.log('\n[浏览器] 第二次成功不再出现')
  const second = await evalJs(`(async function(){
    await submitApproval('approval-demo-high', 'allow')
    await new Promise(function(r){ setTimeout(r, 350) })
    var el = document.getElementById('starPrompt')
    return { hidden: el.hidden, on: el.classList.contains('on') }
  })()`)
  check('第二次允许成功不再出现', second && second.hidden === true && second.on === false,
    JSON.stringify(second))

  for (const [flag, label] of [['starTapped','starTapped'], ['starPromptDone','starPromptDone']]) {
    console.log(`\n[浏览器] ${label} 已存在时不出现`)
    await evalJs(`localStorage.clear(); localStorage.setItem('taskwatch.${flag}','1')`)
    await reload()
    await stubApprove()
    const st = await evalJs(`(async function(){
      await submitApproval('approval-demo', 'allow')
      await new Promise(function(r){ setTimeout(r, 350) })
      var el = document.getElementById('starPrompt')
      return { hidden: el.hidden, on: el.classList.contains('on'), flag: localStorage.getItem('taskwatch.${flag}') }
    })()`)
    check(`${label} 存在时允许成功也不出现`, st.hidden === true && st.on === false && st.flag === '1',
      JSON.stringify(st))
  }

  cdp.close()
  try { await browser.send('Target.closeTarget', { targetId }) } catch (e) { /* 已关 */ }
  browser.close()
} catch (e) {
  failed++
  console.log('  FAIL  自检异常：' + e.message)
} finally {
  try {
    if (child) {
      if (process.platform === 'win32') {
        const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        k.on('error', () => {})
      } else {
        child.kill('SIGKILL')
      }
    }
  } catch (e) { /* 已退出 */ }
  await sleep(300)
  try { if (profile) rmSync(profile, { recursive: true, force: true }) } catch (e) { /* 锁文件 */ }
  try { if (server) { server.closeAllConnections(); server.close() } } catch (e) { /* 已关 */ }
}

console.log(`\n点星入口：${passed}/${passed + failed} 通过`)
if (failed) { console.log('失败项：' + failed); process.exit(1) }
