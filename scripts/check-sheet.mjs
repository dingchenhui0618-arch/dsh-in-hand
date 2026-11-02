#!/usr/bin/env node
/**
 * 会话抽屉（☰ → 会话）的结构自检（v1.8.18）。
 *
 * 这一版把「工作台 / 操作」提到了抽屉最上面，并把「实验功能：德州扑克」整行删除。
 * 结构是拼接字符串拼出来的，静态正则只能证明"源码里这两个词谁先出现"，证明不了
 * 真实 DOM 的顺序 —— 所以这里用真 Chrome + CDP 打开 docs/demo.html，把抽屉真的
 * 点开，再按 **DOM 节点顺序**（不是截图、不是 line number）断言：
 *
 *   1. 「工作台」「操作」两个分组标题都排在 #sessionList 之前；
 *   2. 抽屉里不存在 [data-act="poker"]；
 *   3. 搜索框仍在 #sessionList 之前，字号三档在搜索框之后、列表之前，
 *      「只看对话」也仍在列表之前（三者还保持"作用于列表"的相对位置）；
 *   4. 点 [data-act="notify"] 仍进得了通知页（行为没被这次重排带坏）。
 *
 * 顺手量几个排版事实：>390/360 无横向溢出、抽屉里的 pill 高度 ≥44px、
 * 两个分组标题之间确实还夹着 3 个 pill（没有挤成两段标题贴在一起）。
 *
 * 本机没有 Chrome 就 SKIP（不算失败），不联网、临时 profile 用完即删。
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
  console.log('SKIP 会话抽屉结构自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
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

  profile = mkdtempSync(join(tmpdir(), 'tw-sheet-chrome-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const port = await waitPort(profile, child)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  browser.port = port

  for (const width of [390, 360]) {
    console.log(`\n[${width}] 会话抽屉结构`)
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const info = list.find((t) => t.id === targetId)
    if (!info) throw new Error('找不到 target')
    const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Page.navigate', { url })
    await sleep(1600)
    const evalJs = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result && r.result.value
    }

    try {
      const opened = await evalJs(`(async function(){
        await openSessions();
        await new Promise(function(r){ setTimeout(r, 500) });
        var sheet=document.getElementById('sheet')
        return {open: !!(sheet && !sheet.hidden), hasList: !!document.querySelector('#sheet #sessionList')}
      })()`)
      check(`抽屉能打开且会话列表已渲染（${width}）`, opened && opened.open && opened.hasList, JSON.stringify(opened))

      const dom = JSON.parse(decodeURIComponent(await evalJs(`(function(){
        var card=document.querySelector('#sheet .card')
        if(!card) return encodeURIComponent(JSON.stringify({found:false}))
        var all=[].slice.call(card.querySelectorAll('*'))
        function idx(el){ return el ? all.indexOf(el) : -1 }
        var h3s=[].slice.call(card.querySelectorAll('h3'))
        var wb=null,ops=null
        for(var i=0;i<h3s.length;i++){
          var t=h3s[i].textContent.trim()
          if(t==='工作台') wb=h3s[i]
          if(t==='操作') ops=h3s[i]
        }
        var listEl=card.querySelector('#sessionList')
        var search=card.querySelector('#sessionSearch')
        var searchWrap=card.querySelector('.sheet-search')
        var font=card.querySelector('.segbtn[data-font]')
        var seg=card.querySelector('.seg')
        var chatonly=card.querySelector('[data-act="chatonly"]')
        var head=card.querySelector('.sheet-head')
        var pills=[].slice.call(card.querySelectorAll('.pill'))
        var between=0
        for(var p=0;p<pills.length;p++){
          var pi=idx(pills[p])
          if(idx(wb)>-1 && idx(ops)>-1 && pi>idx(wb) && pi<idx(ops)) between++
        }
        var small=[]
        for(var q=0;q<pills.length;q++){
          var r=pills[q].getBoundingClientRect()
          if(r.height>0 && r.height<43.5) small.push(Math.round(r.height)+'px:'+pills[q].getAttribute('data-act'))
        }
        // 「工作台」标题与顶部标题栏之间的实际留白（含 h3 的 margin-top）
        var gap = (head && wb) ? Math.round(wb.getBoundingClientRect().top - head.getBoundingClientRect().bottom) : -1
        return encodeURIComponent(JSON.stringify({
          found:true,
          poker: card.querySelectorAll('[data-act="poker"]').length,
          order:{ workbench:idx(wb), actions:idx(ops), search:idx(searchWrap), list:idx(listEl),
                  font:idx(font), seg:idx(seg), chatonly:idx(chatonly), head:idx(head) },
          searchInput: !!search,
          between: between,
          gap: gap,
          pills: pills.length,
          small: small,
          docW: document.documentElement.scrollWidth,
          cardW: Math.round(card.getBoundingClientRect().width),
          cardScroll: card.scrollHeight,
          cardClient: card.clientHeight,
          iw: innerWidth
        }))
      })()`)))

      const o = dom.order || {}
      check(`「工作台」标题在 #sessionList 之前（${width}）`,
        !!dom.found && o.workbench > -1 && o.list > -1 && o.workbench < o.list,
        'workbench=' + o.workbench + ' list=' + o.list)
      check(`「操作」标题在 #sessionList 之前（${width}）`,
        !!dom.found && o.actions > -1 && o.list > -1 && o.actions < o.list,
        'actions=' + o.actions + ' list=' + o.list)
      check(`抽屉里不存在 [data-act="poker"]（${width}）`, dom.found && dom.poker === 0, 'poker=' + dom.poker)
      check(`搜索框仍在 #sessionList 之前（${width}）`,
        dom.found && dom.searchInput && o.search > -1 && o.search < o.list,
        'search=' + o.search + ' list=' + o.list)
      check(`字号三档在搜索框之后、列表之前（${width}）`,
        dom.found && o.seg > o.search && o.font > o.search && o.font < o.list,
        JSON.stringify({ search: o.search, seg: o.seg, font: o.font, list: o.list }))
      check(`「只看对话」仍在列表之前（${width}）`,
        dom.found && o.chatonly > o.font && o.chatonly < o.list,
        'chatonly=' + o.chatonly + ' list=' + o.list)
      check(`两个分组标题之间仍夹着 3 个工作台入口（${width}）`, dom.found && dom.between === 3,
        'between=' + dom.between)
      check(`「工作台」与顶部标题栏不挤（留白 ≥8px）（${width}）`, dom.gap >= 8, 'gap=' + dom.gap)
      check(`抽屉内 pill 高度均 ≥44px（${width}）`, dom.small.length === 0, JSON.stringify(dom.small))
      check(`抽屉不横向溢出（${width}）`,
        dom.docW <= dom.iw + 1 && dom.cardW <= dom.iw + 1,
        JSON.stringify({ docW: dom.docW, cardW: dom.cardW, iw: dom.iw }))
      console.log(`  抽屉内容 ${dom.cardScroll}px / 可视 ${dom.cardClient}px，pill ${dom.pills} 个，gap ${dom.gap}px`)

      // 4. 点「通知」仍进通知页：用 CDP 真实鼠标事件，顺手证明这一行没被挤出可点区域。
      const notifyHit = await evalJs(`(function(){
        var btn=document.querySelector('#sheet [data-act="notify"]')
        if(!btn) return {found:false}
        btn.scrollIntoView({block:'center'})
        var r=btn.getBoundingClientRect()
        return {found:true, x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2),
                h:Math.round(r.height), text:btn.textContent.trim()}
      })()`)
      check(`「通知」入口存在且高度 ≥44px（${width}）`, notifyHit.found && notifyHit.h >= 44, JSON.stringify(notifyHit))
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: notifyHit.x, y: notifyHit.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: notifyHit.x, y: notifyHit.y, button: 'left', clickCount: 1 })
      await sleep(500)
      const nav = await evalJs(`(function(){
        var v=document.getElementById('notifyView')
        var sheet=document.getElementById('sheet')
        return {hash:String(location.hash||''), view: !!(v && !v.hidden),
                text: v ? v.innerText.slice(0,80) : '',
                sheetClosed: !!(sheet && sheet.hidden)}
      })()`)
      check(`点「通知」进入通知页（${width}）`,
        nav.hash === '#notify' && nav.view && nav.sheetClosed && /通知/.test(nav.text),
        JSON.stringify(nav))
    } finally {
      try { await browser.send('Target.closeTarget', { targetId }) } catch (e) { /* 已关 */ }
      cdp.close()
    }
  }

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

console.log(`\n会话抽屉结构：${passed}/${passed + failed} 通过`)
if (failed) { console.log('失败项：' + failed); process.exit(1) }
