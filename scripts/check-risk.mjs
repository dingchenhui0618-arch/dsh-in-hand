#!/usr/bin/env node
/**
 * 高危动作二次确认（P4 收尾，v1.8.8）的自检。
 *
 * 这一版要证明的不是"页面上有个红色徽标"，而是**判定在宿主、页面只照做**：
 *
 *   1. assessRisk 对 8 条默认高危样例命中、6 条普通样例不命中，且每条默认
 *      模式（含路径类的"作为被操作对象"边界）都至少有一次正向断言；
 *   2. highRiskPatterns 可增删（加一条 docker rm 即生效）；
 *   3. 越界配置（65 条 / 121 字符）被裁剪，并在启动时 warn；
 *   4. riskConfirm:false 时页面只显示徽标、点击直接 POST；
 *   5. 高危卡片点「批准一次」→ 确认层出现，**CDP 网络日志里没有** approve；
 *      点「确认执行」→ 才发；
 *   6. 取消 / Esc / 点遮罩都只收层、不发请求，卡片回到可操作态；
 *   7. 审批审计那一行带 risk:'high'|'normal'，字段名不变。
 *
 * 页面那一节用真 Chrome + CDP（本机没有 Chrome 就 SKIP，与其它检查一致）；
 * 不联网、不碰真实 ~/.dsh，审计写到临时 DSH_HOME。
 */
import http from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDevToolsPort } from './devtools-port.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
const SW = join(ROOT, 'lib', 'sw.js')

process.env.TASKWATCH_TICKET_SECRET = 'check-risk-' + 'k'.repeat(40)
const AUDIT_HOME = mkdtempSync(join(tmpdir(), 'tw-risk-audit-'))
process.env.DSH_HOME = AUDIT_HOME

const {
  apply,
  assessRisk,
  resolveApprovalConfig,
  APPROVAL_CONFIG_SCHEMA,
  DEFAULT_HIGH_RISK_PATTERNS,
  HIGH_RISK_PATTERN_MAX_ITEMS,
  HIGH_RISK_PATTERN_MAX_LENGTH,
  createApprovalGate,
  createAuditLog,
} = await import('../lib/index.js')

