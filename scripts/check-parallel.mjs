/**
 * 并行视图（v1.8.10，P5）的回归自检。
 *
 * 这一版唯一不能退让的是**排序**：需要你 > 失败 > 运行中 > 已完成最近。
 * 手机上「一屏看清」如果失败被埋在运行中下面，这个视图就没有存在意义。所以
 * 和 check-home 一样用真 Chrome + CDP 打开 docs/demo.html（由当前 page.html
 * 生成），再通过页面自己的数据入口喂 5 条会话，断言的是 DOM 里的真实顺序。
 *
 * 六组断言：
 *   1. 5 条会话（1 需要你 / 1 失败 / 2 运行 / 1 空闲）的 DOM 顺序严格为
 *      需要你 → 失败 → 运行中 → 空闲；
 *   2. 失败行的原因可见、且 ≤60 字；
 *   3. 「子代理 N」展开 / 收起，反复展开不重复渲染；
 *   4. 390 宽首屏 ≥3 行、无横向溢出、标题 2 行截断、命中区 ≥44px；
 *   5. 空态文案与「开一个新会话」按钮存在；
 *   6. 状态更新时只改对应行：MutationObserver 计数 + 其他行仍是原来的 DOM 节点。
 *
 * 本机没有 Chrome 就 SKIP（不算失败）；不联网、不碰真实中继，临时 profile 用完即删。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readDevToolsPort } from './devtools-port.mjs'
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
  console.log('SKIP 并行视图自检：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
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
    const port = readDevToolsPort(file)
    if (port) return Number(port)
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
  let caseNo = 0
  const load = async (hash = '') => {
    caseNo++
    await cdp.send('Page.navigate', { url: url + '?case=' + caseNo + hash })
    await sleep(1700)
  }
  return {
    cdp, eval: evalJs, load,
    close: async () => { try { await browser.send('Target.closeTarget', { targetId }) } catch (e) {} cdp.close() },
  }
}

/** 测试夹具：形状与 /taskwatch/data 完全一致（页面不认"测试专用"字段）。 */
function fixture(now) {
  const S = (sec) => now - sec * 1000
  return {
    generatedAt: now,
    offline: false,
    errors: [],
    riskConfirm: true,
    totals: { sessions: 5, running: 2, jobs: 0, jobsRunning: 0, subagents: 2, workflows: 0, pending: 1 },
    today: { since: S(6 * 3600), turns: 4, steps: 20, sessions: 5, partial: false },
    pending: [
      {
        id: 'p-needs', kind: 'approval/request', title: 'pwsh',
        detail: '要在仓库根目录跑发布命令，需要你批准。',
        session: 's-needs', sessionTitle: '准备发布 1.8.10',
        at: S(20), canDecide: true, expiresAt: now + 100000, timeoutMs: 120000,
      },
    ],
    sessions: [
      {
        id: 's-needs', title: '准备发布 1.8.10：把三处旧接口收口',
        running: false, activeJobs: 0, live: true, origin: 'root', depth: 0,
        preset: 'cordis', lastActivity: S(25), lastTool: 'grep', lastToolAt: S(28),
        turnStartedAt: S(600), stepsInTurn: 2, failure: null, goal: null,
      },
      {
        id: 's-fail', title: '排查支付回调在并发下的幂等失败',
        running: false, activeJobs: 0, live: true, origin: 'root', depth: 0,
        preset: 'cordis', lastActivity: S(120), lastTool: 'pwsh', lastToolAt: S(130),
        turnStartedAt: S(420), stepsInTurn: 5, goal: null,
        failure: {
          at: S(120), kind: 'error',
          reason: '命令 pnpm test --filter payments 退出码 1：幂等键在并发重投时偶发重复入账，重试 3 次仍失败，需要先修好再继续，否则后面的 e2e 全部会跟着红。',
        },
      },
      {
        id: 's-run-a', title: '把发布流程改成可回滚的两步',
        running: true, activeJobs: 1, live: true, origin: 'root', depth: 0,
        preset: 'cordis', lastActivity: S(2), lastTool: 'edit', lastToolAt: S(9),
        turnStartedAt: S(90), stepsInTurn: 3, failure: null, goal: null,
      },
      {
        id: 's-run-b', title: '补三组 390 宽的回归用例',
        running: true, activeJobs: 0, live: true, origin: 'root', depth: 0,
        preset: 'cordis', lastActivity: S(5), lastTool: 'pwsh', lastToolAt: S(12),
        turnStartedAt: S(150), stepsInTurn: 2, failure: null, goal: null,
      },
      {
        id: 's-idle', title: '整理上一轮的发布记录',
        running: false, activeJobs: 0, live: true, origin: 'root', depth: 0,
        preset: 'cordis', lastActivity: S(3600), lastTool: '', lastToolAt: 0,
        turnStartedAt: 0, stepsInTurn: null, failure: null, goal: null,
      },
    ],
    subagents: [
      { id: 's-sub-a', parent: 's-needs', depth: 1, activity: 'running', mode: 'subagent', label: '核对发布清单' },
      { id: 's-sub-b', parent: 's-needs', depth: 1, activity: 'idle', mode: 'subagent', label: '翻译发布说明' },
    ],
    jobs: [],
    workflows: [],
  }
}

