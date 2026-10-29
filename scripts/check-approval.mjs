#!/usr/bin/env node
/**
 * v1.8.0 手机端一次性审批的契约测试。
 *
 * 这里刻意分两层：
 *   1. 纯函数 / 状态机：createApprovalBroker 可以用 50ms 超时真的跑完，不必等 120 秒；
 *   2. 真实 HTTP：apply() 注册的 /taskwatch/approve、/taskwatch/decisions 走
 *      node:http 与 fetch，和用户手机实际打的是同一条路。
 *
 * 四条失败语义各自有断言：手机离线立刻 next()、超时 next()、abort 立刻交还、
 * 内部异常 next()；另外钉住 400/404/409/410 四个错误码。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'tw-approval-'))
process.env.DSH_HOME = home

const {
  apply,
  resolveApprovalConfig,
  APPROVAL_CONFIG_SCHEMA,
  APPROVAL_TIMEOUT_DEFAULT_MS,
  APPROVAL_TIMEOUT_MIN_MS,
  APPROVAL_TIMEOUT_MAX_MS,
  createApprovalBroker,
  createApprovalGate,
  createAuditLog,
  auditLogPath,
} = await import('../lib/index.js')

const routes = new Map()
const handlers = new Map()
const webServer = {
  register(spec) {
    routes.set(spec.path, spec.handler)
    return () => {}
  },
}
const ctx = {
  get(name) { return name === 'webServer' ? webServer : undefined },
  effect(fn) { return fn() },
  on(event, fn) { handlers.set(event, fn); return () => {} },
}

apply(ctx, { approveFromPhone: true, approvalTimeoutMs: APPROVAL_TIMEOUT_DEFAULT_MS })
assert.equal(typeof handlers.get('approval/request'), 'function', 'approval/request 必须注册为 waterfall')

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const handler = routes.get(path)
  if (!handler) { res.writeHead(404); res.end(); return }
  Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: String(error && error.message || error) }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

async function call(path, init = {}) {
  const response = await fetch(base + path, init)
  const text = await response.text()
  let body = {}
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: response.status, body }
}
const postDecision = (body) => call('/taskwatch/approve', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('等待条件超时')
}
async function decisionCount() {
  const res = await call('/taskwatch/decisions')
  return res.body.decisions ? res.body.decisions.length : 0
}

let failures = 0
function test(name, fn) {
  return (async () => {
    try {
      await fn()
      console.log('  PASS  ' + name)
    } catch (e) {
      failures++
      console.log('  FAIL  ' + name + ' — ' + (e && e.message ? e.message : e))
    }
  })()
}

try {
  console.log('\n配置与审计')

  const warnings = []
  const defaults = resolveApprovalConfig({}, (msg) => warnings.push(msg))
  assert.equal(defaults.approveFromPhone, true)
  assert.equal(defaults.timeoutMs, APPROVAL_TIMEOUT_DEFAULT_MS)
  assert.equal(APPROVAL_CONFIG_SCHEMA.approveFromPhone.default, true)
  assert.equal(APPROVAL_CONFIG_SCHEMA.approvalTimeoutMs.default, APPROVAL_TIMEOUT_DEFAULT_MS)

  const low = resolveApprovalConfig({ approvalTimeoutMs: 1 }, (msg) => warnings.push(msg))
  assert.equal(low.timeoutMs, APPROVAL_TIMEOUT_MIN_MS)
  const high = resolveApprovalConfig({ approvalTimeoutMs: 99999999 }, (msg) => warnings.push(msg))
  assert.equal(high.timeoutMs, APPROVAL_TIMEOUT_MAX_MS)
  assert.equal(warnings.length >= 2, true, '越界必须 warn')

  const off = resolveApprovalConfig({ approveFromPhone: false }, () => {})
  assert.equal(off.approveFromPhone, false)
  assert.equal(auditLogPath({ DSH_HOME: home }, 'C:\\ignored'), join(home, 'taskwatch-audit.log'))
  assert.equal(auditLogPath({}, 'C:\\Users\\demo'), join('C:\\Users\\demo', '.dsh', 'taskwatch-audit.log'))

  const timeoutAudit = join(home, 'timeout-audit.log')
  const timeoutLog = createAuditLog({ file: timeoutAudit })
  const auditEntries = []
  const broker = createApprovalBroker({
    timeoutMs: 50,
    now: Date.now,
    audit: (entry) => { auditEntries.push(entry); timeoutLog.write(entry) },
  })
  const claim = broker.begin({ session: 'session-test', toolName: 'pwsh', reason: 'x'.repeat(200) })
  const timeoutResult = await claim.promise
  assert.equal(timeoutResult.delegated, true, '超时必须交还')
  assert.equal(timeoutResult.by, 'timeout')
  assert.equal(auditEntries.length, 1)
  assert.equal(auditEntries[0].by, 'timeout')
  assert.equal(auditEntries[0].outcome, 'delegated')
  assert.equal(auditEntries[0].reason.length, 120, '审计只留 reason 前 120 字')
  const timeoutLines = readFileSync(timeoutAudit, 'utf8').trim().split(/\r?\n/)
  assert.equal(JSON.parse(timeoutLines[0]).by, 'timeout')
  assert.equal(broker.decide(claim.id, 'always-allow').status, 400, 'broker 自身也不接受 always-allow')
  assert.equal(broker.decide(claim.id, 'allow').status, 410, '超时后再提交必须 410')

  console.log('\n闸门控制流')

  await test('手机离线时立刻 next()，不进入等待', async () => {
    const gate = createApprovalGate({
      approveFromPhone: true,
      timeoutMs: 5000,
      isPhoneOnline: () => false,
      audit: () => {},
    })
    let nextCalls = 0
    const started = Date.now()
    const outcome = await gate.handle(
      { agent: { id: 's1' }, toolName: 'pwsh', reason: 'rm -rf build' },
      async () => { nextCalls++; return 'unavailable' },
    )
    assert.equal(outcome, 'unavailable')
    assert.equal(nextCalls, 1)
    assert.equal(Date.now() - started < 100, true, '离线路径不能有等待')
    assert.equal(gate.list().length, 0, '离线时不应创建 decision')
  })

  await test('超时后 next()，审计 by=timeout', async () => {
    const audits = []
    const gate = createApprovalGate({
      approveFromPhone: true,
      timeoutMs: 50,
      isPhoneOnline: () => true,
      audit: (entry) => audits.push(entry),
    })
    let nextCalls = 0
    const outcome = await gate.handle(
      { agent: { id: 's1' }, toolName: 'pwsh' },
      async () => { nextCalls++; return 'unavailable' },
    )
    assert.equal(outcome, 'unavailable')
    assert.equal(nextCalls, 1)
    assert.equal(audits[0] && audits[0].by, 'timeout')
  })

  await test('req.signal abort 立刻交还，审计 by=desktop', async () => {
    const audits = []
    const gate = createApprovalGate({
      approveFromPhone: true,
      timeoutMs: 5000,
      isPhoneOnline: () => true,
      audit: (entry) => audits.push(entry),
    })
    const controller = new AbortController()
    let nextCalls = 0
    const running = gate.handle(
      { agent: { id: 's1' }, toolName: 'pwsh', signal: controller.signal },
      async () => { nextCalls++; return 'unavailable' },
    )
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    const outcome = await running
    assert.equal(outcome, 'unavailable')
    assert.equal(nextCalls, 1)
    assert.equal(audits[0] && audits[0].by, 'desktop')
    assert.equal(audits[0] && audits[0].outcome, 'cancelled')
  })

  await test('内部异常交给 next()（不重复调用）', async () => {
    const errorLog = createAuditLog({ file: join(home, 'taskwatch-audit.log') })
    const gate = createApprovalGate({
      approveFromPhone: true,
      timeoutMs: 5000,
      isPhoneOnline: () => true,
      audit: (entry) => errorLog.write(entry),
    })
    let nextCalls = 0
    const req = { agent: { id: 's1' }, get toolName() { throw new Error('boom') } }
    const outcome = await gate.handle(req, async () => { nextCalls++; return 'unavailable' })
    assert.equal(outcome, 'unavailable')
    assert.equal(nextCalls, 1)
  })

  console.log('\nHTTP 路由')

  // 手机页的一次轮询就是「手机在线」的信号。桌面 GUI 不带 view=phone，故意不算。
  const online = await call('/taskwatch/data?view=phone')
  assert.equal(online.status, 200)

  let nextCalls = 0
  const ac = new AbortController()
  const pending = handlers.get('approval/request')(
    { agent: { id: 's1' }, toolName: 'pwsh', callId: 'call-1', reason: '删除 build/cache 下的过期产物', signal: ac.signal },
    async () => { nextCalls++; return 'unavailable' },
  )
  await waitFor(async () => (await decisionCount()) === 1, 3000)
  const list = await call('/taskwatch/decisions')
  const id = list.body.decisions[0].id
  assert.equal(list.body.decisions[0].toolName, 'pwsh')

  await test('allow → 200 allowed-once，handler 不调 next()', async () => {
    const res = await postDecision({ id, decision: 'allow' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, outcome: 'allowed-once' })
    assert.equal(await pending, 'allowed-once')
    assert.equal(nextCalls, 0)
  })

  await test('重复提交 → 409（只成功一次）', async () => {
    const res = await postDecision({ id, decision: 'reject' })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'already-decided')
  })

  await test('参数错 → 400；未知 id → 404', async () => {
    const bad = await postDecision({ id, decision: 'always-allow' })
    assert.equal(bad.status, 400)
    const missing = await postDecision({ decision: 'allow' })
    assert.equal(missing.status, 400)
    const unknown = await postDecision({ id: 'not-a-real-id', decision: 'allow' })
    assert.equal(unknown.status, 404)
  })

  await test('abort 后提交 → 410（已交还）', async () => {
    const ac2 = new AbortController()
    let calls = 0
    const running = handlers.get('approval/request')(
      { agent: { id: 's1' }, toolName: 'edit', callId: 'call-2', reason: '改一处文案', signal: ac2.signal },
      async () => { calls++; return 'unavailable' },
    )
    await waitFor(async () => (await decisionCount()) === 1)
    const pendingList = await call('/taskwatch/decisions')
    const id2 = pendingList.body.decisions[0].id
    ac2.abort()
    assert.equal(await running, 'unavailable')
    assert.equal(calls, 1)
    const late = await postDecision({ id: id2, decision: 'allow' })
    assert.equal(late.status, 410)
    assert.equal(late.body.code, 'expired-or-delegated')
  })

  await test('手机端只暴露 allow / reject（没有 always-allow）', async () => {
    const always = await postDecision({ id: 'whatever', decision: 'always-allow' })
    assert.equal(always.status, 400)
    const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')
    assert.match(page, /data-approve/)
    assert.match(page, /data-reject/)
    assert.ok(page.includes('批准一次'))
    assert.ok(page.includes('确认允许一次？'))
    assert.ok(page.includes('批准一次') && page.includes('拒绝'))
    assert.ok(page.includes('canDecide'))
    assert.ok(page.includes('已由桌面处理'))
  })

  console.log('\n审计文件')

  const lines = readFileSync(join(home, 'taskwatch-audit.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
  const parsed = lines.map((line) => JSON.parse(line))
  assert.ok(parsed.some((e) => e.by === 'phone' && e.outcome === 'allowed-once'), '手机决定必须有审计')
  assert.ok(parsed.some((e) => e.by === 'desktop' && e.outcome === 'cancelled'), 'abort 必须有审计')
  assert.ok(parsed.some((e) => e.by === 'error' && e.outcome === 'error'), '内部异常必须有审计')
  for (const entry of parsed) {
    assert.equal(typeof entry.at, 'string')
    assert.equal(typeof entry.session, 'string')
    assert.equal(typeof entry.toolName, 'string')
    assert.ok(!('command' in entry) && !('stdout' in entry), '审计不能记命令全文')
    if (entry.reason) assert.ok(entry.reason.length <= 120)
  }
} finally {
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 旧 Node */ }
  await new Promise((resolve) => server.close(resolve))
  try { rmSync(home, { recursive: true, force: true }) } catch { /* Windows 上偶尔占用 */ }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