let passed = 0
let failed = 0
let skipped = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}
function skip(name, why) {
  skipped++
  console.log('  SKIP  ' + name + (why ? ' — ' + why : ''))
}
function section(title) { console.log('\n' + title) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ═════════════════════════════════════════════════════════════════════════
// 1. assessRisk：8 条高危样例 / 6 条普通样例
// ═════════════════════════════════════════════════════════════════════════
section('[1] assessRisk：默认模式')

const HIGH_SAMPLES = [
  { name: 'rm -rf', input: { toolName: 'pwsh', reason: 'rm -rf node_modules' } },
  { name: 'Remove-Item', input: { toolName: 'pwsh', reason: 'Remove-Item -Recurse -Force dist' } },
  { name: 'del /f', input: { toolName: 'pwsh', reason: 'del /f C:\\temp\\a.txt' } },
  { name: 'format', input: { toolName: 'pwsh', reason: 'format D: /q' } },
  { name: 'mkfs', input: { toolName: 'bash', reason: 'mkfs.ext4 /dev/sdb1' } },
  { name: 'shutdown', input: { toolName: 'pwsh', reason: 'shutdown /s /t 0' } },
  { name: 'DROP TABLE', input: { toolName: 'sql', reason: 'DROP TABLE sessions' } },
  { name: 'git push --force', input: { toolName: 'pwsh', reason: 'git push --force origin main' } },
]
for (const sample of HIGH_SAMPLES) {
  check('高危样例命中：' + sample.name, assessRisk(sample.input) === 'high', JSON.stringify(sample.input))
}

const NORMAL_SAMPLES = [
  { name: '列目录', input: { toolName: 'pwsh', reason: '列出当前目录下的文件' } },
  { name: 'npm test', input: { toolName: 'npm', reason: 'npm test -- --watch=false' } },
  { name: 'git status', input: { toolName: 'git', reason: 'git status --short' } },
  { name: '读 README', input: { toolName: 'read', reason: '读取 README.md 的前 40 行' } },
  { name: '改文案', input: { toolName: 'edit', reason: '改一处文案：把「保存」改成「保存并关闭」' } },
  // 路径类必须"作为被操作对象"才命中：.gitignore 不能被当成 .git。
  { name: '.gitignore 不是 .git', input: { toolName: 'pwsh', reason: '查看 .gitignore 里忽略了哪些文件' } },
]
for (const sample of NORMAL_SAMPLES) {
  check('普通样例不命中：' + sample.name, assessRisk(sample.input) === 'normal', JSON.stringify(sample.input))
}

// 每条默认模式都至少有一次正向断言（否则"默认 19 条"只是注释）。
const PATTERN_SAMPLES = {
  'rm -rf': 'rm -rf build',
  'Remove-Item': 'Remove-Item -LiteralPath x',
  'del /f': 'del /f a.txt',
  format: 'format C: /fs:ntfs',
  mkfs: 'mkfs -t ext4 /dev/sdc',
  shutdown: 'shutdown -h now',
  'Stop-Process': 'Stop-Process -Id 4242 -Force',
  'taskkill /F': 'taskkill /F /IM node.exe',
  'DROP TABLE': 'drop table orders',
  TRUNCATE: 'truncate table orders',
  'git push --force': 'git push --force origin main',
  'npm publish': 'npm publish --access public',
  'git tag -d': 'git tag -d v1.8.7',
  'git reset --hard': 'git reset --hard HEAD~1',
  '.ssh': '写入 ~/.ssh/authorized_keys',
  '.dsh': '清理 .dsh/attachments 下的旧文件',
  'C:\\Windows': '修改 C:\\Windows\\System32\\drivers\\etc\\hosts',
  '/etc': '把配置写到 /etc/nginx/nginx.conf',
  '.git': '删除 .git 目录后重新初始化',
}
for (const [pattern, reason] of Object.entries(PATTERN_SAMPLES)) {
  check('默认模式可命中：' + pattern, assessRisk({ toolName: 'pwsh', reason }) === 'high', reason)
}

// toolName 与 detail（displayReason）也参与匹配，不只是 reason。
check('toolName 参与匹配', assessRisk({ toolName: 'Remove-Item', reason: '清理缓存' }) === 'high')
check('detail（displayReason）参与匹配',
  assessRisk({ toolName: 'pwsh', reason: '', detail: '即将运行 npm publish' }) === 'high')
check('空输入按 normal 处理', assessRisk({}) === 'normal' && assessRisk({ reason: '' }) === 'normal')
check('大小写不敏感', assessRisk({ toolName: 'pwsh', reason: 'RM -RF dist' }) === 'high')
check('反斜杠与斜杠等价（C:\\Windows / C:/Windows）',
  assessRisk({ toolName: 'pwsh', reason: '写入 C:/Windows/Temp/x' }) === 'high')
check('.gitignore / .sshrc 这类前缀不误伤',
  assessRisk({ toolName: 'pwsh', reason: '读取 .gitignore 与 .sshrc' }) === 'normal')

// ═════════════════════════════════════════════════════════════════════════
// 2. 自定义模式：加一条 docker rm 即生效
// ═════════════════════════════════════════════════════════════════════════
section('[2] highRiskPatterns 可增删')

const custom = resolveApprovalConfig({ highRiskPatterns: DEFAULT_HIGH_RISK_PATTERNS.concat('docker rm') }, () => {})
check('自定义后默认模式仍在',
  assessRisk({ toolName: 'pwsh', reason: 'rm -rf build' }, custom.highRiskPatterns) === 'high')
check('新增 docker rm 生效',
  assessRisk({ toolName: 'pwsh', reason: 'docker rm -f api' }, custom.highRiskPatterns) === 'high')
check('未增删前 docker rm 不算高危',
  assessRisk({ toolName: 'pwsh', reason: 'docker rm -f api' }) === 'normal')
const onlyCustom = resolveApprovalConfig({ highRiskPatterns: ['docker rm'] }, () => {})
check('只给一条时默认模式被替换（可删）',
  assessRisk({ toolName: 'pwsh', reason: 'rm -rf build' }, onlyCustom.highRiskPatterns) === 'normal' &&
  assessRisk({ toolName: 'pwsh', reason: 'docker rm -f api' }, onlyCustom.highRiskPatterns) === 'high')
const empty = resolveApprovalConfig({ highRiskPatterns: [] }, (msg) => { throw new Error('空数组不应 warn：' + msg) })
check('highRiskPatterns:[] 合法且关闭全部模式', empty.highRiskPatterns.length === 0 &&
  assessRisk({ toolName: 'pwsh', reason: 'rm -rf build' }, empty.highRiskPatterns) === 'normal')

// ═════════════════════════════════════════════════════════════════════════
// 3. 越界配置：65 条 → 64，121 字符 → 120，都要 warn
// ═════════════════════════════════════════════════════════════════════════
section('[3] 越界配置裁剪 + 启动 warn')

const warnings = []
const many = []
for (let i = 0; i < HIGH_RISK_PATTERN_MAX_ITEMS + 1; i++) many.push('pattern-' + i)
const long = 'x'.repeat(HIGH_RISK_PATTERN_MAX_LENGTH + 1)
const bounded = resolveApprovalConfig({
  highRiskPatterns: [long, 123, '  '].concat(many),
}, (msg) => warnings.push(msg))
check('65+ 条被裁到 64', bounded.highRiskPatterns.length === HIGH_RISK_PATTERN_MAX_ITEMS,
  String(bounded.highRiskPatterns.length))
check('越界后只保留前 64 条',
  bounded.highRiskPatterns.includes('pattern-62') && !bounded.highRiskPatterns.includes('pattern-63'))
const trimmed = bounded.highRiskPatterns.find((p) => p.startsWith('xxx'))
check('121 字符被截到 120', trimmed && trimmed.length === HIGH_RISK_PATTERN_MAX_LENGTH,
  trimmed ? String(trimmed.length) : 'missing')
check('非字符串 / 空白项被忽略', !bounded.highRiskPatterns.some((p) => p === '' || typeof p !== 'string'))
check('裁剪与截断都 warn', warnings.length >= 2, JSON.stringify(warnings))
check('warn 文案说清条数与字符上限',
  warnings.some((w) => w.includes(String(HIGH_RISK_PATTERN_MAX_ITEMS)))
    && warnings.some((w) => w.includes(String(HIGH_RISK_PATTERN_MAX_LENGTH))), JSON.stringify(warnings))
const defaultWarn = []
const defaults = resolveApprovalConfig({}, (msg) => defaultWarn.push(msg))
check('默认配置不 warn 且 19 条默认模式',
  defaultWarn.length === 0 && defaults.highRiskPatterns.length === DEFAULT_HIGH_RISK_PATTERNS.length,
  JSON.stringify({ warn: defaultWarn.length, n: defaults.highRiskPatterns.length }))
check('riskConfirm 默认 true，false 可关', defaults.riskConfirm === true &&
  resolveApprovalConfig({ riskConfirm: false }).riskConfirm === false)
check('配置 schema 声明了 highRiskPatterns / riskConfirm',
  APPROVAL_CONFIG_SCHEMA.highRiskPatterns.type === 'array' &&
  APPROVAL_CONFIG_SCHEMA.highRiskPatterns.maxItems === HIGH_RISK_PATTERN_MAX_ITEMS &&
  APPROVAL_CONFIG_SCHEMA.riskConfirm.default === true)

// ═════════════════════════════════════════════════════════════════════════
// 7. 审计：审批决定行带 risk，字段名不变
// ═════════════════════════════════════════════════════════════════════════
section('[7] 审计与宿主下发字段')

const routes = new Map()
const webServer = { register(spec) { routes.set(spec.path, spec.handler); return () => {} } }
const services = { webServer }
const ctx = {
  get(name) { return services[name] },
  effect(fn) { return fn() },
  on() { return () => {} },
}
apply(ctx, { approveFromPhone: true, approvalTimeoutMs: 5000 })

async function serve(routesMap) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    const handler = routesMap.get(path)
    if (!handler) { res.writeHead(404); res.end('not found'); return }
    Promise.resolve(handler(req, res)).catch((error) => {
      try { res.writeHead(500); res.end(String(error)) } catch { /* 已断开 */ }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: 'http://127.0.0.1:' + server.address().port }
}
const { server, base } = await serve(routes)
try {
  const data = await (await fetch(base + '/taskwatch/data?view=phone')).json()
  check('宿主下发给页面 riskConfirm', data.riskConfirm === true, String(data.riskConfirm))
  check('快照不下发 highRiskPatterns（判定留在宿主）',
    !('highRiskPatterns' in data) && !JSON.stringify(data).includes('rm -rf build'))

  let nextCalls = 0
  // 直接用 gate 做等价断言（与 apply 里注册的是同一个函数），再单独验证
  // 快照字段与审计落盘 —— 不在这里复刻一条 HTTP 审批链，避免测试自成一套。
  const audits = []
  const pending = new Map()
  const gate = createApprovalGate({
    approveFromPhone: true,
    timeoutMs: 5000,
    isPhoneOnline: () => true,
    audit: (entry) => audits.push(entry),
    onPending: (key, entry) => pending.set(key, entry),
    onRelease: (key) => pending.delete(key),
  })
  const highRun = gate.handle(
    { agent: { id: 's-high' }, toolName: 'pwsh', callId: 'call-high', reason: 'rm -rf build' },
    async () => { nextCalls++; return 'unavailable' },
  )
  let highEntry = null
  for (let i = 0; i < 100 && !highEntry; i++) {
    for (const entry of pending.values()) if (entry.canDecide) highEntry = entry
    if (!highEntry) await sleep(10)
  }
  check('宿主侧 pending 项带 risk:high', !!highEntry && highEntry.risk === 'high',
    JSON.stringify(highEntry))
  const allow = gate.decide(highEntry.id, 'allow')
  check('高危审批仍可放行（门槛不是新权限）', allow.status === 200 &&
    allow.body.outcome === 'allowed-once', JSON.stringify(allow.body))
  check('waterfall 没有交给 next()', (await highRun) === 'allowed-once' && nextCalls === 0)
  check('审计决定行带 risk:high 且字段名不变',
    audits.length === 1 && audits[0].risk === 'high' &&
    audits[0].outcome === 'allowed-once' && audits[0].by === 'phone' &&
    !('command' in audits[0]) && !('stdout' in audits[0]), JSON.stringify(audits[0]))

  const normalRun = gate.handle(
    { agent: { id: 's-normal' }, toolName: 'edit', callId: 'call-normal', reason: '改一处文案' },
    async () => 'unavailable',
  )
  let normalEntry = null
  for (let i = 0; i < 100 && !normalEntry; i++) {
    for (const entry of pending.values()) if (entry.canDecide) normalEntry = entry
    if (!normalEntry) await sleep(10)
  }
  check('普通 pending 项 risk:normal', !!normalEntry && normalEntry.risk === 'normal',
    JSON.stringify(normalEntry))
  gate.decide(normalEntry.id, 'reject')
  await normalRun
  const normalAudit = audits.find((e) => e.session === 's-normal')
  check('普通决定审计 risk:normal', !!normalAudit && normalAudit.risk === 'normal' &&
    normalAudit.outcome === 'rejected', JSON.stringify(normalAudit))

  // displayReason 也参与判定：英文说明里的 npm publish 不能被漏掉。
  const displayRun = gate.handle(
    {
      agent: { id: 's-display' },
      toolName: 'pwsh',
      callId: 'call-display',
      reason: '',
      displayReason: { en: 'Publish the package: npm publish --access public' },
    },
    async () => 'unavailable',
  )
  let displayEntry = null
  for (let i = 0; i < 100 && !displayEntry; i++) {
    for (const entry of pending.values()) if (entry.canDecide && entry.session === 's-display') displayEntry = entry
    if (!displayEntry) await sleep(10)
  }
  check('displayReason 命中高危', !!displayEntry && displayEntry.risk === 'high',
    JSON.stringify(displayEntry))
  gate.decide(displayEntry.id, 'reject')
  await displayRun
} finally {
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 旧 Node */ }
  await new Promise((resolve) => server.close(resolve))
}

