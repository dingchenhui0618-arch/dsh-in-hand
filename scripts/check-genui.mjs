#!/usr/bin/env node
/**
 * v1.8.25：手机页的 dsh-ui「确认表单」围栏（GitHub issue #1 的子集）。
 *
 * 分两层：
 *   1. 源码层（不需要浏览器）—— 围栏分支真的挂在 bubNode 上、普通语言仍进 codeNode、
 *      回退提示与回传协议模板逐字存在，且新增代码里没有 innerHTML / eval / new Function。
 *   2. 真浏览器（Chrome headless + CDP，390×844 DPR2）—— 打开 docs/demo.html
 *      （与 page.html 同源构建），在页面自己的渲染与发送路径上断言：
 *        · dsh-ui 走卡片、```js 仍进代码块；dsh-ui> / DSH-UI / 尾随冒号都认
 *        · 坏 JSON / 非对象 / 只有未知类型 → 代码块 + 那一行提示，不抛错
 *        · 未知 type 被丢弃，同围栏的 text / submit 照常渲染
 *        · radio.group + submit.groups：没选时禁用、填完可提交
 *        · 提交消息逐字等于 dsh-genui 的 [genui-action] 模板（answers/fields/total/answered）
 *        · 同一指纹第二次提交被拦住（不发第二条消息，刷新后仍是已提交）
 *        · 模型文本只进 textContent：<img onerror> 不执行、不生成元素
 *        · 节点上限 200 截断而不报错
 *
 * 本机没有 Chrome 时浏览器那一节 SKIP（不算失败），源码层照常断言 —— 与
 * check-mobile.mjs / check-home.mjs 同一约定。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDevToolsPort } from './devtools-port.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
const DEMO = join(ROOT, 'docs', 'demo.html')
const HINT = 'dsh-ui 围栏解析失败，按代码块显示'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0, failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}
function section(title) { console.log('\n' + title) }

// ── 1. 源码层 ───────────────────────────────────────────────────────────────
const page = readFileSync(PAGE, 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// 只取 v1.8.25 新增的那一段（从 GENUI_TYPES 到折叠按钮之前），别把整页的
// 「文件内常量 innerHTML」也算进来 —— 铁律针对的是**模型文本**进 HTML。
const genuiStart = page.indexOf('var GENUI_TYPES =')
const genuiEnd = page.indexOf('/** 折叠按钮：默认收起', genuiStart)
const genuiSrc = genuiStart >= 0 && genuiEnd > genuiStart ? page.slice(genuiStart, genuiEnd) : ''

section('源码层：围栏分支与协议模板')
check('页面里有 dsh-ui 围栏实现（GENUI_TYPES + 卡片构建）',
  genuiSrc.length > 2000 && /function genuiFenceNode/.test(genuiSrc) && /function genuiBuildCard/.test(genuiSrc),
  '长度 ' + genuiSrc.length)
check('bubNode：dsh-ui 走新分支，其它语言仍进 codeNode',
  /if \(genuiIsLang\(lang\)\) \{/.test(page) &&
  /var card = genuiFenceNode\(lang, bare\)/.test(page) &&
  /b\.appendChild\(card\)/.test(page) &&
  /else b\.appendChild\(codeNode\(lang, bare, !!o\.foldCode\)\)/.test(page))
check('语言标记容错写在实现里（trim / 小写 / 尾部 > 与冒号）',
  /replace\(\/\[>:\\s：\]\+\$\/, ''\)/.test(genuiSrc) &&
  /toLowerCase\(\) === 'dsh-ui'/.test(genuiSrc))
check('回退提示逐字为「' + HINT + '」', genuiSrc.includes("'" + HINT + "'"))
check('「手机端不支持」与「解析失败」是两套措辞（v1.8.26）',
  /function genuiUnsupportedText\(nodes\)/.test(genuiSrc) &&
  genuiSrc.includes("'手机端不支持 ' + seen.join('、') + ' 这类组件，按原文显示'") &&
  /return genuiFallbackNode\(lang, raw, genuiUnsupportedText\(parsed\.nodes\)\)/.test(genuiSrc) &&
  /note\.textContent = hint \|\| GENUI_BAD_HINT/.test(genuiSrc))
check('部分节点被丢弃时卡片底部如实说明（.gu-skip）',
  /function genuiDroppedText\(dropped\)/.test(genuiSrc) &&
  genuiSrc.includes("'已隐藏 ' + n + ' 个手机端不支持的组件：'") &&
  /skip\.className = 'gu-skip'/.test(genuiSrc) &&
  /\.gu-skip\{margin-top:var\(--sp-2\)/.test(page))
check('「回到最新」浮层遇到表单控件会让位（不抢提交按钮的点击）',
  /function pillClear\(\)/.test(page) &&
  /#tobottom\.gu-clear\{opacity:0;pointer-events:none\}/.test(page) &&
  /q\.right > r\.left && q\.left < r\.right && q\.bottom > r\.top && q\.top < r\.bottom/.test(page) &&
  /pillClear\(\)\n\}/.test(page))
check('间距 token 补齐到 4/8 栅格阶梯（4…64）',
  ['--sp-1:4px', '--sp-2:8px', '--sp-3:12px', '--sp-4:16px', '--sp-5:24px', '--sp-6:32px', '--sp-7:48px', '--sp-8:64px']
    .every((t) => page.includes(t)))

check('回传协议模板与 dsh-genui 的 action.inline 逐字一致',
  genuiSrc.includes("'[genui-action] ' + action + '.'") &&
  genuiSrc.includes("' The user just triggered this action \"' + action + '\" in the interface.'") &&
  genuiSrc.includes("' Carry it out using the component data, then reply with an updated dsh-ui fence.'") &&
  genuiSrc.includes("' Component data: ' + JSON.stringify(data)"))
check('payload 的四个键固定为 answers / fields / total / answered',
  /return \{ answers:answers, fields:fields, total:total, answered:answered \}/.test(genuiSrc))
check('去重键与会话 id 绑定（taskwatch.genuiSent，最多 200 条）',
  /'taskwatch\.genuiSent'/.test(genuiSrc) && /GENUI_SENT_MAX = 200/.test(genuiSrc) &&
  /String\(S\.sessionId \|\| ''\) \+ ':' \+ fp/.test(genuiSrc))
check('新增代码里没有 innerHTML / eval / new Function',
  !/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(genuiSrc) &&
  !/\beval\s*\(|new Function/.test(genuiSrc))
check('模型文本只走 textContent / setAttribute',
  (genuiSrc.match(/\.textContent\s*=/g) || []).length >= 8 && /setAttribute\('placeholder', ph\)/.test(genuiSrc))
check('dependencies 仍为空（零依赖单文件）',
  !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
  JSON.stringify(pkg.dependencies || {}))

check('演示页里带了一条 dsh-ui 确认表单围栏',
  /```dsh-ui/.test(readFileSync(join(ROOT, 'scripts', 'make-demo.mjs'), 'utf8')))

// ── 2. 真浏览器 ─────────────────────────────────────────────────────────────
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
  console.log('\nSKIP 浏览器层：本机没有 Chrome（设置 CHROME_PATH 后可跑）')
  console.log(`\n${passed} 通过 / ${failed} 失败`)
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
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
    })
  }
  close() { try { this.ws.close() } catch (e) { /* 已关 */ } }
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

  profile = mkdtempSync(join(tmpdir(), 'tw-genui-chrome-'))
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
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await cdp.send('Page.navigate', { url })
  await sleep(1800)

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result && r.result.value
  }

  section('浏览器层：渲染分支（390×844 DPR2，docs/demo.html）')
  // 进会话页 + 打桩记录真正发出的 /taskwatch/chat/send 请求。
  await evalJs(`(async function(){
    showSession('session-demo-a')
    try { localStorage.removeItem('taskwatch.genuiSent') } catch (e) {}
    window.__sent = []
    var base = window.fetch
    window.fetch = function(u, o){
      try {
        if (String(u).indexOf('/taskwatch/chat/send') >= 0 && o && o.body) window.__sent.push(JSON.parse(o.body))
      } catch (e) {}
      return base.apply(window, arguments)
    }
    window.__xss = 0
    // 往对话里插一条真气泡（走页面自己的 bubNode，不是测试专用渲染器）。
    window.__gu = function(text){
      var host = document.createElement('div')
      host.className = 'row ai'
      host.appendChild(bubNode(text, { noFold: true }))
      document.getElementById('log').appendChild(host)
      host.scrollIntoView({ block: 'center' })
      return host
    }
    return true
  })()`)

  const cases = [
    ['```dsh-ui', '标准语言标记'],
    ['```dsh-ui>', '尾部大于号'],
    ['```DSH-UI', '大写'],
    ['```  dsh-ui  ', '首尾空白'],
    ['```dsh-ui:', '尾部冒号'],
  ]
  for (const [mark, label] of cases) {
    const r = await evalJs(`(function(){
      var host = __gu(${JSON.stringify(mark + '\n{"items":[{"type":"text","content":"能渲染"}]}\n```')})
      return { gu: !!host.querySelector('.gu'), code: !!host.querySelector('.code'), text: host.querySelector('.gu-text') ? host.querySelector('.gu-text').textContent : '' }
    })()`)
    check(`dsh-ui 围栏走卡片渲染（${label}）`, r.gu && !r.code && r.text === '能渲染', JSON.stringify(r))
  }

  const plain = await evalJs(`(function(){
    var host = __gu('先看一段代码：\\n\\n\`\`\`js\\nvar a = 1\\n\`\`\`\\n\\n再往下说。')
    return { gu: !!host.querySelector('.gu'), code: !!host.querySelector('.code'), lang: host.querySelector('.codebar .lang') ? host.querySelector('.codebar .lang').textContent : '' }
  })()`)
  check('普通围栏（```js）仍进 codeNode，不被当成 dsh-ui',
    !plain.gu && plain.code && plain.lang === 'js', JSON.stringify(plain))

  section('浏览器层：解析失败与非对象回退')
  const badCases = [
    ['{"items":[{"type":"text","content":"坏了"', '坏 JSON'],
    ['"just a string"', '顶层是字符串'],
    ['123', '顶层是数字'],
    ['{"title":"没有 items","gap":12}', '对象但没有可渲染节点'],
  ]
  for (const [body, label] of badCases) {
    const r = await evalJs(`(function(){
      try {
        var host = __gu(${JSON.stringify('```dsh-ui\n' + body + '\n```')})
        return {
          threw:false,
          fallback: !!host.querySelector('.gu-fallback'),
          code: !!host.querySelector('.code'),
          cards: host.querySelectorAll('.gu').length,
          note: host.querySelector('.gu-note') ? host.querySelector('.gu-note').textContent : '',
          first: host.querySelector('.gu-fallback') ? host.querySelector('.gu-fallback').firstElementChild.className : '',
        }
      } catch (e) { return { threw:true, error:String(e && e.message) } }
    })()`)
    check(`坏围栏回退成代码块 + 提示（${label}）`,
      !r.threw && r.fallback && r.code && r.cards === 0 && r.note === HINT && r.first === 'gu-note',
      JSON.stringify(r))
  }

  // v1.8.26：语法合法、只是手机端没有这些组件 → 措辞必须与「解析失败」分开。
  const unsupportedCases = [
    ['{"title":"只有图表","items":[{"type":"chart","data":[]},{"type":"3d","meshes":[]}]}', '只有不支持的类型'],
    ['{"items":[{"type":"table","columns":["a"],"rows":[["1"]]}]}', '只有 table'],
    ['{"items":[{"type":"quiz","question":"判卷不做"}]}', '只有 quiz'],
  ]
  for (const [body, label] of unsupportedCases) {
    const r = await evalJs(`(function(){
      try {
        var host = __gu(${JSON.stringify('```dsh-ui\n' + body + '\n```')})
        var note = host.querySelector('.gu-note')
        return {
          threw:false,
          fallback: !!host.querySelector('.gu-fallback'),
          code: !!host.querySelector('.code'),
          note: note ? note.textContent : '',
          saysParse: note ? /解析失败/.test(note.textContent) : false,
        }
      } catch (e) { return { threw:true, error:String(e && e.message) } }
    })()`)
    check(`合法 JSON 但不支持 → 不说「解析失败」（${label}）`,
      !r.threw && r.fallback && r.code && /^手机端不支持 /.test(r.note) && r.saysParse === false,
      JSON.stringify(r))
  }

  section('浏览器层：未知类型丢弃、同围栏其它节点照常')
  const mixed = await evalJs(`(function(){
    var host = __gu(${JSON.stringify('```dsh-ui\n' + JSON.stringify({
      title: '混合围栏',
      items: [
        { type: 'chart', kind: 'bars', data: [{ label: 'A', value: 1 }] },
        { type: 'mermaid', code: 'graph TD\\nA-->B' },
        { type: 'table', columns: ['a'], rows: [['1']] },
        { type: 'text', content: '这段应该保留' },
        { type: 'quiz', question: '判卷不做' },
        { type: 'submit', label: '确认', action: 'confirm-mixed' },
      ],
    }) + '\n```')})
    var card = host.querySelector('.gu')
    return {
      card: !!card,
      text: card ? card.querySelector('.gu-text').textContent : '',
      button: card && card.querySelector('.gu-btn') ? card.querySelector('.gu-btn').textContent : '',
      nodes: card ? card.querySelector('.gu-body').children.length : 0,
      chart: host.querySelectorAll('canvas,svg.mermaid,table').length,
      title: card && card.querySelector('.gu-title') ? card.querySelector('.gu-title').textContent : '',
      skip: card && card.querySelector('.gu-skip') ? card.querySelector('.gu-skip').textContent : '',
    }
  })()`)
  check('未知 type 被静默丢弃，同围栏 text / submit 仍渲染',
    mixed.card && mixed.text === '这段应该保留' && mixed.button === '确认' &&
    mixed.nodes === 2 && mixed.chart === 0 && mixed.title === '混合围栏',
    JSON.stringify(mixed))
  // v1.8.26：丢弃不再是「静默」——底部如实说一句，用户才知道少了东西。
  check('被丢弃的类型在卡片底部如实列出（4 个：chart/mermaid/table/quiz）',
    mixed.skip === '已隐藏 4 个手机端不支持的组件：chart、mermaid、table 等',
    JSON.stringify(mixed.skip))

  section('浏览器层：radio.group + submit.groups 的禁用 / 进度')
  const FENCE = '```dsh-ui\n' + JSON.stringify({
    title: '执行前确认',
    items: [
      { type: 'text', content: '请确认下面的选项' },
      { type: 'radio', label: '什么时候执行？', group: 'when', options: ['现在就执行', '下班后'] },
      { type: 'input', id: 'window', label: '执行窗口', placeholder: '例如 今天 18:00' },
      { type: 'textarea', id: 'note', label: '备注', rows: 3 },
      { type: 'submit', label: '确认并发送', action: 'confirm-cleanup', groups: ['when', 'window'] },
    ],
  }, null, 0) + '\n```'
  const gate = await evalJs(`(function(){
    var host = __gu(${JSON.stringify(FENCE)})
    var card = host.querySelector('.gu')
    return {
      disabled: card.querySelector('.gu-btn').disabled,
      progress: card.querySelector('.gu-progress').textContent,
      opts: card.querySelectorAll('.gu-opt').length,
      sent: window.__sent.length,
    }
  })()`)
  check('没选时 submit 禁用，进度显示「已填 0/2」',
    gate.disabled === true && gate.progress === '已填 0/2' && gate.opts === 2 && gate.sent === 0,
    JSON.stringify(gate))

  const picked = await evalJs(`(function(){
    var card = document.querySelectorAll('.gu')[document.querySelectorAll('.gu').length - 1]
    var inputs = card.querySelectorAll('.gu-opt input')
    inputs[0].checked = true
    inputs[0].dispatchEvent(new Event('change', { bubbles:true }))
    var mid = { disabled: card.querySelector('.gu-btn').disabled, progress: card.querySelector('.gu-progress').textContent, sent: window.__sent.length }
    var field = card.querySelector('.gu-input')
    field.value = '今天 18:00'
    field.dispatchEvent(new Event('input', { bubbles:true }))
    var done = { disabled: card.querySelector('.gu-btn').disabled, progress: card.querySelector('.gu-progress').textContent, sent: window.__sent.length, on: card.querySelectorAll('.gu-opt.on').length }
    return { mid: mid, done: done }
  })()`)
  check('有 group 的 radio 只本地记录、不发往返',
    picked.mid.sent === 0 && picked.mid.progress === '已填 1/2', JSON.stringify(picked.mid))
  check('填完 groups 全部成员后 submit 可提交（进度 2/2）',
    picked.done.disabled === false && picked.done.progress === '已填 2/2' && picked.done.on === 1,
    JSON.stringify(picked.done))

  section('浏览器层：回传协议逐字匹配 + 去重')
  await evalJs(`(function(){
    var card = document.querySelectorAll('.gu')[document.querySelectorAll('.gu').length - 1]
    card.querySelector('.gu-btn').click()
    return true
  })()`)
  await sleep(400)
  const first = await evalJs(`(function(){
    var card = document.querySelectorAll('.gu')[document.querySelectorAll('.gu').length - 1]
    return {
      sent: window.__sent.length,
      text: window.__sent[0] ? window.__sent[0].text : '',
      isDone: card.classList.contains('is-done'),
      button: card.querySelector('.gu-btn').textContent,
      progress: card.querySelector('.gu-progress').textContent,
      disabled: card.querySelector('.gu-btn').disabled,
      store: (function(){ try { return JSON.parse(localStorage.getItem('taskwatch.genuiSent') || '[]') } catch (e) { return [] } })(),
    }
  })()`)
  const expectedData = {
    answers: { when: '现在就执行' },
    fields: { window: '今天 18:00' },
    total: 2,
    answered: 2,
  }
  const expectedText =
    '[genui-action] confirm-cleanup.' +
    ' The user just triggered this action "confirm-cleanup" in the interface.' +
    ' Carry it out using the component data, then reply with an updated dsh-ui fence.' +
    ' Component data: ' + JSON.stringify(expectedData)
  check('提交消息逐字匹配 [genui-action] 模板', first.text === expectedText,
    '\n    期望：' + expectedText + '\n    实际：' + first.text)
  check('消息 JSON 的四个键就是 answers / fields / total / answered',
    (function () {
      try {
        const raw = first.text.slice(first.text.indexOf('Component data: ') + 'Component data: '.length)
        const data = JSON.parse(raw)
        return JSON.stringify(Object.keys(data)) === JSON.stringify(['answers', 'fields', 'total', 'answered']) &&
          data.total === 2 && data.answered === 2 && data.answers.when === '现在就执行' &&
          data.fields.window === '今天 18:00' && data.fields.note === undefined
      } catch (e) { return false }
    })(), first.text)
  check('提交后卡片置灰、按钮禁用并显示「已提交」（进度行不再重复）',
    first.isDone && first.disabled && first.button === '已提交' && first.progress === '',
    JSON.stringify({ isDone: first.isDone, disabled: first.disabled, button: first.button }))
  check('指纹写进 localStorage（会话 id + 正文指纹）',
    first.store.length === 1 && /^session-demo-a:/.test(first.store[0]), JSON.stringify(first.store))

  const again = await evalJs(`(function(){
    var card = document.querySelectorAll('.gu')[document.querySelectorAll('.gu').length - 1]
    card.querySelector('.gu-btn').click()
    return true
  })()`)
  await sleep(300)
  const afterSecond = await evalJs(`(function(){ return { sent: window.__sent.length } })()`)
  check('同一张卡再点一次不发第二条消息', afterSecond.sent === 1, JSON.stringify(afterSecond))

  // 「刷新后仍是已提交」：重新渲染同一段围栏（等于 host 重放历史消息），
  // localStorage 里的指纹必须让新卡片一出生就是置灰态，且点不动。
  const replayed = await evalJs(`(function(){
    var host = __gu(${JSON.stringify(FENCE)})
    var card = host.querySelector('.gu')
    var before = window.__sent.length
    card.querySelector('.gu-btn').click()
    return {
      isDone: card.classList.contains('is-done'),
      button: card.querySelector('.gu-btn').textContent,
      disabled: card.querySelector('.gu-btn').disabled,
      sentBefore: before,
      sentAfter: window.__sent.length,
    }
  })()`)
  check('同一指纹第二次渲染直接是「已提交」，点了也不发',
    replayed.isDone && replayed.button === '已提交' && replayed.disabled === true &&
    replayed.sentAfter === replayed.sentBefore,
    JSON.stringify(replayed))

  section('浏览器层：安全（模型文本不进 HTML）')
  const xss = await evalJs(`(function(){
    var payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2<\\/script>'
    var body = JSON.stringify({
      items: [
        { type: 'text', content: payload },
        { type: 'input', id: 'evil', label: payload, placeholder: payload },
        { type: 'radio', group: 'ev', options: [payload] },
      ],
    })
    var host = __gu('\\u0060\\u0060\\u0060dsh-ui\\n' + body + '\\n\\u0060\\u0060\\u0060')
    var card = host.querySelector('.gu')
    return {
      xss: window.__xss,
      imgs: card.querySelectorAll('img').length,
      scripts: card.querySelectorAll('script').length,
      text: card.querySelector('.gu-text').textContent,
      placeholder: card.querySelector('.gu-input').getAttribute('placeholder'),
      label: card.querySelector('.gu-label').textContent,
      option: card.querySelector('.gu-opt span').textContent,
    }
  })()`)
  check('模型文本只写 textContent / 属性不解析：无元素生成、onerror 不执行',
    xss.xss === 0 && xss.imgs === 0 && xss.scripts === 0 &&
    xss.text.includes('<img src=x onerror=') &&
    xss.placeholder.includes('<img src=x onerror=') &&
    xss.label.includes('<img src=x onerror=') &&
    xss.option.includes('<img src=x onerror='),
    JSON.stringify({ xss: xss.xss, imgs: xss.imgs, scripts: xss.scripts }))

  section('浏览器层：长回复的折叠策略')
  const fold = await evalJs(`(function(){
    var long = new Array(40).join('这是一段很长的说明文字，用来把消息长度推过折叠阈值。')
    window.__guFold = function(text){
      var host = document.createElement('div')
      host.className = 'row ai'
      host.appendChild(bubNode(text))
      document.getElementById('log').appendChild(host)
      return host
    }
    var withForm = __guFold(long + '\\n\\n' + ${JSON.stringify(FENCE)} + '\\n\\n' + long)
    var withCode = __guFold(long + '\\n\\n\\u0060\\u0060\\u0060js\\nvar a = 1\\n\\u0060\\u0060\\u0060\\n\\n' + long)
    return {
      formFold: withForm.querySelector('.bub').classList.contains('fold'),
      formCard: !!withForm.querySelector('.gu'),
      formFoldBtn: !!withForm.querySelector('.foldbtn'),
      codeFold: withCode.querySelector('.bub').classList.contains('fold'),
    }
  })()`)
  check('含确认表单的长回复不折叠（卡片不会被 22rem 裁半），普通长回复仍折叠',
    fold.formCard && fold.formFold === false && fold.formFoldBtn === false && fold.codeFold === true,
    JSON.stringify(fold))

  section('浏览器层：节点上限')
  const capped = await evalJs(`(function(){
    try {
      var items = []
      for (var i = 0; i < 260; i++) items.push({ type: 'text', content: 'n' + i })
      var host = __gu('\\u0060\\u0060\\u0060dsh-ui\\n' + JSON.stringify({ items: items }) + '\\n\\u0060\\u0060\\u0060')
      return { threw: false, nodes: host.querySelectorAll('.gu-text').length }
    } catch (e) { return { threw: true, error: String(e && e.message) } }
  })()`)
  check('260 个节点截断到 200 且不报错', !capped.threw && capped.nodes === 200, JSON.stringify(capped))

  const overflow = await evalJs(`(function(){
    var log = document.getElementById('log')
    var before = { iw: innerWidth, doc: document.documentElement.scrollWidth, log: log.scrollWidth }
    log.scrollLeft = 0
    var host = document.querySelectorAll('.row.ai')[document.querySelectorAll('.row.ai').length - 1]
    var card = host.querySelector('.gu') || host.querySelector('.gu-fallback')
    var r = card.getBoundingClientRect()
    return { iw: before.iw, doc: document.documentElement.scrollWidth, log: before.log, cardLeft: r.left, cardRight: r.right }
  })()`)
  check('卡片不把页面撑宽（390 宽下右缘不越界）',
    overflow.doc <= overflow.iw + 1 && overflow.log <= overflow.iw + 1 &&
    overflow.cardRight <= overflow.iw + 1,
    JSON.stringify(overflow))

  cdp.close()
  browser.close()
} finally {
  if (server) server.close()
  if (child && child.exitCode === null) child.kill()
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch (e) { /* Windows 偶发占用 */ } }
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
