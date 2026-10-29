/**
 * 入口切换器（v1.8.12，P3）的验收截图。
 *
 * 真 Chrome headless + CDP，DPR2，390 宽（高 1000，一屏放下清单与添加表单）。
 * 输出到 D:\Projects\_ui-review\round19\；主图另存一份到 docs/screenshots/current/，
 * README 引用的是同一张，材料只留一份。
 *
 * 每张图先做页面级自检：整屏真的显示了、无横向溢出、无破图、行高 ≥64px、
 * 可点元素 ≥44px、超长地址只在本行截断；`entries-add.png` 另外断言错误文案
 * 可见且没有被截断。任一失败就退出非 0，不留下"看起来能用"的图。
 *
 * 用法：node scripts/shoot-entries.mjs
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
const OUT = 'D:\\Projects\\_ui-review\\round19'
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
    // 抽屉那张图要打开会话列表；给一个空列表就够（入口那一行不看会话内容）。
    if (path === '/taskwatch/chat/sessions') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end('{"sessions":[]}')
      return
    }
    res.writeHead(404); res.end('not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port

  profile = mkdtempSync(join(tmpdir(), 'tw-entries-shots-'))
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

  // 截图用的清单：本机 + 家里 + 公司（超长主机名，专门验截断）+ 会议室。
  const seed = [
    { label: '本机', url: base },
    { label: '家里', url: 'http://192.168.1.10:3099' },
    { label: '公司', url: 'http://upstairs-office-nas-with-a-very-long-hostname.local:3099' },
    { label: '会议室', url: 'http://192.168.1.77:52676' },
  ]

  const failures = []
  async function shot(name, {
    width = 390, height = 880, scheme = 'light', setup = '', needError = false,
    hash = '#entries', drawer = false,
  } = {}) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    // 先预热一次、写好主题与清单再导航：避免截到颜色过渡或「本机」自动生成的中途。
    await cdp.send('Page.navigate', { url: base + '/taskwatch?warm=1' })
    await sleep(600)
    await evalJs(`
      try { localStorage.setItem('taskwatch.theme', ${JSON.stringify(scheme)}) } catch (e) {}
      try { localStorage.setItem('tw-font', 'medium') } catch (e) {}
      try { localStorage.setItem('tw:entries', ${JSON.stringify(JSON.stringify(seed))}) } catch (e) {}
      'ok'
    `)
    await cdp.send('Page.navigate', { url: base + '/taskwatch?shot=' + name + hash })
    await sleep(1700)
    if (setup) { await evalJs(setup); await sleep(450) }

    if (drawer) {
      // 入口的入口：抽屉里那一行必须写着**当前入口名**，而且整行 ≥44px。
      const pill = JSON.parse(await evalJs(`JSON.stringify((function () {
        var btn = document.querySelector('#sheet .pill[data-act="entries"]');
        var r = btn ? btn.getBoundingClientRect() : null;
        return {
          shown: !!(btn && r.height > 0),
          text: btn ? btn.textContent.replace(/\\s+/g, ' ').trim() : '',
          h: r ? Math.round(r.height) : 0,
          overflow: document.documentElement.scrollWidth - innerWidth
        };
      })())`))
      if (!pill.shown) failures.push(name + '：抽屉里没有「入口」那一行')
      if (!/入口 · 本机/.test(pill.text)) failures.push(name + '：抽屉里的入口行没写当前入口名 — ' + pill.text)
      if (pill.h < 44) failures.push(name + '：抽屉入口行只有 ' + pill.h + 'px')
      if (pill.overflow > 1) failures.push(name + '：抽屉横向溢出 ' + pill.overflow)
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const buf = Buffer.from(png.data, 'base64')
      writeFileSync(join(OUT, name + '.png'), buf)
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
      console.log(`  ${name}.png  ${w}x${h}  drawer="${pill.text}"  h=${pill.h}`)
      return
    }

    const audit = JSON.parse(await evalJs(`JSON.stringify((function () {
      var view = document.getElementById('entriesView');
      var body = document.getElementById('entriesBody');
      var rows = [].slice.call(document.querySelectorAll('#entList .entrow'));
      var targets = [].slice.call(document.querySelectorAll(
        '#entriesView .ent-btn, #entriesView .ent-add, #entriesView input'));
      var small = targets.filter(function (t) {
        var r = t.getBoundingClientRect();
        return r.height > 0 && (r.height < 43.5 || r.width < 43.5);
      }).map(function (t) { return (t.className || t.id) + ':' + Math.round(t.getBoundingClientRect().height) });
      var urls = [].slice.call(document.querySelectorAll('#entList .ent-url'));
      var clipped = urls.filter(function (u) { return u.scrollWidth > u.clientWidth });
      var over = urls.filter(function (u) {
        var row = u.closest('.entrow');
        return !row || u.getBoundingClientRect().right > row.getBoundingClientRect().right + 1;
      });
      var bad = [].slice.call(document.images).filter(function (i) {
        var r = i.getBoundingClientRect();
        return r.height > 0 && r.top < innerHeight && r.bottom > 0 && !(i.complete && i.naturalWidth > 0);
      }).map(function (i) { return String(i.src).slice(0, 60) });
      var err = document.getElementById('entError');
      var er = err ? err.getBoundingClientRect() : null;
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        shown: view ? view.getBoundingClientRect().height > 0 : false,
        rows: rows.length,
        rowH: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : 0,
        overflow: document.documentElement.scrollWidth - innerWidth,
        bodyOverflow: document.body.scrollWidth - innerWidth,
        viewOverflow: view ? view.scrollWidth - innerWidth : 0,
        bodyW: body ? body.scrollWidth : 0,
        targets: targets.length,
        small: small,
        clipped: clipped.length,
        over: over.length,
        broken: bad,
        errText: err ? err.textContent.trim() : '',
        errH: er ? Math.round(er.height) : 0,
        errClip: err ? err.scrollWidth - err.clientWidth : 0,
        now: (document.getElementById('entNow') || {}).textContent || ''
      };
    })())`))
    if (!audit.shown) failures.push(name + '：入口页没有显示')
    if (audit.overflow > 1 || audit.bodyOverflow > 1 || audit.viewOverflow > 1) {
      failures.push(name + '：横向溢出 doc=' + audit.overflow + ' body=' + audit.bodyOverflow + ' view=' + audit.viewOverflow)
    }
    if (audit.broken.length) failures.push(name + '：破图 ' + audit.broken.join(' | '))
    if (audit.rows < 4) failures.push(name + '：清单只有 ' + audit.rows + ' 行')
    if (audit.rowH < 64) failures.push(name + '：行高只有 ' + audit.rowH + 'px')
    if (audit.small.length) failures.push(name + '：可点元素小于 44px — ' + audit.small.join(' | '))
    if (audit.clipped < 1) failures.push(name + '：超长地址没有被截断（列表撑宽了）')
    if (audit.over) failures.push(name + '：地址越出本行右缘')
    if (needError && (!audit.errText || audit.errH < 1 || audit.errClip > 1)) {
      failures.push(name + '：错误文案不可读 — ' + JSON.stringify({ text: audit.errText, h: audit.errH, clip: audit.errClip }))
    }

    const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(png.data, 'base64')
    writeFileSync(join(OUT, name + '.png'), buf)
    if (name === 'entries') {
      const dir = join(ROOT, 'docs', 'screenshots', 'current')
      mkdirSync(dir, { recursive: true })
      copyFileSync(join(OUT, name + '.png'), join(dir, name + '.png'))
    }
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
    console.log(`  ${name}.png  ${w}x${h}  rows=${audit.rows}  rowH=${audit.rowH}  ` +
      `overflow=${audit.overflow}  theme=${audit.theme}  clipped=${audit.clipped}` +
      (audit.errText ? '  err="' + audit.errText.slice(0, 18) + '…"' : ''))
  }

  console.log('生成 _ui-review/round19/：')
  await shot('entries', { note: '清单 + 添加表单' })
  await shot('entries-add', {
    // 填一个会被拒绝的地址并提交：错误文案必须在一屏里读到。
    setup: `(function(){
      document.getElementById('entLabel').value = '书房';
      document.getElementById('entUrl').value = 'javascript:alert(1)';
      var f = document.getElementById('entForm');
      if (f.requestSubmit) f.requestSubmit(); else document.getElementById('entAdd').click();
      var body = document.getElementById('entriesBody');
      if (body) body.scrollTop = body.scrollHeight;
      return 'ok';
    })()`,
    needError: true,
  })
  await shot('entries-dark', { scheme: 'dark' })
  // 入口的入口：抽屉里那一行。抽屉内容比一屏长，滚到底才看得到「工作台 / 操作」。
  await shot('entries-drawer', {
    hash: '', height: 844, drawer: true,
    setup: `(async function(){
      document.getElementById('sessBtn').click();
      await new Promise(function (r) { setTimeout(r, 900) });
      var card = document.getElementById('card');
      if (card) card.scrollTop = card.scrollHeight;
      return 'ok';
    })()`,
  })

  if (failures.length) {
    console.error('\n截图自检失败：')
    for (const f of failures) console.error('  - ' + f)
    process.exitCode = 1
  } else {
    console.log('\n全部通过：无横向溢出、无破图、行高与命中区达标、长地址截断、错误文案可读。')
  }
} catch (e) {
  console.error('截图异常：' + ((e && e.stack) || e))
  process.exitCode = 1
} finally {
  try { if (child) child.kill() } catch (e) {}
  try { if (server) server.close() } catch (e) {}
  try { if (profile) rmSync(profile, { recursive: true, force: true }) } catch (e) {}
}
