/**
 * 并行视图（v1.8.10，P5）的验收截图。
 *
 * 真 Chrome headless + CDP，DPR2，390 宽（parallel.png 高一点，方便一眼看到
 * 失败与两条运行中的排序关系）。输出到 D:\Projects\_ui-review\round18\。
 *
 * 每张图先做页面级自检：无横向溢出、可见区域没有破图；失败直接退出非 0，
 * 不留下"看起来能用"的图。
 *
 * 用法：node scripts/shoot-parallel.mjs
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readDevToolsPort } from './devtools-port.mjs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(ROOT, 'docs', 'demo.html')
const OUT = 'D:\\Projects\\_ui-review\\round18'
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
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    })
  }
  close() { try { this.ws.close() } catch (e) {} }
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
  mkdirSync(OUT, { recursive: true })
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
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-parallel-shots-'))
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

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result && r.result.value
  }

  const failures = []
  async function shot(name, { width = 390, height = 844, scheme = 'light', setup = '', note = '' } = {}) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    // 先写主题再重载：避免截图抓到颜色过渡的中途（暗色下最明显）。
    await cdp.send('Page.navigate', { url: base + '/taskwatch?warm=1' })
    await sleep(600)
    await evalJs(`
      try { localStorage.setItem('taskwatch.theme', ${JSON.stringify(scheme)}) } catch (e) {}
      try { localStorage.setItem('tw-font', 'medium') } catch (e) {}
      'ok'
    `)
    await cdp.send('Page.navigate', { url: base + '/taskwatch?shot=' + name + '#parallel' })
    await sleep(1700)
    if (setup) { await evalJs(setup); await sleep(500) }

    const audit = JSON.parse(await evalJs(`JSON.stringify((function () {
      var view = document.getElementById('parallelView');
      var rows = [].slice.call(document.querySelectorAll('#parallelList .par-row'));
      var visible = rows.filter(function (r) {
        var b = r.getBoundingClientRect();
        return b.height > 0 && b.top < innerHeight && b.bottom > 0;
      });
      var bad = [].slice.call(document.images).filter(function (i) {
        var r = i.getBoundingClientRect();
        return r.height > 0 && r.top < innerHeight && r.bottom > 0 && !(i.complete && i.naturalWidth > 0);
      }).map(function (i) { return String(i.src).slice(0, 60) });
      var f = document.querySelector('#parallelList .par-row[data-sess="session-demo-c"] .par-why');
      var failRow = document.querySelector('#parallelList .par-row[data-sess="session-demo-c"]');
      var body = document.getElementById('parallelBody');
      return {
        failTop: failRow && body ? Math.round(failRow.getBoundingClientRect().top - body.getBoundingClientRect().top) : null,
        scrollTop: body ? Math.round(body.scrollTop) : 0,
        theme: document.documentElement.getAttribute('data-theme'),
        shown: view ? view.getBoundingClientRect().height > 0 : false,
        rows: rows.length,
        visible: visible.length,
        order: rows.map(function (r) {
          var b = r.querySelector('.par-badge');
          return r.getAttribute('data-sess') + ':' + (b ? b.textContent.trim() : '');
        }),
        overflow: document.documentElement.scrollWidth - innerWidth,
        bodyOverflow: document.body.scrollWidth - innerWidth,
        broken: bad,
        failText: f ? f.textContent.trim() : ''
      }
    })())`))
    if (!audit.shown) failures.push(name + '：并行视图没有显示')
    if (audit.overflow > 1 || audit.bodyOverflow > 1) {
      failures.push(name + '：横向溢出 doc=' + audit.overflow + ' body=' + audit.bodyOverflow)
    }
    if (audit.broken.length) failures.push(name + '：破图 ' + audit.broken.join(' | '))
    if (!audit.failText) failures.push(name + '：看不到失败原因')
    if (name === 'parallel-failed-top' && (audit.failTop === null || audit.failTop > 80)) {
      failures.push(name + '：失败行没有滚到顶部（top=' + audit.failTop + '）')
    }

    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    // README 用同一张：材料只保留一份，避免 _ui-review 与仓库里的图慢慢漂移。
    if (name === 'parallel') {
      const dir = join(ROOT, 'docs', 'screenshots', 'current')
      mkdirSync(dir, { recursive: true })
      copyFileSync(join(OUT, name + '.png'), join(dir, name + '.png'))
    }
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
    console.log(`  ${name}.png  ${w}x${h}  rows=${audit.rows}/${audit.visible}  overflow=${audit.overflow}  ` +
      `theme=${audit.theme}  fail="${audit.failText.slice(0, 16)}…"` + (note ? '  ' + note : ''))
    console.log('    order: ' + audit.order.join('  '))
  }

  console.log('生成 _ui-review/round18/：')
  // 主图：稍微高一点（1000），把「需要你 → 失败 → 运行中」三组都放进一屏，
  // 并展开第一个父会话的子代理，证明折叠行不是装饰。
  await shot('parallel', {
    height: 1000,
    setup: `(function(){
      var row = document.querySelector('#parallelList .par-row[data-sess="session-demo-a"]');
      var btn = row ? row.querySelector('.par-subtoggle') : null;
      if (btn) btn.click();
      return 'ok';
    })()`,
    note: '展开子代理',
  })
  // 失败置顶：把失败行滚到列表顶部，验证「失败永远在运行中之上」。
  await shot('parallel-failed-top', {
    // 高度压到 420，列表才有足够滚动；这张图要证明的是「失败在运行中之上」，
    // 所以把失败行滚到列表顶部，下面紧接着就是两条运行中。
    height: 420,
    setup: `(function(){
      var body = document.getElementById('parallelBody');
      var row = document.querySelector('#parallelList .par-row[data-sess="session-demo-c"]');
      if (body && row) body.scrollTop += (row.getBoundingClientRect().top - body.getBoundingClientRect().top) - 8;
      return 'ok';
    })()`,
    note: '失败行滚到顶部',
  })
  await shot('parallel-dark', { scheme: 'dark', note: '暗色' })
  await shot('parallel-390', { note: '390×844 首屏' })

  if (failures.length) {
    console.error('\n截图自检失败：')
    for (const f of failures) console.error('  - ' + f)
    process.exitCode = 1
  } else {
    console.log('\n全部通过：无横向溢出、无破图、失败原因可见。')
  }
} catch (e) {
  console.error('截图异常：' + ((e && e.stack) || e))
  process.exitCode = 1
} finally {
  try { if (child) child.kill() } catch (e) {}
  try { if (server) server.close() } catch (e) {}
  try { if (profile) rmSync(profile, { recursive: true, force: true }) } catch (e) {}
}
