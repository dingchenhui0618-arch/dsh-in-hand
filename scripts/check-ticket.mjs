#!/usr/bin/env node
/**
 * v3 票据契约测试（v1.8.6）：受众绑定 + 严格一次性 + 升级兼容 + 清理。
 *
 * 只用真实 `apply()` + 真实 node:http，不 spawn 中继（真实中继实例的冒烟在
 * scripts/check-ticket-hmac.mjs 里，那边会临时端口起一个、结束必杀）。
 * 中继的两种响应（旧中继没有 ticketVersions / 新中继声明支持 v3）在这里用**假服务**模拟，
 * 因为兼容逻辑要测的正是"插件看到什么响应就签什么版本"。
 *
 * 七组用例：
 *   1. 签发 → 兑换成功一次，第二次 401
 *   2. aud 错配双向 401（lan 票当 remote 用、remote 票当 lan 用）
 *   3. 篡改任一字段 / 过期 → 401
 *   4. 同一 nonce 并发兑换 10 次 → 恰好 1 次成功
 *   5. v2 过渡票仍可用；过渡期结束后 v2 → 401
 *   6. 中继未声明 v3 → 插件签 v2；声明 v3 → 签 v3；探测失败 → v2
 *   7. 清理：过期项不会无限增长（注入时间，不真等 60 秒）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { apply } from '../lib/index.js'
import {
  TICKET_V2_SUNSET_AT, TICKET_TTL_MS, TICKET_VERSIONS,
  createReplayGuard, redeemTicket, signTicket, verifyTicket,
} from '../lib/ticket.js'

const SECRET = 'check-ticket-v3-' + 'k'.repeat(40)
process.env.TASKWATCH_TICKET_SECRET = SECRET

const results = []
function pass(name, detail = '') {
  results.push({ name, detail })
  console.log('  ok   ' + name + (detail ? ' —— ' + detail : ''))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

/** 宿主实例：真实 apply() + 真实路由表。 */
function makeHost(config) {
  const routes = new Map()
  const services = { webServer: { register(spec) { routes.set(spec.path, spec.handler) } } }
  const ctx = {
    get(name) { return services[name] },
    effect(fn) { return fn() },
    on() { return () => {} },
  }
  apply(ctx, config)
  return routes
}

async function serve(routes, port = 0) {
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!handler) { res.writeHead(404); res.end('not found'); return }
    Promise.resolve(handler(req, res)).catch((error) => {
      try { res.writeHead(500); res.end(String(error)) } catch { /* 已断开 */ }
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { server, base: 'http://127.0.0.1:' + server.address().port, port: server.address().port }
}

async function raw(base, path, init = {}) {
  const response = await fetch(base + path, { redirect: 'manual', ...init })
  const text = await response.text()
  return { status: response.status, headers: response.headers, text }
}

const postJson = (base, path, value, headers = {}) => raw(base, path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(value),
})

const ticketOf = (url) => String(url || '').split('?t=')[1] || ''

/** 假中继：只提供插件探测用的 /taskwatch/lan.json（内容可控）。 */
async function fakeRelay(lanJson) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path === '/taskwatch/lan.json') {
      const body = JSON.stringify(lanJson === null ? {} : lanJson)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
      return
    }
    res.writeHead(404); res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: 'http://127.0.0.1:' + server.address().port }
}

const hosts = []
const servers = []

