/**
 * 重拍 README 用的手机界面截图（v1.8.0）。
 *
 * 为什么用 docs/demo.html 而不是真实宿主页：真实页面里有会话标题、cwd、命令和对话正文，
 * 那些是使用者的私有数据。demo.html 是 scripts/make-demo.mjs 从当前 lib/page.html 生成的，
 * 只替换取数与启动逻辑，所以截出来的就是**当前实现**，不是手画的稿。
 *
 * 做法：真 Chrome headless + CDP，DPR2，390×844（wide-360 一张用 360×844）。
 * 每张图都断言页面级没有横向溢出、没有破图；失败直接退出非 0，不留下"看起来能用"的图。
 *
 * 用法：node scripts/make-shots.mjs
 * 输出：docs/screenshots/current/*.png
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(ROOT, 'docs', 'demo.html')
const ICON_DIR = join(ROOT, 'lib', 'icons')
const MANIFEST = join(ROOT, 'lib', 'manifest.webmanifest')
const OUT = join(ROOT, 'docs', 'screenshots', 'current')
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

let server = null
let child = null
let profile = ''
try {
  mkdirSync(OUT, { recursive: true })
  const html = readFileSync(DEMO, 'utf8')
  const manifest = readFileSync(MANIFEST)
  const icon192 = readFileSync(join(ICON_DIR, 'icon-192.png'))
  const icon512 = readFileSync(join(ICON_DIR, 'icon-512.png'))

  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/taskwatch' || path === '/taskwatch/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    if (path === '/taskwatch/icon-192.png') {
      res.writeHead(200, { 'content-type': 'image/png' }); res.end(icon192); return
    }
    if (path === '/taskwatch/icon-512.png') {
      res.writeHead(200, { 'content-type': 'image/png' }); res.end(icon512); return
    }
    if (path === '/taskwatch/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' }); res.end(manifest); return
    }
    res.writeHead(404); res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-shots-chrome-'))
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=2',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const port = await waitPort(profile, child)
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const browser = await Cdp.connect(version.webSocketDebuggerUrl)
  browser.port = port

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const info = targets.find((t) => t.id === targetId)
  if (!info) throw new Error('找不到 target')
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }

  const failures = []
  async function shot(name, { width = 390, scheme = 'light', setup = '', note = '' } = {}) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height: 844, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    await cdp.send('Page.navigate', { url: base + '/taskwatch?shot=' + name + '&t=' + Date.now() })
    await sleep(1500)
    await evalJs(`
      try { localStorage.setItem('taskwatch.theme', ${JSON.stringify(scheme)}) } catch (e) {}
      try { localStorage.setItem('tw-font', 'medium') } catch (e) {}
      document.documentElement.setAttribute('data-theme', ${JSON.stringify(scheme)});
      document.documentElement.setAttribute('data-font', 'medium');
      setSub('演示数据 · 非真实状态');
      'ok'
    `)
    if (setup) { await evalJs(setup); await sleep(700) }

    const audit = JSON.parse(await evalJs(`JSON.stringify((function () {
      var imgs = [].slice.call(document.images)
      var broken = imgs.filter(function (i) { return !(i.complete && i.naturalWidth > 0) })
        .map(function (i) { return String(i.src).slice(0, 60) })
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        docW: document.documentElement.scrollWidth,
        bodyW: document.body.scrollWidth,
        viewW: window.innerWidth,
        imgs: imgs.length,
        broken: broken,
        toolgroups: document.querySelectorAll('.toolgroup').length,
        subview: !document.getElementById('subview').hidden,
        sheet: !document.getElementById('sheet').hidden,
        empty: !!document.querySelector('.empty'),
        codePre: (function () {
          var cs = document.querySelectorAll('.code'), t = null
          for (var i = 0; i < cs.length; i++) if (cs[i].querySelector('.scrollhint')) t = cs[i]
          if (!t) return null
          var pre = t.querySelector('pre')
          return pre ? { clientW: pre.clientWidth, scrollW: pre.scrollWidth } : null
        })(),
        scrollY: Math.round(scrollY)
      }
    })())`))

    if (audit.docW > audit.viewW + 1 || audit.bodyW > audit.viewW + 1) {
      failures.push(name + '：横向溢出 doc=' + audit.docW + ' body=' + audit.bodyW + ' view=' + audit.viewW)
    }
    if (audit.broken.length) failures.push(name + '：破图 ' + audit.broken.join(' | '))
    if (audit.empty && !audit.imgs) failures.push(name + '：空状态没有加载 logo')

    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    console.log(`  ${name}.png  ${w}x${h}  doc=${audit.docW}/${audit.viewW}  imgs=${audit.imgs}  ` +
      `toolgroup=${audit.toolgroups} subview=${audit.subview} sheet=${audit.sheet} empty=${audit.empty}` +
      (audit.codePre ? `  code ${audit.codePre.clientW}/${audit.codePre.scrollW}` : '') +
      (note ? '  ' + note : ''))
  }

  // #log 才是滚动容器（header / subbar / composer 固定）。用窗口 scrollTo 不会动，
  // 之前两张图因此都停在底部。这里统一按「元素顶边距 #log 顶边多少」来滚。
  const collapseToolGroup = `
    (function () {
      var box = document.getElementById('log')
      // demo 里的第 4 步是失败态，按当前规则失败分组默认展开；截图要的是**折叠后的
      // 一行摘要**，所以先把这次演示运行的 4 步标成全部完成，让默认状态就是折叠。
      for (var i = 0; i < S.items.length; i++) {
        if (S.items[i] && S.items[i].kind === 'tool') S.items[i].status = 'ok'
      }
      renderAll()
      var tb = document.getElementById('tobottom'); if (tb) tb.remove()
      var g = document.querySelector('.toolgroup')
      if (box && g) box.scrollTop += (g.getBoundingClientRect().top - box.getBoundingClientRect().top) - 12
      return 'ok'
    })()`
  const scrollToCode = `
    (function () {
      var box = document.getElementById('log')
      // 只留「长代码块」那条和最后一句说明：整段对话太长时，滚到底会把目标顶到
      // 视口中间（scrollTop 被最大值夹住），单独取这两条才能把代码块放稳在顶部。
      S.items = S.items.slice(-2)
      renderAll()
      var tb = document.getElementById('tobottom'); if (tb) tb.remove()
      var cs = document.querySelectorAll('.code'), t = null
      for (var i = 0; i < cs.length; i++) {
        var pre = cs[i].querySelector('pre')
        if (pre && pre.scrollWidth > pre.clientWidth + 40) t = cs[i]
      }
      if (!t) t = cs[cs.length - 1]
      if (box && t) box.scrollTop += (t.getBoundingClientRect().top - box.getBoundingClientRect().top) - 12
      return 'ok'
    })()`

  console.log('生成 docs/screenshots/current/：')
  await shot('chat-light', { scheme: 'light', setup: collapseToolGroup })
  await shot('chat-dark', { scheme: 'dark', setup: collapseToolGroup })
  await shot('code-block', { setup: scrollToCode })
  await shot('subagents', {
    setup: `location.hash = '#subagents'; 'ok'`,
  })
  await shot('drawer', {
    setup: `
      document.getElementById('sessBtn').click();
      setTimeout(function () { try { document.activeElement.blur() } catch (e) {} }, 250);
      'ok'
    `,
  })
  await shot('empty', {
    setup: `
      S.sessionId = 'session-demo-a';
      S.items = [];
      S.chatReady = true;
      S.pending = '';
      renderAll();
      renderSubagentBar();
      var box = document.getElementById('log');
      if (box) box.scrollTop = 0;
      var tb = document.getElementById('tobottom'); if (tb) tb.remove();
      'ok'
    `,
  })
  await shot('wide-360', {
    width: 360,
    setup: `
      (function () {
        // 只留表格 + 超长 URL 那条：360 宽下最容易把它们撑出横向滚动。
        S.items = S.items.filter(function (it) {
          return it.kind === 'assistant' && it.text && it.text.indexOf('| 步骤 |') >= 0
        })
        renderAll()
        var tb = document.getElementById('tobottom'); if (tb) tb.remove()
        var box = document.getElementById('log')
        if (box) box.scrollTop = 0
        return 'ok'
      })()
    `,
  })

  // v1.8.0：手机端一次性审批。给 demo 注入一条 canDecide 的 pending，再走真实的
  // openStatus / 按钮 / 二次确认路径；样式、44px、倒计时都取自当前页面。
  const approvalSetup = (expiresOffset, extra = '') => `
    (async function () {
      var now = Date.now();
      lastData = {generatedAt: now, offline: false, errors: [],
        totals: {sessions: 6, running: 2, jobs: 5, jobsRunning: 3, subagents: 2, workflows: 1, pending: 1},
        sessions: [], jobs: [], subagents: [], workflows: [],
        pending: [{kind: 'approval', id: 'approval-demo', title: 'pwsh',
          detail: '删除 build/cache 下的过期产物，需要你先确认。',
          session: 'session-demo-a', sessionTitle: '重构支付模块的重试逻辑',
          at: now, expiresAt: now + ${expiresOffset}, timeoutMs: 120000, canDecide: true}]};
      await openStatus();
      await new Promise(function (r) { setTimeout(r, 80) });
      var c = document.querySelector('#card .approval-card');
      if (c) c.scrollIntoView({block: 'center'});
      ${extra}
      return 'ok'
    })()
  `
  await shot('approval-card', { setup: approvalSetup(113000) })
  await shot('approval-confirm', {
    setup: approvalSetup(113000, `document.querySelector('#card [data-approve]').click(); await new Promise(function (r) { setTimeout(r, 120) });`),
  })
  await shot('approval-done', {
    setup: approvalSetup(113000, `
      window.fetch = function (u) {
        if (String(u).indexOf('/taskwatch/approve') === 0) {
          return Promise.resolve({ok: true, status: 200, json: function () { return Promise.resolve({ok: true, outcome: 'allowed-once'}) }})
        }
        return Promise.resolve({ok: true, status: 200, json: function () { return Promise.resolve({}) }})
      };
      document.querySelector('#card [data-approve]').click();
      await new Promise(function (r) { setTimeout(r, 120) });
      document.querySelector('[data-confirm-ok]').click();
      await new Promise(function (r) { setTimeout(r, 300) });
      var c = document.querySelector('#card .approval-card'); if (c) c.scrollIntoView({block: 'center'});
    `),
  })
  await shot('approval-expired', {
    setup: approvalSetup(-1000, `await new Promise(function (r) { setTimeout(r, 500) });`),
  })

  cdp.close()
  await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  browser.close()

  if (failures.length) {
    console.error('\n截图自检失败：\n  ' + failures.join('\n  '))
    process.exitCode = 1
  } else {
    console.log('\n全部截图通过：无横向溢出、无破图。')
  }
} finally {
  if (child) { try { child.kill() } catch { /* 已退出 */ } }
  if (server) { try { server.close() } catch { /* 已关闭 */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 文件被占用就下次再删 */ } }
}
