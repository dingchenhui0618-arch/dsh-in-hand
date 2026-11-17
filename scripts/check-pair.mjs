#!/usr/bin/env node
/**
 * 手机配对面板的契约自检（v1.9.0）。
 *
 * 这一版要证明的不是"面板上有个二维码"，而是**二维码里那串东西真的能换进一台手机**：
 *
 *   1. 中继在线时，入口清单报出它当前的局域网地址（不是配置里那条可能过期的）；
 *   2. 签出来的票是 v3、受众 remote、60 秒 —— 用 ticket.js 自己验一遍，
 *      而且拿同一张票按 aud=lan 验必须失败（跨入口重放是 v1.8.6 修过的洞）；
 *   3. 返回的 SVG 画的**就是**这条 URL（和 qrSvg(url) 逐字节相同，不是"随便一张码"）；
 *   4. 6 位码走中继的取码端点，且只能从 127.0.0.1 取（中继的信任根）；
 *   5. 中继没在跑 / 只监听回环 / 没配任何入口，三种情况都给出明确原因，不装成功；
 *   6. 两条写路由的门禁（POST + 同源 + application/json）一条不少；
 *   7. 面板整组路由都在设备闸门后面（撤销后 401），不是后门。
 *
 * 走真实 node:http 与真实路由处理函数，中继用假实现（本机随机端口，不联网）。
 * 不碰真实 ~/.dsh：票据密钥走环境变量，审计写临时目录。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TASKWATCH_TICKET_SECRET = 'check-pair-' + 'k'.repeat(48)
const AUDIT_HOME = mkdtempSync(join(tmpdir(), 'tw-pair-audit-'))
process.env.DSH_HOME = AUDIT_HOME

const { apply } = await import('../lib/index.js')
const { TICKET_RE, verifyTicket } = await import('../lib/ticket.js')
const { qrSvg } = await import('../lib/qr.js')

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}
function section(title) { console.log('\n' + title) }

// ── 假中继：只实现面板真正会打的两个端点 + 一份 lan.json ────────────────────
async function startRelay(options = {}) {
  const state = {
    lanMode: options.lanMode !== false,
    port: 0,
    entries: [],
    ticketVersions: options.ticketVersions || [3, 2],
    code: options.code || '482913',
    mintFails: Boolean(options.mintFails),
    seen: [],
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    state.seen.push({
      path: url.pathname,
      method: req.method,
      xff: String(req.headers['x-forwarded-for'] || ''),
      remote: String((req.socket && req.socket.remoteAddress) || ''),
    })
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(value))
    }
    if (url.pathname === '/taskwatch/lan.json') {
      json(200, {
        lanMode: state.lanMode,
        bind: state.lanMode ? '0.0.0.0' : '127.0.0.1',
        port: state.port,
        publicUrl: 'https://dsh.example.com',
        markerFile: '.lan',
        addresses: [{ iface: 'WLAN', ip: '192.168.1.5' }],
        entries: state.entries,
        ticketVersions: state.ticketVersions,
        ticketAudience: 'remote',
      })
      return
    }
    if (url.pathname === '/taskwatch/pair/new') {
      if (state.mintFails) { json(403, { ok: false, error: '只能在本机取码' }); return }
      json(200, { ok: true, code: state.code, expiresAt: Date.now() + 120000, ttlSec: 120 })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no such route')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  state.port = server.address().port
  state.entries = state.lanMode ? ['http://192.168.1.5:' + state.port + '/taskwatch'] : []
  return { state, server, origin: 'http://127.0.0.1:' + state.port }
}

// ── 宿主外壳：同一份 apply，假 webServer ────────────────────────────────────
function makeHost(config) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register(spec) { routes.set(spec.path, spec.handler) } }
      return undefined
    },
    effect(fn) { return fn() },
    on() { return function () {} },
  }
  apply(ctx, config)
  return routes
}

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!handler) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
    Promise.resolve(handler(req, res)).catch((error) => {
      try { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(error && error.message ? error.message : error)) } catch { /* 已断开 */ }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: 'http://127.0.0.1:' + server.address().port }
}

function makeJar() { return { cookie: '' } }

async function call(base, jar, path, init = {}) {
  const headers = Object.assign({}, init.headers || {})
  if (jar && jar.cookie) headers.cookie = jar.cookie
  const response = await fetch(base + path, { redirect: 'manual', ...init, headers })
  const text = await response.text()
  const lines = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  for (const line of lines) {
    const first = String(line).split(';')[0]
    const eq = first.indexOf('=')
    if (eq > 0 && jar) jar.cookie = first
  }
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { status: response.status, headers: response.headers, text, body }
}

