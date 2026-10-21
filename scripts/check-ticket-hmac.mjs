#!/usr/bin/env node
/**
 * 跨进程票据互认（v2 HMAC）契约测试。
 *
 * 真实 node:http 服务 + 真实 handler，临时端口；中继那一侧会**真的 spawn 一个
 * taskwatch-relay 实例**（端口临时、RELAY_TOKEN 临时、不碰 3099 生产进程），
 * 结束后一定杀掉。中继文件不在本机时跳过跨实例两条，并明确打印 SKIP ——
 * 公开仓库里没有那个私有目录，不能让 CI 因此变红。
 *
 * 覆盖：
 *   1. 宿主签发 → 中继实例校验通过（302 + Set-Cookie）
 *   2. 中继签发 → 宿主校验通过
 *   3. 篡改签名 → 拒绝（401）
 *   4. 过期 / 超长跨度 → 拒绝
 *   5. 老格式随机票 → 仍走原进程内 Map（老页面兼容），未知随机票不会因"像票"而放行
 *   6. 没有密钥时自动生成到 <home>/.dsh/taskwatch-ticket.key，权限收紧（只断言存在 + 长度）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createTicketStore } from '../lib/index.js'
import {
  createReplayGuard, createTicketGate, loadTicketSecret,
  signTicket, verifyTicket, TICKET_MAX_AGE_MS, TICKET_TTL_MS,
} from '../lib/ticket.js'

// 固定测试密钥：既不读写真实 ~/.dsh，也让宿主 / 中继 / 测试三方签出同一套票。
const SECRET = 'check-ticket-hmac-' + 'z'.repeat(40)
process.env.TASKWATCH_TICKET_SECRET = SECRET

const RELAY_FILE = process.env.TASKWATCH_RELAY
  || 'D:/Projects/taskwatch-relay/server.mjs'
const HAS_RELAY = existsSync(RELAY_FILE)

// ── 宿主实例（真实 apply + 真实路由表）────────────────────────────────────
function makeHost(config) {
  const routes = new Map()
  const services = {
    webServer: { register(spec) { routes.set(spec.path, spec.handler) } },
  }
  const ctx = {
    get(name) { return services[name] },
    effect(fn) { return fn() },
    on() { return () => {} },
  }
  apply(ctx, config)
  return routes
}

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!handler) { res.writeHead(404); res.end('not found'); return }
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: 'http://127.0.0.1:' + server.address().port }
}

async function raw(base, path, init = {}) {
  const response = await fetch(base + path, { redirect: 'manual', ...init })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { status: response.status, headers: response.headers, text, body }
}

const postJson = (base, path, value, headers = {}) => raw(base, path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(value),
})

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

async function waitFor(url, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('中继进程提前退出：' + child.exitCode)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error('等待中继启动超时：' + url)
}

async function startRelay() {
  const port = await freePort()
  const child = spawn(process.execPath, [RELAY_FILE], {
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RELAY_BIND: '127.0.0.1',
      RELAY_TOKEN: 'check-ticket-token',
      RELAY_PUBLIC_URL: 'https://relay.example',
      RELAY_LAN: '0',
      TASKWATCH_TICKET_SECRET: SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const base = 'http://127.0.0.1:' + port
  try {
    await waitFor(base + '/healthz', child)
  } catch (error) {
    child.kill()
    throw new Error(error.message + '\n' + output.slice(-2000))
  }
  return {
    child,
    base,
    async stop() {
      if (child.exitCode !== null) return
      child.kill()
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } resolve() }, 3000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    },
  }
}

// ── 纯函数层：签名 / 篡改 / 过期 / 重放 ────────────────────────────────────
{
  const now = Date.now()
  const ticket = signTicket(SECRET, { now: () => now })
  assert.match(ticket, /^v2\.\d{13}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}$/)
  assert.equal(verifyTicket(SECRET, ticket, { now: () => now }), true)

  // 篡改：改 nonce 首字符。不能只改 HMAC 最后一个字符 —— base64url 末尾有 2 个
  // 未使用位，某些字符互换解出来的字节完全相同（实测会随机"验签通过"）。
  const parts0 = ticket.split('.')
  parts0[2] = (parts0[2][0] === 'A' ? 'B' : 'A') + parts0[2].slice(1)
  assert.equal(verifyTicket(SECRET, parts0.join('.'), { now: () => now }), false)
  // 换密钥也验不过。
  assert.equal(verifyTicket('another-' + 'q'.repeat(40), ticket, { now: () => now }), false)
  // 格式不符一律 false。
  for (const bad of ['', 'v2.123.short.mac', 'v1.1234567890123.nonce.mac', ticket + 'x']) {
    assert.equal(verifyTicket(SECRET, bad, { now: () => now }), false)
  }

  // 过期：exp = now - 1ms。
  const stale = signTicket(SECRET, { now: () => now - TICKET_TTL_MS - 1 })
  assert.equal(verifyTicket(SECRET, stale, { now: () => now }), false)
  // 超长跨度（例如有人手工签一年）：即使签名正确也拒绝。
  const far = signTicket(SECRET, { now: () => now + TICKET_MAX_AGE_MS })
  assert.equal(verifyTicket(SECRET, far, { now: () => now }), false)
  // 重放：同一进程内第二次见到同一 nonce 必须拒绝（best-effort，仅本进程）。
  const gate = createTicketGate({ secret: SECRET, now: () => now })
  assert.equal(gate.redeem(ticket), true)
  assert.equal(gate.redeem(ticket), false, '进程内 nonce 去重应拦住重放')
  assert.equal(createReplayGuard().replayed('nonce-a', now + 1000), false)
}

// ── 宿主实例：/taskwatch?t= 的真实兑换路径 ────────────────────────────────
{
  const host = await serve(makeHost({ publicUrl: 'https://host.example' }))

  // 1) 宿主签发 → （下一节）中继实例校验。
  let got = await postJson(host.base, '/taskwatch/ticket', { to: 'remote' })
  assert.equal(got.status, 200)
  const hostTicket = got.body.url.split('?t=')[1]
  assert.match(hostTicket, /^v2\./)

  // 4) 过期票走真实 handler：必须 401。
  const stale = signTicket(SECRET, { now: () => Date.now() - TICKET_TTL_MS - 1 })
  got = await raw(host.base, '/taskwatch?t=' + stale)
  assert.equal(got.status, 401)

  // 3) 篡改票走真实 handler：必须 401，而不是回落到 Map 被放行。
  const hostParts = hostTicket.split('.')
  hostParts[2] = (hostParts[2][0] === 'A' ? 'B' : 'A') + hostParts[2].slice(1)
  got = await raw(host.base, '/taskwatch?t=' + hostParts.join('.'))
  assert.equal(got.status, 401)

  // 5) 老格式随机票：同进程 Map 内仍可用；未知随机串不会被当作本票。
  const legacy = createTicketStore()
  const oldTicket = legacy.mint()
  assert.equal(createTicketGate({ secret: SECRET, store: legacy }).redeem(oldTicket), true,
    '老格式随机票应继续走原 Map 路径')
  got = await raw(host.base, '/taskwatch?t=' + createTicketStore().mint())
  assert.equal(got.status, 401, '未知老票不应因"形状"被放行')

  // 2) 中继签发 → 宿主校验（下面中继起来后填入）。
  let relayTicket = ''

  // ── 中继实例：真实 spawn，临时端口，不碰 3099 ────────────────────────────
  let relay = null
  try {
    if (!HAS_RELAY) {
      console.log('SKIP 中继实例不在本机（' + RELAY_FILE + '），跨实例两条只做本机验签')
      assert.equal(verifyTicket(SECRET, hostTicket), true)
    } else {
      relay = await startRelay()

      // 1) 宿主签的票 → 中继实例兑换：302 + Set-Cookie。
      let atRelay = await raw(relay.base, '/taskwatch?t=' + hostTicket)
      assert.equal(atRelay.status, 302, '中继应认宿主签发的 v2 票')
      assert.equal(atRelay.headers.get('location'), '/taskwatch')
      assert.match(String(atRelay.headers.get('set-cookie')), /tw=/)

      // 2) 中继签的票 → 宿主兑换。
      let minted = await postJson(relay.base, '/taskwatch/ticket', { to: 'remote' }, {
        authorization: 'Bearer check-ticket-token',
      })
      assert.equal(minted.status, 200, '中继 ticket 接口应可用（带临时令牌）')
      relayTicket = minted.body.url.split('?t=')[1]
      assert.match(relayTicket, /^v2\./)
      const atHost = await raw(host.base, '/taskwatch?t=' + relayTicket)
      assert.equal(atHost.status, 302, '宿主应认中继签发的 v2 票')
      assert.match(String(atHost.headers.get('set-cookie')), /tw-route=/)

      // 同一张中继票在宿主上重放：进程内 nonce 去重应拒绝（best-effort）。
      const replayed = await raw(host.base, '/taskwatch?t=' + relayTicket)
      assert.equal(replayed.status, 401, '同一进程内重放应被 nonce 去重拦住')
    }
  } finally {
    if (relay) await relay.stop()
    host.server.close()
  }
}

// ── 6) 密钥文件：没有 env / 文件时自动生成并收紧权限 ──────────────────────
{
  const home = mkdtempSync(join(tmpdir(), 'tw-ticket-secret-'))
  // 只为 icacls 提供一个用户名；密钥本身仍然"没有环境变量、没有文件"。
  const baseEnv = { USERNAME: process.env.USERNAME || process.env.USER || '' }
  try {
    const first = loadTicketSecret({ env: baseEnv, home, platform: process.platform })
    assert.equal(first.source, 'generated', '没有密钥时应自动生成')
    const file = join(home, '.dsh', 'taskwatch-ticket.key')
    assert.equal(first.file, file)
    assert.ok(existsSync(file), '密钥文件应落在 <home>/.dsh/ 下')
    const text = readFileSync(file, 'utf8').trim()
    // 只断言长度，绝不打印内容。
    assert.ok(text.length >= 32, '密钥长度至少 32')
    assert.equal(text, first.secret)
    assert.ok(['icacls-owner', 'icacls-failed', 'chmod-600'].includes(first.permission),
      '应尝试收紧权限，实际：' + first.permission)

    // 第二次读取应复用同一份，而不是重新生成。
    const second = loadTicketSecret({ env: baseEnv, home, platform: process.platform })
    assert.equal(second.source, 'file')
    assert.equal(second.secret, first.secret)

    // 环境变量优先，且不落盘。
    const envOnly = loadTicketSecret({ env: { TASKWATCH_TICKET_SECRET: 'e'.repeat(40) }, home })
    assert.equal(envOnly.source, 'env')
    assert.equal(envOnly.file, '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('ticket HMAC cross-process checks passed'
  + (HAS_RELAY ? '（含真实中继实例）' : '（中继实例 SKIP）'))
