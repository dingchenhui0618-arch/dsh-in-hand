#!/usr/bin/env node
/**
 * 双入口路由契约测试（GET /taskwatch/entries、POST /taskwatch/ticket）。
 *
 * 走真实的 node:http 服务与真实路由处理函数，只把 DSH 服务换成假实现 ——
 * 不联网、不碰真实会话、不写任何文件。
 *
 * 为什么要有这份测试：v1.7.0 的真实故障是「页面点去远端就一直报错」，根因就是这两条
 * 路由**只有中继实现**、宿主没有。所以这里钉住的正是当时缺的那几条：
 *   - 入口清单的两种形态：配了 publicUrl（远端 + 局域网）/ 没配（只有局域网）
 *   - ticket 的 60 秒、一次性、用后即焚（重放无效）
 *   - 没配 publicUrl 时明确的 409 no-public-entry，而不是 500 或空 url
 *   - 写路由的门禁：POST + application/json + 同源（跨站表单打不进来）
 *   - 兑换路径：命中 302 + Set-Cookie，未知/过期 401（与中继一致）
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  apply, createTicketStore, lanAddresses, name, normalizePublicUrl, TICKET_TTL_MS,
} from '../lib/index.js'

// ── 纯函数：公网地址归一化 ─────────────────────────────────────────────────
assert.equal(normalizePublicUrl('https://dsh.example.com'), 'https://dsh.example.com')
assert.equal(normalizePublicUrl('  https://dsh.example.com/  '), 'https://dsh.example.com')
assert.equal(normalizePublicUrl('http://192.168.1.5:52676'), 'http://192.168.1.5:52676')
// 子路径与非常规协议一律当作没配：302 的 Location 是根绝对路径，带前缀会跳错地方。
assert.equal(normalizePublicUrl('https://dsh.example.com/dsh'), '')
assert.equal(normalizePublicUrl('javascript:alert(1)'), '')
assert.equal(normalizePublicUrl('not a url'), '')
assert.equal(normalizePublicUrl(''), '')
assert.equal(normalizePublicUrl(undefined), '')

// ── 纯函数：票据存储的过期语义 ─────────────────────────────────────────────
{
  let clock = 1000
  const store = createTicketStore({ ttlMs: 60 * 1000, now: () => clock })
  const ticket = store.mint()
  assert.ok(ticket.length >= 16)
  assert.equal(store.size, 1)
  clock += 1000
  assert.equal(store.redeem(ticket), true, '60 秒内应可用')
  assert.equal(store.size, 0, '兑换后立刻删除')
  assert.equal(store.redeem(ticket), false, '同一张票据不能重放')

  const stale = store.mint()
  clock += 60 * 1000 + 1
  assert.equal(store.redeem(stale), false, '过期票据无效')
  assert.equal(store.size, 0, '过期票据同样被删掉，不会堆在内存里')
}
assert.equal(TICKET_TTL_MS, 60 * 1000, '票据有效期必须是 60 秒')

// ── 真实 HTTP：每个实例一套假 webServer ────────────────────────────────────
function makeInstance(config) {
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
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function raw(base, path, init = {}) {
  // redirect:'manual'：302 兑换路径必须看到**原样的 302**，不能被 fetch 自动跟走。
  const response = await fetch(base + path, { redirect: 'manual', ...init })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { status: response.status, headers: response.headers, text, body }
}

const PORT = (base) => Number(/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(base)[1])
const postJson = (base, path, value, headers = {}) => raw(base, path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(value),
})

// ══════════════════════════════════════════════════════════════════════════
// 实例 A：没配 publicUrl → 只报局域网，远端请求 409 no-public-entry
// ══════════════════════════════════════════════════════════════════════════
{
  const { server, base } = await serve(makeInstance({}))
  const lan = lanAddresses()

  let got = await raw(base, '/taskwatch/entries')
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.remote, '', '没配 publicUrl 时 remote 必须为空')
  assert.equal(got.body.current, 'lan')
  assert.ok(Array.isArray(got.body.entries))
  assert.equal(got.body.entries.length, lan.length, '入口数应等于局域网地址数')
  assert.ok(got.body.entries.every((e) => e.kind === 'lan'), '不应凭空多出远端入口')
  for (const e of got.body.entries) {
    assert.equal(typeof e.label, 'string')
    assert.match(e.url, new RegExp('^http://[0-9.]+:' + PORT(base) + '/taskwatch$'))
    assert.equal(typeof e.current, 'boolean')
  }
  // 每条地址都能在 lanAddresses() 里找到，且顺序一致。
  assert.deepEqual(got.body.entries.map((e) => e.url), lan.map(
    (a) => 'http://' + a.ip + ':' + PORT(base) + '/taskwatch'))
  assert.equal(got.body.entries.filter((e) => e.current).length, lan.length ? 1 : 0)

  got = await postJson(base, '/taskwatch/ticket', { to: 'remote' })
  assert.equal(got.status, 409)
  assert.equal(got.body.ok, false)
  assert.equal(got.body.code, 'no-public-entry')
  assert.match(got.body.error, /publicUrl/, '错误里要说清该配什么')

  // 用一个"刚生成的"票据去兑换也必须是 401：远端票据根本没签发。
  got = await raw(base, '/taskwatch?t=fake-ticket')
  assert.equal(got.status, 401)
  assert.match(got.text, /换路凭据无效或已过期/)

  server.close()
}

// ══════════════════════════════════════════════════════════════════════════
// 实例 B：配了 publicUrl → 远端 + 局域网，票据 60 秒一次性
// ══════════════════════════════════════════════════════════════════════════
{
  const PUBLIC = 'https://dsh.example.com'
  const { server, base } = await serve(makeInstance({ publicUrl: PUBLIC + '/' }))
  const lan = lanAddresses()
  const port = PORT(base)

  let got = await raw(base, '/taskwatch/entries')
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.remote, PUBLIC, '尾部斜杠要被归一化掉')
  assert.equal(got.body.current, 'lan', '从回环 / 局域网访问时当前路径是局域网')
  assert.equal(got.body.entries[0].kind, 'remote')
  assert.equal(got.body.entries[0].url, PUBLIC + '/taskwatch')
  assert.equal(got.body.entries[0].current, false)
  assert.equal(got.body.entries.length, 1 + lan.length)
  assert.deepEqual(got.body.lan, lan.map((a) => 'http://' + a.ip + ':' + port + '/taskwatch'))
  assert.equal(got.body.entries.filter((e) => e.current).length, lan.length ? 1 : 0)

  // 方法 / content-type 门禁：和宿主其它写路由同一套。
  got = await raw(base, '/taskwatch/ticket')
  assert.equal(got.status, 405)
  assert.equal(got.headers.get('allow'), 'POST')
  got = await raw(base, '/taskwatch/entries', { method: 'POST' })
  assert.equal(got.status, 405)
  got = await raw(base, '/taskwatch/ticket', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
  })
  assert.equal(got.status, 415)

  // 跨站门禁：显式 cross-site、以及 Origin 与 Host 不同源，都必须 403。
  got = await postJson(base, '/taskwatch/ticket', { to: 'remote' }, { origin: 'https://evil.example' })
  assert.equal(got.status, 403)
  assert.equal(got.body.code, 'cross-site')
  got = await postJson(base, '/taskwatch/ticket', { to: 'remote' }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(got.status, 403)
  // 同源（页面自己 fetch）必须放行。
  got = await postJson(base, '/taskwatch/ticket', { to: 'remote' }, { origin: base })
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.to, 'remote')
  assert.equal(got.body.expiresInMs, TICKET_TTL_MS)
  assert.match(got.body.url, new RegExp('^' + PUBLIC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/taskwatch\\?t=[A-Za-z0-9_-]{16,}$'))

  const ticket = got.body.url.split('?t=')[1]
  // 票价兑换：302 到 /taskwatch + Set-Cookie，跟中继一致。
  let redeemed = await raw(base, '/taskwatch?t=' + ticket)
  assert.equal(redeemed.status, 302)
  assert.equal(redeemed.headers.get('location'), '/taskwatch')
  assert.match(String(redeemed.headers.get('set-cookie')), /tw-route=remote/)
  assert.equal(redeemed.headers.get('cache-control'), 'no-store')
  // 一次性：重放立刻 401。
  redeemed = await raw(base, '/taskwatch?t=' + ticket)
  assert.equal(redeemed.status, 401)
  // 未知票据同样 401。
  redeemed = await raw(base, '/taskwatch?t=nope')
  assert.equal(redeemed.status, 401)

  // 没有 t 时仍然是正常页面（不是 302，也不是 401）。
  got = await raw(base, '/taskwatch')
  assert.equal(got.status, 200)
  assert.match(got.text, /<title>掌上 DSH<\/title>/)

  // 局域网票据：URL 用请求的端口（不写死 52676），兑换同样可用。
  got = await postJson(base, '/taskwatch/ticket', { to: 'lan' })
  if (lan.length) {
    assert.equal(got.status, 200)
    assert.equal(got.body.to, 'lan')
    assert.match(got.body.url, new RegExp('^http://[0-9.]+:' + port + '/taskwatch\\?t='))
    const lanTicket = got.body.url.split('?t=')[1]
    const hop = await raw(base, '/taskwatch?t=' + lanTicket)
    assert.equal(hop.status, 302)
  } else {
    assert.equal(got.status, 409)
    assert.equal(got.body.code, 'no-lan-entry')
  }

  // 空 body / 未知 to 走默认的局域网，不会误签发远端票据。
  got = await postJson(base, '/taskwatch/ticket', {})
  assert.equal(got.body.to, lan.length ? 'lan' : got.body.to)

  // 两个实例的票据互不共享（票据只活在签发它的那个进程里）。
  const store = createTicketStore()
  const t2 = store.mint()
  got = await raw(base, '/taskwatch?t=' + t2)
  assert.equal(got.status, 401)

  server.close()
}

// ══════════════════════════════════════════════════════════════════════════
// 实例 C：环境变量兜底（配置项仍然优先）
// ══════════════════════════════════════════════════════════════════════════
{
  process.env.DSH_TASKWATCH_PUBLIC_URL = 'https://env.example'
  const { server, base } = await serve(makeInstance({}))
  const got = await raw(base, '/taskwatch/entries')
  assert.equal(got.body.remote, 'https://env.example')
  delete process.env.DSH_TASKWATCH_PUBLIC_URL
  server.close()
}

assert.equal(name, 'dsh-in-hand')
console.log('entries / ticket route checks passed')