const postJson = (base, jar, path, value, extra = {}) => call(base, jar, path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, extra.headers || {}),
  body: JSON.stringify(value === undefined ? {} : value),
})

// ═════════════════════════════════════════════════════════════════════════
// 1–4. 中继在线：入口清单 / 签票 / 二维码 / 6 位码
// ═════════════════════════════════════════════════════════════════════════
const relay = await startRelay()
const host = await serve(makeHost({ lanUrl: relay.origin, publicUrl: 'https://dsh.example.com' }))
const jar = makeJar()
try {
  section('[1] 中继在线：入口清单与配置诊断')
  const info = await call(host.base, jar, '/taskwatch/pair/info')
  check('pair/info 200', info.status === 200, 'status=' + info.status)
  const targets = (info.body && info.body.targets) || []
  const lan = targets.find((t) => t.kind === 'lan')
  const remote = targets.find((t) => t.kind === 'remote')
  check('报出「同一 Wi-Fi」入口且可用', Boolean(lan) && lan.ok === true, JSON.stringify(lan))
  check('中继报的地址优先于配置（用的是当前那条）',
    lan && lan.url === 'http://192.168.1.5:' + relay.state.port + '/taskwatch', lan && lan.url)
  check('报出「公网」入口（配了 publicUrl）', Boolean(remote) && remote.ok === true
    && remote.url === 'https://dsh.example.com/taskwatch', JSON.stringify(remote))
  check('relay 段说清它活着、开了局域网模式、认哪几版票',
    info.body && info.body.relay && info.body.relay.alive === true
      && info.body.relay.lanMode === true
      && JSON.stringify(info.body.relay.ticketVersions) === '[3,2]',
    JSON.stringify(info.body && info.body.relay))
  check('只回「能不能取码」，不回码本身',
    info.body && info.body.relay && info.body.relay.codeSource === 'relay'
      && info.text.indexOf('482913') < 0, info.text && info.text.slice(0, 160))
  check('回环配置不报「配置过期」（只有真的不是本机地址才报）',
    info.body && info.body.config && info.body.config.lanUrlStale === false,
    JSON.stringify(info.body && info.body.config))
  check('设备列表把发起方标成本机',
    info.body && info.body.devices && info.body.devices.length === 1
      && info.body.devices[0].current === true, JSON.stringify(info.body && info.body.devices))

  section('[2] 签票：v3 / 受众 remote / 60 秒 / 一次性')
  const link = await postJson(host.base, jar, '/taskwatch/pair/link', { to: 'lan' })
  check('pair/link 200', link.status === 200 && link.body && link.body.ok === true,
    link.status + ' ' + (link.text || '').slice(0, 160))
  const url = (link.body && link.body.url) || ''
  const ticket = url.indexOf('?t=') >= 0 ? url.slice(url.indexOf('?t=') + 3) : ''
  check('URL 就是中继入口 + ?t=', url === 'http://192.168.1.5:' + relay.state.port + '/taskwatch?t=' + ticket, url)
  check('票是 v3 形状', TICKET_RE.test(ticket), ticket)
  const verified = verifyTicket(process.env.TASKWATCH_TICKET_SECRET, ticket, { aud: 'remote' })
  check('按受众 remote 验签通过（中继是兑现方）', verified === true, String(verified))
  const asLan = verifyTicket(process.env.TASKWATCH_TICKET_SECRET, ticket, { aud: 'lan' })
  check('按受众 lan 验签必须失败（跨入口重放）', asLan === false, String(asLan))
  const left = link.body && link.body.expiresAt ? link.body.expiresAt - Date.now() : 0
  check('寿命是 60 秒那条（±5 秒）', left > 50000 && left <= 60000, String(left))
  check('说明白了票的版本与入口', link.body && link.body.ticketVersion === 3 && link.body.kind === 'lan',
    JSON.stringify({ v: link.body && link.body.ticketVersion, k: link.body && link.body.kind }))

  section('[3] 二维码：画的就是这条 URL')
  const svg = (link.body && link.body.svg) || ''
  check('回的是 SVG，不是让页面自己画', svg.slice(0, 4) === '<svg' && svg.slice(-6) === '</svg>', svg.slice(0, 40))
  check('与 qrSvg(url) 逐字节相同（没有"码和链接对不上"）',
    svg === qrSvg(url, { size: 240, label: '手机扫码配对' }), '长度 ' + svg.length)
  const box = /<svg[^>]*width="(\d+)" height="(\d+)"/.exec(svg)
  check('正方形、整数像素、不超过 240', Boolean(box) && box[1] === box[2]
    && Number(box[1]) <= 240 && Number(box[1]) >= 160, box ? box.slice(1).join('x') : 'no box')
  check('白底（深色主题下也能扫）', svg.indexOf('fill="#ffffff"') > 0)
  check('没有小数坐标（缩放会糊）', !/d="[^"]*\./.test(svg) && !/width="[^"]*\./.test(svg))
  check('带 aria-label', svg.indexOf('aria-label="手机扫码配对"') > 0)
  const again = await postJson(host.base, jar, '/taskwatch/pair/link', { to: 'lan' })
  check('每次签的票都不同（nonce）', again.body && again.body.url !== url,
    (again.body && again.body.url) === url ? '两张票一样' : '')

  section('[4] 6 位码：只能从本机取')
  relay.state.seen.length = 0
  const code = await postJson(host.base, jar, '/taskwatch/pair/code', {})
  check('pair/code 200 且带回 6 位码', code.status === 200 && code.body
    && code.body.ok === true && code.body.code === '482913', code.status + ' ' + (code.text || '').slice(0, 120))
  const minted = relay.state.seen.filter((s) => s.path === '/taskwatch/pair/new')
  check('确实打到了中继的取码端点', minted.length === 1, '次数 ' + minted.length)
  check('从 127.0.0.1 打过去、且没有代理头（中继按这个判本机）',
    minted.length === 1 && minted[0].remote === '127.0.0.1' && minted[0].xff === '',
    JSON.stringify(minted[0]))
  check('回里带有效期（面板要倒计时）', code.body && code.body.expiresAt - Date.now() > 60000
    && code.body.ttlSec === 120, JSON.stringify({ expiresAt: code.body && code.body.expiresAt, ttlSec: code.body && code.body.ttlSec }))

  relay.state.mintFails = true
  const denied = await postJson(host.base, jar, '/taskwatch/pair/code', {})
  check('中继拒绝取码时如实回 502，不假装成功',
    denied.status === 502 && denied.body && denied.body.ok === false
      && /中继/.test(String(denied.body.error)), denied.status + ' ' + (denied.text || '').slice(0, 120))
  relay.state.mintFails = false

  section('[5] 写路由的门禁（POST + 同源 + application/json）')
  const bare = await call(host.base, jar, '/taskwatch/pair/link')
  check('GET 拒绝（405）', bare.status === 405, 'status=' + bare.status)
  const form = await call(host.base, jar, '/taskwatch/pair/link', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'to=lan',
  })
  check('表单 content-type 拒绝（415）', form.status === 415, 'status=' + form.status)
  const cross = await postJson(host.base, jar, '/taskwatch/pair/link', { to: 'lan' }, {
    headers: { origin: 'https://evil.example' },
  })
  check('跨站 Origin 拒绝（403）', cross.status === 403, 'status=' + cross.status)
  const junk = await call(host.base, jar, '/taskwatch/pair/link', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
  })
  check('坏 JSON 拒绝（400）', junk.status === 400, 'status=' + junk.status)

  section('[6] 面板整组路由都在设备闸门后面')
  const mine = await call(host.base, jar, '/taskwatch/pair/info')
  const digest = (mine.body && mine.body.current) || ''
  const revoked = await postJson(host.base, jar, '/taskwatch/devices/revoke', { deviceId: digest })
  check('撤销自己 200 且 self=true', revoked.status === 200 && revoked.body
    && revoked.body.self === true, JSON.stringify(revoked.body))
  const after = await call(host.base, jar, '/taskwatch/pair/info')
  check('撤销后 pair/info 401（不是后门）', after.status === 401
    && after.body && after.body.revoked === true, after.status + ' ' + (after.text || '').slice(0, 80))
  const afterLink = await postJson(host.base, jar, '/taskwatch/pair/link', { to: 'lan' })
  check('撤销后 pair/link 也 401', afterLink.status === 401, 'status=' + afterLink.status)
} finally {
  host.server.close()
  relay.server.close()
}

