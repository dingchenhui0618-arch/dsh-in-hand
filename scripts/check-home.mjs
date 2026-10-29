/**
 * 首页（待办优先）的回归自检 —— v1.8.2 / PLAN.md 的 P1。
 *
 * 为什么必须用真浏览器：这一版改的是**首屏**。要断言的那句话是「390×844 不滚动
 * 就能看到待办卡」，这是几何事实，正则和 DOM 断言都证明不了；而且路由要靠
 * pushState / popstate 才能验「返回手势回首页」。所以和 check-mobile.mjs 一样，
 * 用 Chrome headless + 自建 CDP 打开 docs/demo.html（与 page.html 同源构建）。
 *
 * 六条断言（缺一条就不算做完 P1）：
 *   1. 无 hash = 首页：标题是「在等你 N 件」，且能看到「继续上次会话」；
 *   2. canDecide 的待办卡在首屏内：含「批准一次」，卡片 top < 844；
 *   3. `#session/<id>` 进会话视图，且顶部有明确的「返回首页」；点它 / 按浏览器
 *      返回都回到首页；
 *   4. N=0 时标题换成「暂时没有需要你的」，在跑区与「继续上次会话」仍在；
 *   5. 390 / 360 宽都没有横向溢出；
 *   6. 审批按钮仍然真的 POST /taskwatch/approve（decision=allow），处理完不复活。
 *
 * 本机没有 Chrome 就 SKIP（不算失败）；不联网、不碰真实中继，临时 profile 用完即删。
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
  console.log('SKIP 首页自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
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
  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }
  // 每次「从头来一遍」都换一个 query：同 URL 的 hash 导航不会重新加载页面，
  // 而首页这几条断言要的正是**加载时**的状态。?case= 不会被页面的票据清理动到。
  let caseNo = 0
  const load = async (hash = '') => {
    caseNo++
    await cdp.send('Page.navigate', { url: url + '?case=' + caseNo + hash })
    await sleep(1700)
  }
  return { cdp, eval: evalJs, load, close: async () => { try { await browser.send('Target.closeTarget', { targetId }) } catch (e) {} cdp.close() } }
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

  profile = mkdtempSync(join(tmpdir(), 'tw-home-chrome-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const port = await waitPort(profile, child)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  browser.port = port

  // ── 1 / 2 / 5：首页本身（390 宽）───────────────────────────────────────────
  console.log('\n[390] 首页：待办优先')
  const p = await openPage(browser, url, 390)
  try {
    await p.load()
    const first = await p.eval(`(function(){
      var home=document.getElementById('home'), log=document.getElementById('log');
      var title=document.getElementById('sessTitle').textContent.trim();
      var card=document.querySelector('#homeTodo [data-pending-id]');
      var allow=card?card.querySelector('[data-approve]'):null;
      var resume=document.getElementById('homeResume');
      var runs=document.querySelectorAll('#homeRun .runrow');
      return {
        title:title,
        titleIsCount:/在等你\\s*\\d+\\s*件/.test(title),
        homeShown:home?home.getBoundingClientRect().height>0:false,
        logHidden:log?log.getBoundingClientRect().height===0:false,
        hash:location.hash,
        card:!!card,
        cardTop:card?Math.round(card.getBoundingClientRect().top):null,
        allowText:allow?allow.textContent.trim():'',
        allowH:allow?Math.round(allow.getBoundingClientRect().height):0,
        resumeText:resume?resume.textContent.trim():'',
        resumeShown:resume?resume.getBoundingClientRect().height>0:false,
        runs:runs.length,
        counts:(document.getElementById('homeCounts')||{}).textContent||''
      }
    })()`)
    check('无 hash 落到首页：标题是「在等你 N 件」',
      first.hash === '' && first.homeShown && first.logHidden && first.titleIsCount,
      JSON.stringify({ hash:first.hash, home:first.homeShown, logHidden:first.logHidden, title:first.title }))
    check('无 hash 落到首页：有「继续上次会话」入口',
      first.resumeShown && /继续上次会话/.test(first.resumeText),
      JSON.stringify({ text:first.resumeText, shown:first.resumeShown }))
    check('首屏（390×844 不滚动）就能看到待办卡与「批准一次」',
      first.card && /^批准一次$/.test(first.allowText) && first.cardTop < 844 && first.allowH >= 44,
      JSON.stringify({ cardTop:first.cardTop, text:first.allowText, h:first.allowH }))
    check('首页「在跑」区有会话行、底部计数不是空的',
      first.runs > 0 && first.counts.length > 0,
      JSON.stringify({ runs:first.runs, counts:first.counts }))

    const widths390 = await p.eval(`(function(){
      var home=document.getElementById('home');
      return {iw:innerWidth,doc:document.documentElement.scrollWidth,
        body:document.body.scrollWidth,home:home.scrollWidth}
    })()`)
    check('390 宽：document/body/#home 都没有横向溢出',
      widths390.doc <= widths390.iw + 1 && widths390.body <= widths390.iw + 1 &&
      widths390.home <= widths390.iw + 1, JSON.stringify(widths390))

    // ── 4：N=0 ───────────────────────────────────────────────────────────────
    await p.load()
    const idle = await p.eval(`(function(){
      lastData = {generatedAt:Date.now(), offline:false, errors:[],
        totals:{sessions:6,running:2,jobs:5,jobsRunning:3,subagents:2,workflows:1,pending:0},
        today:{since:Date.now()-21600000,turns:37,steps:1291,sessions:3,partial:false},
        pending:[],
        sessions:DEMO.sessions.map(function(s){return Object.assign({},s)}),
        jobs:DEMO.jobs, subagents:DEMO.subagents, workflows:DEMO.workflows};
      renderHome();
      var title=document.getElementById('sessTitle').textContent.trim();
      var resume=document.getElementById('homeResume');
      return {
        title:title,
        idle:title.indexOf('暂时没有需要你的')>=0,
        cards:document.querySelectorAll('#homeTodo [data-pending-id]').length,
        runs:document.querySelectorAll('#homeRun .runrow').length,
        resumeOk:!!resume && resume.getBoundingClientRect().height>0 && !resume.disabled
      }
    })()`)
    check('N=0：标题换成「暂时没有需要你的」，在跑区与「继续上次会话」仍在',
      idle.idle && idle.cards === 0 && idle.runs > 0 && idle.resumeOk,
      JSON.stringify(idle))

    // ── 6：审批仍然走 /taskwatch/approve ─────────────────────────────────────
    await p.load()
    const approve = await p.eval(`(async function(){
      var calls=[];
      var real=window.fetch;
      window.fetch=function(u,o){
        calls.push({u:String(u), body:(o&&o.body)||''});
        return Promise.resolve({ok:true,status:200,
          json:function(){return Promise.resolve({ok:true,outcome:'allowed-once'})}});
      };
      var allow=document.querySelector('#homeTodo [data-approve]');
      if(!allow){ window.fetch=real; return {found:false} }
      var id=allow.getAttribute('data-approve');
      allow.click();
      await new Promise(function(r){ setTimeout(r,80) });
      var confirm=document.getElementById('approveConfirm');
      var confirmOpen=!confirm.hidden;
      var confirmTitle=(document.querySelector('#approveConfirm h3')||{}).textContent||'';
      var ok=confirm.querySelector('[data-confirm-ok]');
      if(ok) ok.click();
      await new Promise(function(r){ setTimeout(r,400) });
      var afterState=(document.querySelector('#homeTodo [data-pending-id="'+id+'"] [data-state]')||{}).textContent||'';
      // 「不再冒按钮」看的是**可见**按钮：处理完 .approval-actions 是 hidden，
      // 属性还在 DOM 里（和会话抽屉同一套处理函数），所以不能只数节点。
      var vis=function(){ return [].filter.call(document.querySelectorAll('#homeTodo [data-approve]'),
        function(b){ return b.getBoundingClientRect().height>0 }).length };
      var allowLeft=vis();
      renderHome();                      // 轮询重建一次：处理结果不能被"复活"
      var allowAgain=vis();
      var textAgain=document.getElementById('homeTodo').textContent;
      window.fetch=real;
      return {found:true, id:id, calls:calls, confirmOpen:confirmOpen, confirmTitle:confirmTitle,
        afterState:afterState, allowLeft:allowLeft, allowAgain:allowAgain,
        settledAgain:afterState.length>0 && textAgain.indexOf(afterState)>=0}
    })()`)
    const post = approve.calls.find((c) => c.u.indexOf('/taskwatch/approve') === 0)
    let body = {}
    try { body = JSON.parse(post.body) } catch (e) {}
    check('审批按钮仍然 POST /taskwatch/approve（decision=allow，同一 id）',
      approve.found && !!post && body.decision === 'allow' && String(body.id) === approve.id,
      JSON.stringify({ found:approve.found, calls:approve.calls, body:body }))
    check('批准仍要二次确认，处理完不会再冒出按钮',
      approve.confirmOpen && /确认允许一次？/.test(approve.confirmTitle) &&
      approve.allowLeft === 0 && approve.allowAgain === 0 && approve.settledAgain,
      JSON.stringify({ confirmTitle:approve.confirmTitle, left:approve.allowLeft,
        again:approve.allowAgain, state:approve.afterState }))
  } finally {
    await p.close()
  }

  // ── 3：路由与返回 ─────────────────────────────────────────────────────────
  console.log('\n[390] 路由：#session/<id> 与返回首页')
  const q = await openPage(browser, url, 390)
  try {
    await q.load('#session/session-demo-a')
    const deep = await q.eval(`(function(){
      var home=document.getElementById('home'), log=document.getElementById('log');
      var btn=document.getElementById('sessBtn');
      return {
        hash:location.hash,
        sessionShown:log?log.getBoundingClientRect().height>0:false,
        homeHidden:home?home.getBoundingClientRect().height===0:false,
        label:btn?btn.getAttribute('aria-label'):'',
        // 图标是 <svg>：用属性判断，别用 .hidden 属性（在 SVG 上只会挂个 expando，
        // 看起来"改过了"，屏幕上却还是那把汉堡菜单）。
        backIcon:!!document.getElementById('sessBackIco') &&
          !document.getElementById('sessBackIco').hasAttribute('hidden'),
        menuIcon:!!document.getElementById('sessMenuIco') &&
          !document.getElementById('sessMenuIco').hasAttribute('hidden'),
        sid:S.sessionId,
        hasReturn:!!btn && /返回首页/.test(btn.getAttribute('aria-label')||'')
      }
    })()`)
    check('#session/<id> 直接进会话视图，顶部有明确的「返回首页」',
      deep.hash === '#session/session-demo-a' && deep.sessionShown && deep.homeHidden &&
      deep.hasReturn && deep.backIcon && !deep.menuIcon && deep.sid === 'session-demo-a',
      JSON.stringify(deep))

    const back1 = await q.eval(`(async function(){
      document.getElementById('sessBtn').click();
      await new Promise(function(r){ setTimeout(r,200) });
      var home=document.getElementById('home');
      return {hash:location.hash, homeShown:home?home.getBoundingClientRect().height>0:false,
        label:document.getElementById('sessBtn').getAttribute('aria-label')}
    })()`)
    check('点「返回首页」回到首页（地址栏不再挂 #session/）',
      back1.hash === '' && back1.homeShown && /全部会话/.test(back1.label),
      JSON.stringify(back1))

    // 从首页进会话要真的压一条历史：系统返回手势走的就是 popstate。
    const gesture = await q.eval(`(async function(){
      var row=document.querySelector('#homeRun .runrow');
      if(!row) return {rowFound:false}
      var id=row.getAttribute('data-sess');
      row.click();
      await new Promise(function(r){ setTimeout(r,250) });
      var pushed=location.hash;
      var logShown=document.getElementById('log').getBoundingClientRect().height>0;
      history.back();                    // = 手机上的返回手势
      await new Promise(function(r){ setTimeout(r,400) });
      var home=document.getElementById('home');
      return {rowFound:true, id:id, pushed:pushed, logShown:logShown,
        hashAfter:location.hash, homeAfter:home?home.getBoundingClientRect().height>0:false}
    })()`)
    check('从首页进会话压一条历史，返回手势直接回首页',
      gesture.rowFound && gesture.pushed === '#session/' + gesture.id && gesture.logShown &&
      gesture.hashAfter === '' && gesture.homeAfter,
      JSON.stringify(gesture))
  } finally {
    await q.close()
  }

  // ── 5：360 宽也不横向溢出 ─────────────────────────────────────────────────
  console.log('\n[360] 首页不横向溢出')
  const w = await openPage(browser, url, 360)
  try {
    await w.load()
    const widths360 = await w.eval(`(function(){
      var home=document.getElementById('home');
      return {iw:innerWidth,doc:document.documentElement.scrollWidth,
        body:document.body.scrollWidth,home:home.scrollWidth,
        title:document.getElementById('sessTitle').textContent.trim(),
        cardTop:(function(){var c=document.querySelector('#homeTodo [data-pending-id]');
          return c?Math.round(c.getBoundingClientRect().top):null})()}
    })()`)
    check('360 宽：document/body/#home 都没有横向溢出，待办卡仍在首屏',
      widths360.doc <= widths360.iw + 1 && widths360.body <= widths360.iw + 1 &&
      widths360.home <= widths360.iw + 1 && widths360.cardTop !== null && widths360.cardTop < 844,
      JSON.stringify(widths360))
  } finally {
    await w.close()
  }

  console.log(`\n${passed} 通过 / ${failed} 失败`)
  if (failed) process.exitCode = 1
} catch (e) {
  console.error('\n首页自检执行失败：' + (e && e.stack || e))
  process.exitCode = 1
} finally {
  if (child) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关闭 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 文件被占用就下次再删 */ } }
}
