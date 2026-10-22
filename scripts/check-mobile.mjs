/**
 * 手机端排版 / 会话隔离的回归自检（v1.7.6）。
 *
 * 为什么单独一条：page.html 里的 twSelfCheck() 只在真实视口下才有意义
 * （390 / 360 宽、DPR2、mobile），静态正则查不出「表格把页面撑宽」这类问题。
 * 这里用 Chrome headless + CDP 打开 docs/demo.html，在两种宽度下：
 *
 *   1. 断言 twSelfCheck().ok，且 document/body/log 的 scrollWidth <= innerWidth；
 *   2. 切到子代理会话再切回：只显示对应会话，data-session 跟着变；
 *   3. 旧会话的 acceptEvent 必须被丢弃，DOM 里不能出现泄漏标记；
 *   4. 注入流式文本后，流式行与工具卡的左缘在同一条基线上。
 *
 * 本机没有 Chrome 就 SKIP（不算失败），不联网、不碰真实中继，临时 profile 用完即删。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  console.log('SKIP 手机端排版自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
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
  close() { try { this.ws.close() } catch (e) {} }
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
      const first = readFileSync(file, 'utf8').split(/\r?\n/)[0]
      if (first) return Number(first)
    }
    await sleep(100)
  }
  throw new Error('等不到 DevToolsActivePort')
}

async function openPage(browser, url, width) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const list = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()
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
  return { cdp, eval: evalJs, close: async () => { try { await browser.send('Target.closeTarget', { targetId }) } catch (e) {} cdp.close() } }
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

  profile = mkdtempSync(join(tmpdir(), 'tw-mobile-chrome-'))
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
    console.log(`\n[${width}] 手机端排版自检`)
    const p = await openPage(browser, url, width)
    try {
      const sc = await p.eval('twSelfCheck()')
      check(`twSelfCheck 全部通过（${width}）`, sc && sc.ok, JSON.stringify(sc && sc.checks.filter((c) => !c.ok)))
      const widths = await p.eval(`(function(){
        var log=document.getElementById('log');
        return {iw:innerWidth,doc:document.documentElement.scrollWidth,body:document.body.scrollWidth,log:log.scrollWidth}
      })()`)
      check(`document/body/log scrollWidth <= innerWidth（${width}）`,
        widths.doc <= widths.iw + 1 && widths.body <= widths.iw + 1 && widths.log <= widths.iw + 1,
        JSON.stringify(widths))

      const switched = await p.eval(`(function(){
        selectSession('session-demo-d',{agent:true});
        var log=document.getElementById('log');
        var agent={sid:S.sessionId,data:log.getAttribute('data-session'),own:log.textContent.indexOf('把发布说明里的接口示例换成新的字段名')>=0,leak:log.textContent.indexOf('把回调的重试从固定间隔改成指数退避')>=0};
        selectSession('session-demo-a',{root:true});
        var root={sid:S.sessionId,data:log.getAttribute('data-session'),own:log.textContent.indexOf('把回调的重试从固定间隔改成指数退避')>=0,leak:log.textContent.indexOf('把发布说明里的接口示例换成新的字段名')>=0};
        return {agent:agent,root:root}
      })()`)
      check(`切子代理只显示对应对话（${width}）`,
        switched.agent.sid === 'session-demo-d' && switched.agent.data === 'session-demo-d' &&
        switched.agent.own && !switched.agent.leak, JSON.stringify(switched.agent))
      check(`切回主对话不残留子代理正文（${width}）`,
        switched.root.sid === 'session-demo-a' && switched.root.data === 'session-demo-a' &&
        switched.root.own && !switched.root.leak, JSON.stringify(switched.root))

      const stale = await p.eval(`(function(){
        selectSession('session-demo-b',{root:true});
        var ev={type:'user/message',data:{message:{content:[{type:'text',text:'TW-LEAK-MARKER'}]}}};
        acceptEvent(ev,'session-demo-d');
        return {sid:S.sessionId,items:S.items.length,leak:document.getElementById('log').textContent.indexOf('TW-LEAK-MARKER')>=0}
      })()`)
      check(`旧会话事件被丢弃（${width}）`, !stale.leak && stale.items === 0, JSON.stringify(stale))

      const align = await p.eval(`(function(){
        selectSession('session-demo-a',{root:true});
        S.running=true; syncSend();
        streamText('正在把回调重试改成指数退避：先读 retryPolicy，再改两处调用点，最后跑一遍单测。');
        var st=document.querySelector('.row.stream'), b=st&&st.querySelector('.bubwrap');
        var t=document.querySelector('.row.ai > .tool,.row.ai > .toolgroup');
        var br=b&&b.getBoundingClientRect(), tr=t&&t.getBoundingClientRect();
        return {stream:br&&Math.round(br.left),tool:tr&&Math.round(tr.left),align:st?getComputedStyle(st.querySelector('.bub')).textAlign:null}
      })()`)
      check(`流式回复与工具卡同一左基线（${width}）`,
        align.stream != null && align.stream === align.tool && align.align === 'left', JSON.stringify(align))
    } finally {
      await p.close()
    }
  }
} catch (e) {
  failed++
  console.log('  FAIL  自检异常：' + e.message)
} finally {
  // Windows 用 taskkill 收进程树；Linux/macOS 的 CI 上没有 taskkill，
  // 直接 SIGKILL 即可（这里漏过平台判断会让 release workflow 在最后一步挂掉）。
  try {
    if (child) {
      if (process.platform === 'win32') {
        const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        k.on('error', () => {})
      } else {
        child.kill('SIGKILL')
      }
    }
  } catch (e) {}
  await sleep(300)
  try { if (profile) rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  try { if (server) { server.closeAllConnections(); server.close() } } catch (e) {}
}

console.log(`\n手机端排版：${passed}/${passed + failed} 通过`)
if (failed) { console.log('失败项：' + failed); process.exit(1) }