// ═════════════════════════════════════════════════════════════════════════
// 7. 中继只监听回环（缺 .lan）：入口列出来，但必须说"连不上"
// ═════════════════════════════════════════════════════════════════════════
const loopbackRelay = await startRelay({ lanMode: false })
const loopHost = await serve(makeHost({ lanUrl: loopbackRelay.origin }))
try {
  section('[7] 中继没开局域网模式：不能假装能连')
  const jar2 = makeJar()
  const info = await call(loopHost.base, jar2, '/taskwatch/pair/info')
  const lan = ((info.body && info.body.targets) || []).find((t) => t.kind === 'lan')
  check('入口仍然列出来（用户要看得见它）', Boolean(lan), JSON.stringify(info.body && info.body.targets))
  check('但 ok=false 且原因指向 .lan',
    lan && lan.ok === false && /\.lan/.test(String(lan.why)), JSON.stringify(lan))
  const link = await postJson(loopHost.base, jar2, '/taskwatch/pair/link', { to: 'lan' })
  check('签票被明确拒绝（409 + entry-unreachable）',
    link.status === 409 && link.body && link.body.code === 'entry-unreachable',
    link.status + ' ' + (link.text || '').slice(0, 140))
} finally {
  loopHost.server.close()
  loopbackRelay.server.close()
}