try {
  // ── 1. 签发 → 兑换一次，第二次 401 ────────────────────────────────────────
  {
    const port = await freePort()
    // lanUrl 指回宿主自己：这就是"局域网直连"，受众必须是 lan。
    const host = await serve(makeHost({ lanUrl: 'http://127.0.0.1:' + port }), port)
    hosts.push(host)
    const issued = await postJson(host.base, '/taskwatch/ticket', { to: 'lan' })
    assert.equal(issued.status, 200)
    const ticket = ticketOf(JSON.parse(issued.text).url)
    assert.match(ticket, /^v3\.\d{13}\.[A-Za-z0-9_-]{16,}\.lan\.[A-Za-z0-9_-]{20,}$/,
      '给局域网直连签的应当是 v3 + aud=lan，实际：' + ticket.slice(0, 12))
    const first = await raw(host.base, '/taskwatch?t=' + ticket)
    assert.equal(first.status, 302, '第一次兑换应成功')
    assert.match(String(first.headers.get('set-cookie')), /tw-route=/)
    const second = await raw(host.base, '/taskwatch?t=' + ticket)
    assert.equal(second.status, 401, '第二次兑换必须 401')
    pass('1 签发 → 兑换一次成功、第二次 401')
  }

  // ── 2. 受众错配：双向 401 ────────────────────────────────────────────────
  {
    const port = await freePort()
    const relay = await fakeRelay({ ticketVersions: [3, 2], ticketAudience: 'remote' })
    servers.push(relay.server)
    const host = await serve(makeHost({
      lanUrl: 'http://127.0.0.1:' + port,
      publicUrl: relay.base, // 中继是另一个端口 → 受众 remote
    }), port)
    hosts.push(host)

    // (a) remote 票拿到宿主（只收 lan）兑换 → 401
    const remoteIssued = await postJson(host.base, '/taskwatch/ticket', { to: 'remote' })
    assert.equal(remoteIssued.status, 200)
    const remoteTicket = ticketOf(JSON.parse(remoteIssued.text).url)
    assert.match(remoteTicket, /\.remote\./, '公网入口的票必须是 aud=remote')
    const atHost = await raw(host.base, '/taskwatch?t=' + remoteTicket)
    assert.equal(atHost.status, 401, 'aud=remote 的票不能在宿主兑现')

    // (b) lan 票拿到"中继"（只收 remote）兑换 → 401（纯函数层，中继就是这么判的）
    const lanTicket = signTicket(SECRET, { aud: 'lan' })
    const guard = createReplayGuard({ autoSweep: false })
    const wrongAud = redeemTicket(SECRET, lanTicket, { aud: 'remote', guard })
    assert.equal(wrongAud.ok, false)
    assert.equal(wrongAud.reason, 'audience', 'lan 票当 remote 用应因受众被拒')
    assert.equal(wrongAud.aud, 'lan')
    assert.equal(guard.size, 0, '受众不符时不能记账（不该消耗对方的 nonce 记录）')
    pass('2 受众错配双向 401（aud=lan ↔ aud=remote）')
  }

  // ── 3. 篡改任一字段 / 过期 → 401 ────────────────────────────────────────
  {
    const port = await freePort()
    const host = await serve(makeHost({ lanUrl: 'http://127.0.0.1:' + port }), port)
    hosts.push(host)
    const issued = await postJson(host.base, '/taskwatch/ticket', { to: 'lan' })
    const ticket = ticketOf(JSON.parse(issued.text).url)
    const parts = ticket.split('.')
    const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
    const tampered = {
      exp: [parts[0], '1793272087816', parts[2], parts[3], parts[4]].join('.'),
      nonce: [parts[0], parts[1], flip(parts[2]), parts[3], parts[4]].join('.'),
      aud: [parts[0], parts[1], parts[2], 'remote', parts[4]].join('.'),
      hmac: [parts[0], parts[1], parts[2], parts[3], flip(parts[4])].join('.'),
    }
    for (const [field, bad] of Object.entries(tampered)) {
      const got = await raw(host.base, '/taskwatch?t=' + bad)
      assert.equal(got.status, 401, '篡改 ' + field + ' 必须 401')
      assert.equal(verifyTicket(SECRET, bad, { aud: 'lan' }), false, '篡改 ' + field + ' 不应通过验签')
    }
    // 过期：exp = now - 1ms（TTL 用尽）
    const stale = signTicket(SECRET, { now: () => Date.now() - TICKET_TTL_MS - 1, aud: 'lan' })
    assert.equal((await raw(host.base, '/taskwatch?t=' + stale)).status, 401, '过期票必须 401')
    // 超长跨度（手工签一年）也拒绝
    const far = signTicket(SECRET, { now: () => Date.now() + 365 * 24 * 3600 * 1000, aud: 'lan' })
    assert.equal((await raw(host.base, '/taskwatch?t=' + far)).status, 401, '超长跨度必须 401')
    pass('3 篡改 exp/nonce/aud/hmac、过期、超长跨度全部 401')
  }

  // ── 4. 并发 10 次 → 恰好 1 次成功 ────────────────────────────────────────
  {
    const port = await freePort()
    const host = await serve(makeHost({ lanUrl: 'http://127.0.0.1:' + port }), port)
    hosts.push(host)
    const issued = await postJson(host.base, '/taskwatch/ticket', { to: 'lan' })
    const ticket = ticketOf(JSON.parse(issued.text).url)
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => raw(host.base, '/taskwatch?t=' + ticket)),
    )
    const ok = answers.filter((r) => r.status === 302).length
    const denied = answers.filter((r) => r.status === 401).length
    assert.equal(ok, 1, '并发 10 次只能成功 1 次，实际 ' + ok)
    assert.equal(denied, 9, '其余 9 次必须 401，实际 ' + denied)
    pass('4 同一 nonce 并发 10 次 → 恰好 1 次成功（9 次 401）')
  }

  // ── 5. v2 过渡票：期内可用，期后 401 ────────────────────────────────────
  {
    const port = await freePort()
    const host = await serve(makeHost({ lanUrl: 'http://127.0.0.1:' + port }), port)
    hosts.push(host)
    const v2 = signTicket(SECRET, { version: 2, aud: 'lan' })
    assert.match(v2, /^v2\.\d{13}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}$/)
    assert.equal(verifyTicket(SECRET, v2), true, '过渡期内 v2 应可验')
    assert.equal((await raw(host.base, '/taskwatch?t=' + v2)).status, 302, '过渡期内 v2 应能兑换')
    assert.equal((await raw(host.base, '/taskwatch?t=' + v2)).status, 401, 'v2 同样严格一次性')

    // 注入过渡期结束之后的时间：v2 → v2-sunset
    const after = TICKET_V2_SUNSET_AT + 1
    const fakeNow = () => after
    const v2At = signTicket(SECRET, { version: 2, now: fakeNow })
    const guard = createReplayGuard({ autoSweep: false })
    const late = redeemTicket(SECRET, v2At, { now: fakeNow, guard })
    assert.equal(late.ok, false)
    assert.equal(late.reason, 'v2-sunset', '过渡期结束后 v2 必须拒绝，实际 ' + late.reason)
    assert.equal(verifyTicket(SECRET, v2At, { now: fakeNow }), false)
    pass('5 v2 过渡票仍可用（期内 302、期后 v2-sunset）', '过渡期截止 ' + new Date(TICKET_V2_SUNSET_AT).toISOString().slice(0, 10))
  }

  // ── 6. 插件按中继的能力声明决定签 v2 还是 v3 ────────────────────────────
  {
    // (a) 旧中继：响应里没有 ticketVersions → 必须回退 v2（否则新插件 + 旧中继会断网）
    const oldRelay = await fakeRelay(null)
    servers.push(oldRelay.server)
    const viaOld = await serve(makeHost({ publicUrl: oldRelay.base }))
    hosts.push(viaOld)
    const oldIssued = await postJson(viaOld.base, '/taskwatch/ticket', { to: 'remote' })
    assert.equal(oldIssued.status, 200)
    const oldTicket = ticketOf(JSON.parse(oldIssued.text).url)
    assert.match(oldTicket, /^v2\./, '中继未声明 v3 时必须签 v2，实际：' + oldTicket.slice(0, 3))

    // (b) 新中继：ticketVersions 含 3 → 签 v3 + aud=remote
    const newRelay = await fakeRelay({ ticketVersions: TICKET_VERSIONS, ticketAudience: 'remote' })
    servers.push(newRelay.server)
    const viaNew = await serve(makeHost({ publicUrl: newRelay.base }))
    hosts.push(viaNew)
    const newIssued = await postJson(viaNew.base, '/taskwatch/ticket', { to: 'remote' })
    const newTicket = ticketOf(JSON.parse(newIssued.text).url)
    assert.match(newTicket, /^v3\.\d{13}\.[A-Za-z0-9_-]{16,}\.remote\./, '中继声明 v3 后应签 v3 + aud=remote')

    // (c) 探测失败（端口关闭）→ 回退 v2
    const closed = await freePort()
    const viaDead = await serve(makeHost({ publicUrl: 'http://127.0.0.1:' + closed }))
    hosts.push(viaDead)
    const deadIssued = await postJson(viaDead.base, '/taskwatch/ticket', { to: 'remote' })
    const deadTicket = ticketOf(JSON.parse(deadIssued.text).url)
    assert.match(deadTicket, /^v2\./, '探测失败时必须回退 v2，实际：' + deadTicket.slice(0, 3))
    pass('6 旧中继→v2 / 声明 v3→v3 / 探测失败→v2')
  }

  // ── 7. 清理：过期项不会无限增长（注入时间）───────────────────────────────
  {
    let at = 1_800_000_000_000
    const now = () => at
    const guard = createReplayGuard({ now, autoSweep: false, max: 8 })
    for (let i = 0; i < 8; i++) assert.equal(guard.claim('nonce-' + i, at + 1000), true)
    assert.equal(guard.size, 8)
    // 时间推进到全部过期：下一次 claim 顺手清掉过期项（后台定时器做的是同一件事）
    at += 5000
    assert.equal(guard.claim('nonce-fresh', at + 1000), true)
    assert.equal(guard.size, 1, '过期项应被清掉，实际剩 ' + guard.size)
    // 硬上限：全是未过期记录时也不会无限涨
    for (let i = 0; i < 50; i++) guard.claim('hot-' + i, at + 60_000)
    assert.ok(guard.size <= 8, '容量上限应生效，实际 ' + guard.size)
    // prune 可以显式调用（测试与运维排查用）
    at += 120_000
    assert.equal(guard.prune(), 0, '全部过期后 prune 应为 0')
    guard.stop()
    pass('7 过期清理 + 容量上限（注入时间，size 上界 ' + 8 + '）')
  }
} finally {
  for (const host of hosts) host.server.close()
  for (const server of servers) server.close()
}

console.log('ticket v3 checks passed（' + results.length + ' 组）')