const applyFixture = (d) => `(function(){
  lastData = ${JSON.stringify(d)};
  HOME_GOOD = lastData;
  HOME_GOOD_AT = Date.now();
  S.sessions = lastData.sessions;
  renderParallel();
  return true;
})()`

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

  profile = mkdtempSync(join(tmpdir(), 'tw-parallel-chrome-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const port = await waitPort(profile, child)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  browser.port = port

  console.log('\n[390] 并行视图：排序 / 失败原因 / 子代理 / 空态 / 增量更新')
  const p = await openPage(browser, url, 390)
  try {
    await p.load('#parallel')
    const first = await p.eval(`(function(){
      var view = document.getElementById('parallelView');
      return {
        hash: location.hash,
        shown: view ? view.getBoundingClientRect().height > 0 : false,
        empty: !document.getElementById('parallelEmpty').hidden
      }
    })()`)
    check('#parallel 打开整屏并行视图',
      first.hash === '#parallel' && first.shown && !first.empty,
      JSON.stringify(first))

    // ── 1：注入 5 条会话，断言严格顺序 ─────────────────────────────────────
    const now = Date.now()
    const FIX = fixture(now)
    await p.eval(applyFixture(FIX))
    await sleep(120)
    const order = await p.eval(`(function(){
      var rows = [].slice.call(document.querySelectorAll('#parallelList .par-row'));
      return rows.map(function(r){
        var b = r.querySelector('.par-badge');
        return {
          id: r.getAttribute('data-sess'),
          badge: b ? b.textContent.trim() : '',
          title: (r.querySelector('.par-name')||{}).textContent || ''
        }
      });
    })()`)
    const ids = order.map((r) => r.id)
    const badges = order.map((r) => r.badge)
    check('5 条会话的 DOM 顺序严格为「需要你 → 失败 → 运行中 → 空闲」',
      JSON.stringify(ids) === JSON.stringify(['s-needs', 's-fail', 's-run-a', 's-run-b', 's-idle']),
      JSON.stringify(ids))
    check('状态徽标文案与排序一致',
      JSON.stringify(badges) === JSON.stringify(['需要你', '失败', '运行中', '运行中', '空闲']),
      JSON.stringify(badges))

    // ── 2：失败行的原因可见、≤60 字 ────────────────────────────────────────
    const fail = await p.eval(`(function(){
      var row = document.querySelector('#parallelList .par-row[data-sess="s-fail"]');
      var why = row ? row.querySelector('.par-why') : null;
      var view = row ? row.querySelector('.par-view') : null;
      var r = why ? why.getBoundingClientRect() : null;
      return {
        text: why ? why.textContent.trim() : '',
        len: why ? why.textContent.trim().length : 0,
        visible: !!(r && r.height > 0 && r.width > 0),
        viewText: view ? view.textContent.trim() : '',
        viewH: view ? Math.round(view.getBoundingClientRect().height) : 0
      }
    })()`)
    check('失败行有可见的一句失败原因、且 ≤60 字',
      fail.visible && fail.len > 0 && fail.len <= 60,
      JSON.stringify({ len: fail.len, visible: fail.visible, text: fail.text }))
    check('失败行有「查看」入口且命中区 ≥44px',
      /^查看$/.test(fail.viewText) && fail.viewH >= 44,
      JSON.stringify({ text: fail.viewText, h: fail.viewH }))

    // ── 3：子代理展开 / 收起，不重复渲染 ──────────────────────────────────
    const subs = await p.eval(`(async function(){
      var row = document.querySelector('#parallelList .par-row[data-sess="s-needs"]');
      var btn = row ? row.querySelector('.par-subtoggle') : null;
      var list = row ? row.querySelector('.par-sublist') : null;
      var out = {
        toggleText: btn ? btn.textContent.trim() : '',
        hidden0: list ? list.hidden : null,
        count0: list ? list.querySelectorAll('.par-sub').length : 0
      };
      if (!btn || !list) return out;
      btn.click();
      await new Promise(function(r){ setTimeout(r, 60) });
      out.hidden1 = list.hidden;
      out.count1 = list.querySelectorAll('.par-sub').length;
      out.subs1 = [].slice.call(list.querySelectorAll('.par-sub')).map(function(x){ return x.textContent.trim() });
      out.expanded1 = btn.getAttribute('aria-expanded');
      btn.click();
      await new Promise(function(r){ setTimeout(r, 60) });
      out.hidden2 = list.hidden;
      btn.click();
      await new Promise(function(r){ setTimeout(r, 60) });
      out.hidden3 = list.hidden;
      out.count3 = list.querySelectorAll('.par-sub').length;
      out.expanded3 = btn.getAttribute('aria-expanded');
      return out;
    })()`)
    check('子代理「子代理 2」展开后列出 2 条、再收起',
      /子代理\s*2/.test(subs.toggleText) && subs.hidden0 === true &&
      subs.hidden1 === false && subs.count1 === 2 && subs.expanded1 === 'true' &&
      subs.hidden2 === true && subs.hidden3 === false && subs.expanded3 === 'true',
      JSON.stringify(subs))
    check('反复展开 / 收起后子代理仍只有 2 条（不重复渲染）',
      subs.count3 === 2 && subs.count0 === 2,
      JSON.stringify({ count0: subs.count0, count3: subs.count3, subs: subs.subs1 }))

    // ── 4：390 宽首屏 ≥3 行、无横向溢出、标题 2 行截断、44px 命中区 ────────
    const geo = await p.eval(`(function(){
      var rows = [].slice.call(document.querySelectorAll('#parallelList .par-row'));
      var visible = rows.filter(function(r){
        var b = r.getBoundingClientRect();
        return b.height > 0 && b.top < innerHeight && b.bottom > 0;
      });
      var name = document.querySelector('#parallelList .par-name');
      var main = document.querySelector('#parallelList .par-main');
      var view = document.querySelector('#parallelList .par-row[data-sess="s-fail"] .par-view');
      var toggle = document.querySelector('#parallelList .par-subtoggle');
      var cs = name ? getComputedStyle(name) : null;
      return {
        iw: innerWidth, ih: innerHeight,
        doc: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        par: document.getElementById('parallelView').scrollWidth,
        rows: rows.length,
        visible: visible.length,
        firstThreeIn: visible.length >= 3 && visible.slice(0,3).every(function(r){ return r.getBoundingClientRect().top < innerHeight }),
        clamp: cs ? (cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp') || '') : '',
        mainH: main ? Math.round(main.getBoundingClientRect().height) : 0,
        viewH: view ? Math.round(view.getBoundingClientRect().height) : 0,
        toggleH: toggle ? Math.round(toggle.getBoundingClientRect().height) : 0
      }
    })()`)
    check('390 宽首屏至少 3 行可见',
      geo.visible >= 3 && geo.firstThreeIn,
      JSON.stringify({ visible: geo.visible, rows: geo.rows, ih: geo.ih }))
    check('390 宽无横向溢出',
      geo.doc <= geo.iw + 1 && geo.body <= geo.iw + 1 && geo.par <= geo.iw + 1,
      JSON.stringify({ doc: geo.doc, body: geo.body, par: geo.par, iw: geo.iw }))
    check('标题按 2 行截断（line-clamp:2）',
      String(geo.clamp).trim() === '2',
      JSON.stringify({ clamp: geo.clamp }))
    check('行 / 查看 / 子代理开关命中区均 ≥44px',
      geo.mainH >= 44 && geo.viewH >= 44 && geo.toggleH >= 44,
      JSON.stringify({ main: geo.mainH, view: geo.viewH, toggle: geo.toggleH }))

    // ── 5：空态文案与按钮 ─────────────────────────────────────────────────
    const emptyFix = Object.assign({}, FIX, { sessions: [], subagents: [], pending: [], totals: {} })
    await p.eval(applyFixture(emptyFix))
    await sleep(120)
    const empty = await p.eval(`(function(){
      var box = document.getElementById('parallelEmpty');
      var btn = document.getElementById('parallelNew');
      var r = box ? box.getBoundingClientRect() : null;
      return {
        shown: box ? !box.hidden && r.height > 0 : false,
        text: box ? box.textContent.replace(/\\s+/g, ' ').trim() : '',
        btn: btn ? btn.textContent.trim() : '',
        btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0
      }
    })()`)
    check('空态显示「现在没有在跑的会话」+「开一个新会话」按钮',
      empty.shown && /现在没有在跑的会话/.test(empty.text) &&
      /开一个新会话/.test(empty.btn) && empty.btnH >= 44,
      JSON.stringify(empty))

    // ── 6：状态更新只改对应行 ─────────────────────────────────────────────
    await p.eval(applyFixture(FIX))
    await sleep(120)
    const before = await p.eval(`(function(){
      window.__parRefs = [].slice.call(document.querySelectorAll('#parallelList .par-row'));
      window.__parMut = window.__parRefs.map(function(){ return 0 });
      window.__parObs = window.__parRefs.map(function(row, i){
        var o = new MutationObserver(function(muts){
          for (var k = 0; k < muts.length; k++) if (muts[k].type === 'childList') window.__parMut[i]++;
        });
        o.observe(row, { childList: true, subtree: true });
        return o;
      });
      return window.__parRefs.length;
    })()`)
    const FIX2 = JSON.parse(JSON.stringify(FIX))
    const changed = FIX2.sessions.filter((s) => s.id === 's-run-b')[0]
    changed.lastTool = 'grep'
    changed.stepsInTurn = 6
    await p.eval(applyFixture(FIX2))
    await sleep(180)
    const after = await p.eval(`(function(){
      var rows = [].slice.call(document.querySelectorAll('#parallelList .par-row'));
      var changed = document.querySelector('#parallelList .par-row[data-sess="s-run-b"]');
      var act = changed ? changed.querySelector('.par-act') : null;
      return {
        sameNodes: rows.length === window.__parRefs.length && rows.every(function(r, i){ return r === window.__parRefs[i] }),
        muts: window.__parMut.slice(),
        changedIndex: rows.indexOf(changed),
        changedText: act ? act.textContent.trim() : '',
        order: rows.map(function(r){ return r.getAttribute('data-sess') })
      }
    })()`)
    const otherMuts = after.muts.reduce((a, b, i) => i === after.changedIndex ? a : a + b, 0)
    check('状态更新只改对应行：其他行仍是原来的 DOM 节点且 0 次 childList 变更',
      before === 5 && after.sameNodes && otherMuts === 0,
      JSON.stringify({ before, sameNodes: after.sameNodes, muts: after.muts, changedIndex: after.changedIndex }))
    check('对应行原地更新了最新动作，顺序未被重建',
      /搜索内容/.test(after.changedText) && /第 6 步/.test(after.changedText) &&
      JSON.stringify(after.order) === JSON.stringify(['s-needs', 's-fail', 's-run-a', 's-run-b', 's-idle']),
      JSON.stringify({ text: after.changedText, order: after.order }))
  } finally {
    await p.close()
  }
  console.log('\n结果：PASS ' + passed + ' / FAIL ' + failed)
  if (failed) process.exitCode = 1
} catch (e) {
  console.error('\n自检异常：' + ((e && e.stack) || e))
  process.exitCode = 1
} finally {
  try { if (child) child.kill() } catch (e) {}
  try { if (server) server.close() } catch (e) {}
  try { if (profile) rmSync(profile, { recursive: true, force: true }) } catch (e) {}
}
