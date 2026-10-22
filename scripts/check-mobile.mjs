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

      // ── v1.7.7 坏图兜底：消息里放两张**必然加载失败**的图（一条同源路由 404、
      //    一条外域不可达），断言页面上不留破图 <img>，只留 ≤44px 的提示条，
      //    而且提示条不把页面撑宽。这是真 Chrome 里的实际解码结果，不是静态正则。
      const broken = await p.eval(`(async function(){
        selectSession('session-demo-a',{root:true});
        S.items.push({kind:'assistant',time:Date.now(),durationMs:900,
          text:'先看两张图：\\n\\n![坏图 A](/taskwatch/file?path=C%3A%5Cgone%5Cx.png&name=x.png)\\n\\n中间这句话必须完整显示，不能被占位框截断。\\n\\n![坏图 B](https://example.invalid/nope.png)'});
        renderAll();
        await new Promise(function(r){ setTimeout(r, 1500) });
        var log=document.getElementById('log');
        var bars=[].map.call(log.querySelectorAll('.imgerr'),function(b){
          var r=b.getBoundingClientRect();
          return {h:Math.round(r.height),w:Math.round(r.width),tag:b.tagName,text:b.textContent}
        });
        var brokenImgs=[].filter.call(log.querySelectorAll('img'),function(i){ return i.complete && !i.naturalWidth });
        var out={
          bars:bars,
          brokenImgs:brokenImgs.length,
          imgCount:log.querySelectorAll('.md-imgwrap,img.md-img').length,
          text:log.textContent.indexOf('不能被占位框截断')>=0,
          docSW:document.documentElement.scrollWidth,
          logSW:log.scrollWidth,
          iw:innerWidth
        };
        S.items.pop(); renderAll();
        return out
      })()`)
      check(`坏图消息不出现任何破图 img（${width}）`,
        broken && broken.brokenImgs === 0, JSON.stringify(broken && {brokenImgs: broken.brokenImgs}))
      check(`坏图换成兜底提示条（${width}）`,
        broken && broken.bars.length === 2 && broken.bars.every((b) => /图片未能加载/.test(b.text)),
        JSON.stringify(broken && broken.bars))
      check(`兜底提示条高度 ≤44px（${width}）`,
        broken && broken.bars.length === 2 && broken.bars.every((b) => b.h > 0 && b.h <= 44),
        JSON.stringify(broken && broken.bars.map((b) => b.h)))
      check(`坏图兜底不撑宽页面、正文完整（${width}）`,
        broken && broken.docSW <= broken.iw + 1 && broken.logSW <= broken.iw + 1 && broken.text,
        JSON.stringify(broken && {docSW: broken.docSW, logSW: broken.logSW, iw: broken.iw, text: broken.text}))

      // ── v1.7.7 图标：会话抽屉里「子代理 N」入口的图标必须是 <svg> 节点，
      //    不能是依赖字体的字符（真机上曾出现「廿」这种回退字形）。
      await p.eval(`(async function(){ openSessions(); await new Promise(function(r){ setTimeout(r, 400) }); return true })()`)
      const icon = await p.eval(`(function(){
        var btn=document.querySelector('#sheet [data-act="subagents"]');
        if(!btn){ closeSheet(); return {found:false} }
        var first=btn.firstElementChild;
        var out={
          found:true,
          firstTag:first?first.tagName.toLowerCase():'',
          svgCount:btn.querySelectorAll('svg').length,
          hasPico:!!btn.querySelector('svg.pico'),
          label:btn.querySelector('.label')?btn.querySelector('.label').textContent:'',
          // ＋ › ‹ ▸ ✓ ✕ 之类"当图标用的字符"一个都不该剩在入口里
          textGlyph:/[\\uFF0B\\u2039\\u203A\\u25B8\\u25BE\\u2713\\u2715]/.test(btn.textContent)
        };
        closeSheet();
        return out
      })()`)
      check(`「子代理」入口的图标是 svg 而不是字符字形（${width}）`,
        icon && icon.found && icon.firstTag === 'svg' && icon.hasPico && icon.svgCount >= 1 && !icon.textGlyph,
        JSON.stringify(icon))
      check(`「子代理」入口文案仍可读（${width}）`,
        icon && icon.found && /子代理\s*\d+/.test(icon.label), JSON.stringify(icon && icon.label))

      // ── v1.7.8 闪屏：.md-imgwrap 必须是定位祖先，否则 .loading::after 的
      //    `inset:0` 流光以视口为包含块 —— 长会话里任何一张还没进入视口的懒加载图
      //    都会让整屏出现无限循环的亮带，并把自己的 translateX 算进文档宽度。
      const shimmer = await p.eval(`(function(){
        selectSession('session-demo-a',{root:true});
        var w=document.querySelector('#log .md-imgwrap');
        if(!w) return {found:false};
        var before=document.documentElement.scrollWidth;
        w.classList.add('loading'); void w.offsetWidth;
        var after=document.documentElement.scrollWidth;
        var pe=getComputedStyle(w,'::after').pointerEvents;
        var hit=document.elementFromPoint(4,4);
        var out={found:true,pos:getComputedStyle(w).position,before:before,after:after,iw:innerWidth,
          pointerEvents:pe,leak:!!(hit&&w.contains(hit)),
          rect:{w:Math.round(w.getBoundingClientRect().width),h:Math.round(w.getBoundingClientRect().height)}};
        w.classList.remove('loading');
        return out
      })()`)
      check(`图片流光不逃出图片盒（${width}）`,
        shimmer && shimmer.found && shimmer.pos === 'relative' && shimmer.after <= shimmer.iw + 1 &&
        shimmer.after === shimmer.before, JSON.stringify(shimmer))
      check(`图片流光不吃点击（${width}）`,
        shimmer && shimmer.found && shimmer.pointerEvents === 'none' && !shimmer.leak, JSON.stringify(shimmer))

      // ── v1.7.8 附件信封：DSH 给模型看的 <path>/<type>/<content> 协议不该原样显示。
      const envelope = await p.eval(`(async function(){
        selectSession('session-demo-a',{root:true});
        S.items.push({kind:'user',time:Date.now(),
          text:'<path>C:\\\\tmp\\\\proof.png</path>\\n<type>image</type>\\n<content>\\nimage/png image, 1398x1542 px, 437517 bytes\\n</content>'});
        renderAll();
        await new Promise(function(r){ setTimeout(r, 1200) });
        var log=document.getElementById('log');
        var last=log.querySelectorAll('.row'); last=last[last.length-1];
        var out={tags:/<\\/?path>|<type>|<content>/.test(last.textContent),
          att:last.querySelectorAll('.message-attachments img,.message-attachments .imgerr').length,
          bars:last.querySelectorAll('.imgerr').length,
          h:last.querySelector('.imgerr')?Math.round(last.querySelector('.imgerr').getBoundingClientRect().height):0};
        S.items.pop(); renderAll();
        return out
      })()`)
      check(`附件信封不再显示成 XML 标签（${width}）`, envelope && !envelope.tags, JSON.stringify(envelope))
      check(`附件信封渲染成图片位（失败也有兜底）（${width}）`,
        envelope && envelope.att === 1, JSON.stringify(envelope))
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