const auditPath = join(AUDIT_HOME, 'taskwatch-audit.log')
// 上面那组用注入的 audit 回调；这里再落一次真实文件，证明写盘那一行也带 risk。
try {
  const log = createAuditLog({ file: auditPath })
  log.write({
    at: new Date().toISOString(), session: 's', toolName: 'pwsh',
    outcome: 'allowed-once', by: 'phone', risk: 'high', reason: 'rm -rf build',
  })
  const line = JSON.parse(readFileSync(auditPath, 'utf8').trim().split(/\r?\n/).pop())
  check('审计文件里的决定行带 risk 字段', line.risk === 'high' && line.outcome === 'allowed-once',
    JSON.stringify(line))
} catch (e) {
  check('审计文件可写', false, e.message)
}

// ═════════════════════════════════════════════════════════════════════════
// 4–6. 页面（真 Chrome + CDP）
// ═════════════════════════════════════════════════════════════════════════
section('[4–6] 页面：徽标与两步确认（真 Chrome + CDP）')

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
  skip('页面两步确认（徽标 / 取消 / Esc / 遮罩 / 网络日志）', '本机没有 Chrome（设置 CHROME_PATH 后可跑）')
} else {
  const pageHtml = readFileSync(PAGE, 'utf8')
  const swJs = readFileSync(SW, 'utf8')
  const approvals = []
  let riskConfirm = true
  const NOW = Date.now()
  const pendingList = () => ([
    {
      id: 'approval-high',
      kind: 'approval/request',
      title: 'pwsh',
      detail: '在仓库根目录执行 npm publish --access public。',
      risk: 'high',
      session: 'session-a',
      sessionTitle: '发布 1.8.8',
      at: NOW - 2000,
      canDecide: true,
      expiresAt: NOW + 110000,
      timeoutMs: 120000,
    },
    {
      id: 'approval-normal',
      kind: 'approval/request',
      title: 'edit',
      detail: '改一处文案：把「保存」改成「保存并关闭」。',
      risk: 'normal',
      session: 'session-b',
      sessionTitle: '整理按钮文案',
      at: NOW - 1000,
      canDecide: true,
      expiresAt: NOW + 118000,
      timeoutMs: 120000,
    },
  ])
  const payload = () => ({
    generatedAt: Date.now(),
    offline: false,
    errors: [],
    riskConfirm,
    totals: { sessions: 2, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 2 },
    today: { since: Date.now() - 21600000, turns: 1, steps: 1, sessions: 1, partial: false },
    pending: pendingList(),
    sessions: [],
    jobs: [],
    subagents: [],
    workflows: [],
  })

  let pageServer = null
  let child = null
  let profile = ''
  try {
    pageServer = http.createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname
      if (path === '/taskwatch' || path === '/taskwatch/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(pageHtml)
        return
      }
      if (path === '/taskwatch/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(swJs)
        return
      }
      if (path === '/taskwatch/data') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(payload()))
        return
      }
      if (path === '/taskwatch/approve') {
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
          let body = {}
          try { body = JSON.parse(raw) } catch { body = {} }
          approvals.push({ method: req.method, url: path, body })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, outcome: body.decision === 'reject' ? 'rejected' : 'allowed-once' }))
        })
        return
      }
      if (path.startsWith('/taskwatch/chat/') || path === '/taskwatch/devices') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(path === '/taskwatch/devices' ? JSON.stringify({ ok: true, devices: [] }) : JSON.stringify({ sessions: [] }))
        return
      }
      if (path === '/taskwatch/approvals/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    await new Promise((r) => pageServer.listen(0, '127.0.0.1', r))
    const pageBase = 'http://127.0.0.1:' + pageServer.address().port

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
        this.requests = []
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data)
          if (!msg.id) {
            if (msg.method === 'Network.requestWillBeSent') {
              const request = msg.params.request
              this.requests.push({ url: request.url, method: request.method, postData: request.postData || '' })
            }
            return
          }
          if (!this.pending.has(msg.id)) return
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

    async function waitPort(dir, proc) {
      const deadline = Date.now() + 15000
      const file = join(dir, 'DevToolsActivePort')
      while (Date.now() < deadline) {
        if (proc.exitCode !== null) throw new Error('Chrome 启动即退出，code=' + proc.exitCode)
        const port = readDevToolsPort(file)
        if (port) return Number(port)
        await sleep(100)
      }
      throw new Error('等不到 DevToolsActivePort')
    }

    profile = mkdtempSync(join(tmpdir(), 'tw-risk-chrome-'))
    child = (await import('node:child_process')).spawn(chrome, [
      '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
      '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    const port = await waitPort(profile, child)
    const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json()
    const browser = await Cdp.connect(version.webSocketDebuggerUrl)
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
    const info = targets.find((t) => t.id === targetId)
    if (!info) throw new Error('找不到 target')
    const cdp = await Cdp.connect(info.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })

    const evalJs = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result && r.result.value
    }
    const waitFor = async (expression, timeout, label) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (await evalJs(expression)) return true
        await sleep(100)
      }
      throw new Error('超时：' + label)
    }
    const openPage = async () => {
      await cdp.send('Page.navigate', { url: pageBase + '/taskwatch?shot=risk&t=' + Date.now() })
      await sleep(700)
      await waitFor(`document.querySelectorAll('#homeTodo [data-pending-id]').length >= 1
        && document.querySelector('#homeTodo [data-pending-id="approval-high"]') !== null`, 8000, '首页待办渲染')
      await sleep(250)
    }
    const approvePosts = () => cdp.requests.filter((r) => r.method === 'POST' && /\/taskwatch\/approve$/.test(r.url.split('?')[0]))
    const highCard = 'document.querySelector(\'#homeTodo [data-pending-id="approval-high"]\')'

    console.log('\n[4] 高危徽标与普通卡')
    await openPage()
    const look = JSON.parse(await evalJs(`JSON.stringify((function () {
      var hi = ${highCard}
      var normal = document.querySelector('#homeTodo [data-pending-id="approval-normal"]')
      var hb = hi.querySelector('.badge')
      var nt = normal.querySelector('.badge')
      var title = hi.querySelector('.title')
      var br = hb.getBoundingClientRect(), tr = title.getBoundingClientRect()
      return {
        hiBadge: hb.textContent.trim(),
        hiBadgeClass: hb.className,
        normalBadge: (nt || {}).textContent || '',
        normalClass: (nt || {}).className || '',
        note: (hi.querySelector('.risk-note') || {}).textContent || '',
        normalNote: (normal.querySelector('.risk-note') || {}).textContent || '',
        badgeRight: Math.round(br.right),
        titleLeft: Math.round(tr.left),
        titleW: Math.round(tr.width),
        docW: document.documentElement.scrollWidth,
        viewW: window.innerWidth
      }
    })())`))
    check('高危卡片左上角是红色「高危」徽标',
      look.hiBadge === '高危' && /\brisk\b/.test(look.hiBadgeClass), JSON.stringify(look.hiBadgeClass))
    check('普通卡片没有高危徽标与高危说明',
      look.normalBadge === '待批准' && !/\brisk\b/.test(look.normalClass) && look.normalNote === '',
      JSON.stringify({ badge: look.normalBadge, cls: look.normalClass, note: look.normalNote }))
    check('高危说明文案完整',
      look.note === '这条会改动文件或发布，确认前请看清', look.note)
    check('徽标不挤压标题（徽标在标题左侧、标题有宽度）',
      look.badgeRight <= look.titleLeft + 1 && look.titleW >= 80,
      JSON.stringify({ badgeRight: look.badgeRight, titleLeft: look.titleLeft, titleW: look.titleW }))
    check('390 宽无横向溢出', look.docW <= look.viewW + 1, look.docW + '/' + look.viewW)

    console.log('\n[5] 点「批准一次」先展开确认层，不发请求')
    const before = approvePosts().length
    await evalJs(`(${highCard}).querySelector('[data-approve]').click(); 'ok'`)
    await waitFor(`!document.querySelector('#homeTodo [data-risk-confirm]').hidden`, 3000, '确认层展开')
    const opened = JSON.parse(await evalJs(`JSON.stringify((function () {
      var card = ${highCard}
      var box = card.querySelector('[data-risk-confirm]')
      var ok = box.querySelector('[data-risk-ok]')
      var cancel = box.querySelector('[data-risk-cancel]')
      var approve = card.querySelector('[data-approve]')
      var reject = card.querySelector('[data-reject]')
      return {
        hidden: box.hidden,
        text: box.textContent,
        okText: ok.textContent.trim(),
        cancelText: cancel.textContent.trim(),
        okH: Math.round(ok.getBoundingClientRect().height),
        cancelH: Math.round(cancel.getBoundingClientRect().height),
        approveDisabled: approve.disabled,
        rejectDisabled: reject.disabled,
        maskHidden: document.getElementById('riskMask').hidden,
        legacyHidden: document.getElementById('approveConfirm').hidden,
        openClass: card.className
      }
    })())`))
    check('确认层已展开（不是新页面：URL 不变、卡片内展开）',
      opened.hidden === false && opened.openClass.includes('risk-open') &&
      (await evalJs('location.hash || location.pathname')) === '/taskwatch')
    check('确认层列出工具与原因 + 不可撤销提示',
      opened.text.includes('pwsh') && opened.text.includes('npm publish --access public') &&
      opened.text.includes('确认执行？此操作不可撤销'), opened.text)
    check('两个按钮是「取消」与「确认执行」', opened.cancelText === '取消' && opened.okText === '确认执行',
      JSON.stringify([opened.cancelText, opened.okText]))
    check('确认层按钮 44px', opened.okH >= 44 && opened.cancelH >= 44,
      JSON.stringify({ ok: opened.okH, cancel: opened.cancelH }))
    check('卡片其余按钮禁用', opened.approveDisabled === true && opened.rejectDisabled === true)
    check('遮罩出现、旧确认框没有掺和进来',
      opened.maskHidden === false && opened.legacyHidden === true)
    await sleep(150)
    check('只点「批准一次」**没有**发 approve（CDP 网络日志）', approvePosts().length === before,
      JSON.stringify(cdp.requests.filter((r) => r.method === 'POST')))

    console.log('\n[6] 取消 / Esc / 点遮罩都只收层')
    const assertClosed = async (label) => {
      await waitFor(`document.querySelector('#homeTodo [data-risk-confirm]').hidden`, 2000, label + ' 收层')
      const state = JSON.parse(await evalJs(`JSON.stringify((function () {
        var card = ${highCard}
        return {
          approveDisabled: card.querySelector('[data-approve]').disabled,
          rejectDisabled: card.querySelector('[data-reject]').disabled,
          maskHidden: document.getElementById('riskMask').hidden,
          openClass: card.className
        }
      })())`))
      check(label + '：确认层收起、卡片回到可操作态、无请求',
        state.approveDisabled === false && state.rejectDisabled === false &&
        state.maskHidden === true && !state.openClass.includes('risk-open') &&
        approvePosts().length === before, JSON.stringify(state))
    }
    await evalJs(`document.querySelector('[data-risk-cancel]').click(); 'ok'`)
    await assertClosed('点「取消」')

    await evalJs(`(${highCard}).querySelector('[data-approve]').click(); 'ok'`)
    await waitFor(`!document.querySelector('#homeTodo [data-risk-confirm]').hidden`, 2000, '再次展开')
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'`)
    await assertClosed('按 Esc')

    await evalJs(`(${highCard}).querySelector('[data-approve]').click(); 'ok'`)
    await waitFor(`!document.querySelector('#homeTodo [data-risk-confirm]').hidden`, 2000, '第三次展开')
    await evalJs(`document.getElementById('riskMask').click(); 'ok'`)
    await assertClosed('点遮罩')

    console.log('\n[5b] 点「确认执行」才真的发请求')
    await evalJs(`(${highCard}).querySelector('[data-approve]').click(); 'ok'`)
    await waitFor(`!document.querySelector('#homeTodo [data-risk-confirm]').hidden`, 2000, '第四次展开')
    const beforeOk = approvePosts().length
    await evalJs(`document.querySelector('[data-risk-ok]').click(); 'ok'`)
    await waitFor(`(${highCard}).querySelector('[data-state]').textContent.indexOf('已提交') >= 0`, 5000, '提交完成')
    const posts = approvePosts().slice(beforeOk)
    check('点「确认执行」发出且只发一条 approve', posts.length === 1, JSON.stringify(posts))
    let body = {}
    try { body = JSON.parse(posts[0].postData || '{}') } catch { body = {} }
    check('请求体是 {id, decision:"allow"}',
      body.id === 'approval-high' && body.decision === 'allow', JSON.stringify(body))
    check('处理完不再留确认层 / 遮罩',
      (await evalJs(`document.getElementById('riskMask').hidden`)) === true &&
      (await evalJs(`document.querySelector('#homeTodo [data-risk-confirm]').hidden`)) === true)

    console.log('\n[4b] riskConfirm:false：只显示徽标，点击直接发请求')
    riskConfirm = false
    await openPage()
    const offLook = JSON.parse(await evalJs(`JSON.stringify((function () {
      var card = ${highCard}
      return { badge: card.querySelector('.badge').textContent.trim(),
        note: !!card.querySelector('.risk-note') }
    })())`))
    check('关掉 riskConfirm 后徽标仍在、说明仍在', offLook.badge === '高危' && offLook.note,
      JSON.stringify(offLook))
    const offBefore = approvePosts().length
    await evalJs(`(${highCard}).querySelector('[data-approve]').click(); 'ok'`)
    const offNow = JSON.parse(await evalJs(`JSON.stringify({
      risk: !document.querySelector('#homeTodo [data-risk-confirm]').hidden,
      legacy: !document.getElementById('approveConfirm').hidden
    })`))
    check('关掉后点击不展开任何确认层',
      offNow.risk === false && offNow.legacy === false, JSON.stringify(offNow))
    await waitFor(`(${highCard}).querySelector('[data-state]').textContent.indexOf('已提交') >= 0`, 5000, '直接提交完成')
    check('关掉后点击直接发 approve', approvePosts().length === offBefore + 1,
      String(approvePosts().length - offBefore))

    console.log('\n[4c] 普通卡仍走 v1.8.0 的二次确认（未被替换）')
    riskConfirm = true
    await openPage()
    const normalBefore = approvePosts().length
    await evalJs(`document.querySelector('#homeTodo [data-pending-id="approval-normal"] [data-approve]').click(); 'ok'`)
    await waitFor(`!document.getElementById('approveConfirm').hidden`, 2000, '普通卡确认框')
    check('普通卡弹出「确认允许一次？」且未发请求',
      (await evalJs(`(document.querySelector('#approveConfirm h3') || {}).textContent || ''`)) === '确认允许一次？' &&
      approvePosts().length === normalBefore)
    await evalJs(`document.querySelector('#approveConfirm [data-confirm-cancel]').click(); 'ok'`)
    await waitFor(`document.getElementById('approveConfirm').hidden`, 2000, '普通卡取消')
    check('普通卡取消后不发请求、按钮仍可用',
      approvePosts().length === normalBefore &&
      (await evalJs(`document.querySelector('#homeTodo [data-pending-id="approval-normal"] [data-approve]').disabled`)) === false)

    try { await browser.send('Target.closeTarget', { targetId }) } catch { /* 已关 */ }
    cdp.close()
    browser.close()
  } finally {
    if (child && child.exitCode === null) { try { child.kill() } catch { /* 已退出 */ } }
    if (pageServer) { try { if (typeof pageServer.closeAllConnections === 'function') pageServer.closeAllConnections() } catch { /* 旧 Node */ } try { pageServer.close() } catch { /* 已关 */ } }
    if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* 锁文件 */ } }
  }
}

try { rmSync(AUDIT_HOME, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }

console.log(`\n高危动作二次确认：${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''}`)
if (failed) process.exitCode = 1
