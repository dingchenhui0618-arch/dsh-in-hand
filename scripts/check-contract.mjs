#!/usr/bin/env node
/**
 * 票据入口契约自检（v1.7.3）。
 *
 * 两件事，都是真实故障换来的：
 *
 *  1. **字段名对齐**：页面 `fetch('/taskwatch/ticket')` 发的是 `{to: ...}`，服务端读的是
 *     `body.to`。这两处一旦漂移，接口会 200 但签错方向的票（或干脆 400），而页面只表现为
 *     "点了去远端没反应"。这里直接读两个源文件把字段名钉死 —— 改任何一边都会先红。
 *
 *  2. **lanUrl 的写法**：v1.7.3 之前 `normalizeLanUrl` 只收纯 origin，最自然会写的
 *     `http://10.0.51.18:3099/taskwatch` 被静默丢弃，回落到自动探测的内网 IP ——
 *     用户看到的就是"配了 lanUrl 却没生效"。这里钉住两种写法等价、其它路径无效，
 *     并用真实 HTTP 验证条目与票据 URL 只拼一次 `/taskwatch`。
 *
 * 走真实的 node:http 与真实路由处理函数，只把 DSH 服务换成假实现；不联网、不碰会话。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { apply, normalizeLanUrl } from '../lib/index.js'

// 固定密钥：不读写真实 ~/.dsh，也让断言能预期 v2 票的形状。
process.env.TASKWATCH_TICKET_SECRET = 'check-contract-' + 'k'.repeat(40)

// ── 1. 页面 ↔ 服务端的字段名 ──────────────────────────────────────────────
const page = readFileSync(new URL('../lib/page.html', import.meta.url), 'utf8')
const server = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
assert.match(
  page,
  /fetch\('\/taskwatch\/ticket',\s*\{[\s\S]{0,400}?body:\s*JSON\.stringify\(\{\s*to:/,
  '页面必须发 {to: ...}（服务端按 to 读）',
)
assert.match(server, /asText\(body\.to\)\s*===\s*'remote'/, '服务端必须读 body.to')
// 顺便确认页面没有第二套字段名：ticket 接口只有这一处调用。
assert.equal((page.match(/\/taskwatch\/ticket/g) || []).length, 1, '页面只应有一处 ticket 调用')

// ── 2. normalizeLanUrl：纯 origin / 带入口后缀等价，其它路径无效 ──────────
assert.equal(normalizeLanUrl('http://10.0.51.18:3099'), 'http://10.0.51.18:3099')
assert.equal(normalizeLanUrl('http://10.0.51.18:3099/'), 'http://10.0.51.18:3099')
assert.equal(normalizeLanUrl('  http://10.0.51.18:3099/taskwatch  '), 'http://10.0.51.18:3099')
assert.equal(normalizeLanUrl('http://10.0.51.18:3099/taskwatch/'), 'http://10.0.51.18:3099')
assert.equal(normalizeLanUrl('https://relay.example.com/taskwatch'), 'https://relay.example.com')
// 只认入口自己的那个后缀；别的路径仍然是没配（否则 302 / 清单会对不上）。
assert.equal(normalizeLanUrl('http://10.0.51.18:3099/dsh'), '')
assert.equal(normalizeLanUrl('http://10.0.51.18:3099/taskwatch/taskwatch'), '')
assert.equal(normalizeLanUrl('javascript:alert(1)'), '')
assert.equal(normalizeLanUrl(''), '')
assert.equal(normalizeLanUrl(undefined), '')

// ── 3. 真实 HTTP：带 /taskwatch 的 lanUrl 只拼一次后缀 ────────────────────
function makeInstance(config) {
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
  const response = await fetch(base + path, { redirect: 'manual', ...init })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { status: response.status, headers: response.headers, text, body }
}

const postJson = (base, value) => raw(base, '/taskwatch/ticket', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
})

const PUBLIC = 'https://dsh.example.com'
const LAN_ORIGIN = 'http://10.0.51.18:3099'
const LAN_ENTRY = LAN_ORIGIN + '/taskwatch'

{
  // 刻意用**用户实际会写的**带路径形态，验证它不再被丢掉。
  const { server, base } = await serve(makeInstance({ publicUrl: PUBLIC, lanUrl: LAN_ENTRY }))

  let got = await raw(base, '/taskwatch/entries')
  assert.equal(got.status, 200)
  assert.deepEqual(got.body.lan, [LAN_ENTRY], 'lanUrl 的 /taskwatch 后缀要被吃掉，只拼一次')
  const lanEntry = got.body.entries.find((e) => e.kind === 'lan')
  assert.equal(lanEntry.url, LAN_ENTRY)
  assert.equal(lanEntry.label, '局域网 · 中继')
  assert.equal(lanEntry.current, true)
  // 公网条目不受影响，且不会跟着多拼一次。
  const remoteEntry = got.body.entries.find((e) => e.kind === 'remote')
  assert.equal(remoteEntry.url, PUBLIC + '/taskwatch')

  got = await postJson(base, { to: 'lan' })
  assert.equal(got.status, 200)
  assert.equal(got.body.to, 'lan')
  assert.equal(got.body.address, '10.0.51.18')
  assert.match(got.body.url, new RegExp('^' + LAN_ENTRY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '\\?t=v2\\.\\d{13}\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{20,}$'))
  assert.equal(got.body.url.split('/taskwatch').length - 1, 1, '路径里只有一个 /taskwatch')

  got = await postJson(base, { to: 'remote' })
  assert.equal(got.status, 200)
  assert.match(got.body.url, /^https:\/\/dsh\.example\.com\/taskwatch\?t=v2\./)

  // 未知 / 缺省的 to 走局域网，绝不误签远端票。
  got = await postJson(base, { to: 'nonsense' })
  assert.equal(got.body.to, 'lan')
  got = await postJson(base, {})
  assert.equal(got.body.to, 'lan')

  server.close()
}

console.log('ticket contract / lanUrl checks passed')