// ═════════════════════════════════════════════════════════════════════════
// 8. 中继没在跑：公网那条仍然可用，局域网那条如实报错
// ═════════════════════════════════════════════════════════════════════════
const deadPort = await new Promise((resolve) => {
  const probe = http.createServer(() => {})
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port
    probe.close(() => resolve(port))
  })
})
const offHost = await serve(makeHost({ lanUrl: 'http://127.0.0.1:' + deadPort, publicUrl: 'https://dsh.example.com' }))
try {
  section('[8] 中继没在跑：局域网入口报错，公网入口照常')
  const jar3 = makeJar()
  const info = await call(offHost.base, jar3, '/taskwatch/pair/info')
  check('relay.alive=false，且带得走的原因', info.body && info.body.relay
    && info.body.relay.alive === false && Boolean(info.body.relay.error), JSON.stringify(info.body && info.body.relay))
  const lan = ((info.body && info.body.targets) || []).find((t) => t.kind === 'lan')
  const remote = ((info.body && info.body.targets) || []).find((t) => t.kind === 'remote')
  check('局域网那条 ok=false 且说"中继没在跑"',
    lan && lan.ok === false && /中继/.test(String(lan.why)), JSON.stringify(lan))
  check('公网那条仍然 ok=true', remote && remote.ok === true, JSON.stringify(remote))
  const linkLan = await postJson(offHost.base, jar3, '/taskwatch/pair/link', { to: 'lan' })
  check('lan 签票 409', linkLan.status === 409
    && linkLan.body && linkLan.body.code === 'entry-unreachable', linkLan.status + ' ' + (linkLan.text || '').slice(0, 140))
  const linkRemote = await postJson(offHost.base, jar3, '/taskwatch/pair/link', { to: 'remote' })
  check('remote 签票 200 且指向公网入口', linkRemote.status === 200
    && String(linkRemote.body && linkRemote.body.url).indexOf('https://dsh.example.com/taskwatch?t=') === 0,
  linkRemote.status + ' ' + (linkRemote.text || '').slice(0, 140))
  const remoteTicket = String((linkRemote.body && linkRemote.body.url) || '').split('?t=')[1] || ''
  const remoteOk = verifyTicket(process.env.TASKWATCH_TICKET_SECRET, remoteTicket, { aud: 'remote' })
  check('公网票同样按 remote 受众验得过', remoteOk === true, String(remoteOk))
  const codeOff = await postJson(offHost.base, jar3, '/taskwatch/pair/code', {})
  check('取码 409 no-relay（不编一个码出来）', codeOff.status === 409
    && codeOff.body && codeOff.body.code === 'no-relay', codeOff.status + ' ' + (codeOff.text || '').slice(0, 120))
} finally {
  offHost.server.close()
}

// ═════════════════════════════════════════════════════════════════════════
// 9. 什么都没配：形状仍然一致（不因为环境不同就换一套契约）
// ═════════════════════════════════════════════════════════════════════════
const bareHost = await serve(makeHost({}))
try {
  section('[9] 没配任何入口：仍然是同一份契约')
  const jar4 = makeJar()
  const info = await call(bareHost.base, jar4, '/taskwatch/pair/info')
  check('pair/info 200 且形状完整', info.status === 200 && info.body
    && Array.isArray(info.body.targets) && typeof info.body.relay === 'object'
    && Array.isArray(info.body.devices), info.status + ' ' + (info.text || '').slice(0, 120))
  check('没有公网入口时 targets 里没有 remote',
    ((info.body && info.body.targets) || []).every((t) => t.kind !== 'remote'),
    JSON.stringify(info.body && info.body.targets))
  const link = await postJson(bareHost.base, jar4, '/taskwatch/pair/link', { to: 'remote' })
  check('没配 publicUrl 时签公网票 409 且说明原因', link.status === 409
    && link.body && /publicUrl/.test(String(link.body.error)), link.status + ' ' + (link.text || '').slice(0, 140))
} finally {
  bareHost.server.close()
}

try { rmSync(AUDIT_HOME, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }

console.log(`\n手机配对面板：${passed} 通过 / ${failed} 失败`)
if (failed) process.exitCode = 1
assert.ok(true)
