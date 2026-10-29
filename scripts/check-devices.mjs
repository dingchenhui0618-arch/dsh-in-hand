#!/usr/bin/env node
/**
 * 设备列表与撤销（P4，v1.8.7）的行为自检。
 *
 * 这一版要证明的不是"页面上有个按钮"，而是**身份 / 账本 / 撤销**三件事真的成立：
 *
 *   1. 首次访问下发 twd cookie，且带 HttpOnly + SameSite=Lax；
 *   2. 两台模拟客户端 → 列表两条、lastSeen 正确、当前设备被标记；
 *   3. 撤销其中一台 → 它下一次请求 401，另一台仍然 200；
 *   4. 撤销**自己** → 本端 401，且响应体带 revoked:true（页面据此显示重配对）；
 *   5. 账本容量 50：注入 51 台时淘汰最久未活跃的未撤销设备；
 *   6. 30 天未活跃自动清理（注入时间，不真等 30 天）；
 *   7. 账本字段集合固定，且不含 IP、不含完整 UA。
 *
 * 走真实 node:http 与真实路由处理函数，只把 DSH 服务换成假实现；
 * 不联网、不碰真实 ~/.dsh（票据密钥走环境变量）。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  createDeviceLedger,
  DEVICE_LEDGER_MAX,
  DEVICE_RECORD_FIELDS,
  DEVICE_UA_MAX,
  DEVICE_IDLE_TTL_MS,
} from '../lib/index.js'

process.env.TASKWATCH_TICKET_SECRET = 'check-devices-' + 'k'.repeat(40)
// 审计写到临时 DSH_HOME：测试不往真实 ~/.dsh/taskwatch-audit.log 里塞记录。
const AUDIT_HOME = mkdtempSync(join(tmpdir(), 'tw-devices-audit-'))
process.env.DSH_HOME = AUDIT_HOME

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}
function section(title) { console.log('\n' + title) }

// ── 真实 HTTP 外壳 ─────────────────────────────────────────────────────────
function makeInstance() {
  const routes = new Map()
  const services = {
    webServer: { register(spec) { routes.set(spec.path, spec.handler) } },
  }
  const ctx = {
    get(name) { return services[name] },
    effect(fn) { return fn() },
    on() { return () => {} },
  }
  apply(ctx, {})
  return routes
}

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!handler) { res.writeHead(404); res.end('not found'); return }
    Promise.resolve(handler(req, res)).catch((error) => {
      try { res.writeHead(500); res.end(String(error)) } catch { /* 已断开 */ }
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

function setCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie()
  const one = response.headers.get('set-cookie')
  return one ? [one] : []
}
function cookieFor(response, name) {
  for (const line of setCookies(response)) {
    const first = String(line).split(';')[0]
    const i = first.indexOf('=')
    if (i > 0 && first.slice(0, i).trim() === name) return first.slice(i + 1)
  }
  return ''
}
const asClient = (deviceId, extra = {}) => ({
  ...extra,
  headers: { ...(extra.headers || {}), cookie: 'twd=' + deviceId },
})
const postJson = (base, path, value, deviceId) => raw(base, path, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(deviceId ? { cookie: 'twd=' + deviceId } : {}),
  },
  body: JSON.stringify(value),
})

const UA_A = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'
const UA_B = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const UA_LEGACY = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'

// ═════════════════════════════════════════════════════════════════════════
// 7. 账本字段与隐私边界（先做纯函数，后面 HTTP 断言复用同一个账本规则）
// ═════════════════════════════════════════════════════════════════════════
section('[7] 账本字段集合与隐私边界')
{
  let clock = 1_700_000_000_000
  const ledger = createDeviceLedger({ now: () => clock })
  const record = ledger.ensure('device-privacy', { ua: UA_A, via: 'lan' })
  assert.ok(record)
  const bornAt = record.firstSeen
  clock += 5000
  const again = ledger.ensure('device-privacy', { ua: UA_A, via: 'remote' })
  check('同一 id 再 ensure 不重置 firstSeen（幂等）',
    again === record && record.firstSeen === bornAt && record.lastSeen === clock
      && record.via === 'remote', JSON.stringify({ firstSeen: record.firstSeen, lastSeen: record.lastSeen, via: record.via }))
  check('内部字段集合固定为 6 个', JSON.stringify(Object.keys(record).sort())
    === JSON.stringify([...DEVICE_RECORD_FIELDS].sort()), Object.keys(record).join(','))
  check('ua 只存摘要（≤' + DEVICE_UA_MAX + ' 字符）',
    record.ua.length <= DEVICE_UA_MAX && record.ua === 'iPhone · iOS 17.1 · Safari', record.ua)
  check('不存完整 UA（不含 Mozilla/AppleWebKit）',
    !/Mozilla|AppleWebKit|KHTML/.test(JSON.stringify(record)), JSON.stringify(record))
  const list = ledger.list()
  check('列表里不含 IP，也不回设备 cookie 原值',
    !/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(JSON.stringify(list))
      && !JSON.stringify(list).includes('device-privacy'),
    JSON.stringify(list))
  check('列表 id 是 12 位摘要（不是 UUID 本身）',
    /^[0-9a-f]{12}$/.test(list[0].id), list[0].id)
}

// ═════════════════════════════════════════════════════════════════════════
// 5. 容量上限：注入 51 台，淘汰最久未活跃的未撤销设备
// ═════════════════════════════════════════════════════════════════════════
section('[5] 容量上限（51 台 → 50，淘汰最久未活跃）')
{
  let clock = 1_700_000_000_000
  const ledger = createDeviceLedger({ now: () => clock })
  for (let i = 0; i < DEVICE_LEDGER_MAX + 1; i++) {
    clock += 1000
    ledger.ensure('cap-device-' + i, { ua: UA_B, via: 'lan' })
  }
  const ids = ledger.list().map((d) => d.id)
  check('账本规模被钳在 50', ledger.size === DEVICE_LEDGER_MAX && ids.length === 50,
    'size=' + ledger.size)
  check('最久未活跃的那台被淘汰', !ids.includes(ledger.digest('cap-device-0'))
    && ids.includes(ledger.digest('cap-device-50')))
}

// ═════════════════════════════════════════════════════════════════════════
// 6. 30 天未活跃自动清理（注入时间）
// ═════════════════════════════════════════════════════════════════════════
section('[6] 30 天未活跃清理')
{
  let clock = 1_700_000_000_000
  const ledger = createDeviceLedger({ now: () => clock })
  ledger.ensure('idle-old', { ua: UA_A, via: 'lan' })
  clock += DEVICE_IDLE_TTL_MS + 1
  ledger.ensure('idle-new', { ua: UA_B, via: 'remote' })
  const ids = ledger.list().map((d) => d.id)
  check('超过 30 天未活跃的被清掉', !ids.includes(ledger.digest('idle-old')) && ids.length === 1,
    'size=' + ledger.size)

  let edge = 1_700_000_100_000
  const edgeLedger = createDeviceLedger({ now: () => edge })
  edgeLedger.ensure('edge', { ua: UA_A })
  edge += DEVICE_IDLE_TTL_MS
  check('恰好 30 天仍在（边界不提前清）', edgeLedger.list().length === 1)
}

// ═════════════════════════════════════════════════════════════════════════
// 1–4. HTTP：身份下发、两台设备、撤销一台、撤销自己
// ═════════════════════════════════════════════════════════════════════════
const { server, base } = await serve(makeInstance())
try {
  section('[1] 首次访问下发 twd cookie')
  const first = await raw(base, '/taskwatch', { headers: { 'user-agent': UA_A } })
  const cookies = setCookies(first)
  const twdLine = cookies.find((c) => String(c).startsWith('twd=')) || ''
  const aCookie = cookieFor(first, 'twd')
  check('页面 200 且下发 twd', first.status === 200 && Boolean(aCookie), twdLine)
  check('twd 带 HttpOnly', /;\s*HttpOnly/i.test(twdLine), twdLine)
  check('twd 带 SameSite=Lax', /;\s*SameSite=Lax/i.test(twdLine), twdLine)
  check('twd 限定 Path=/taskwatch', /;\s*Path=\/taskwatch/i.test(twdLine), twdLine)

  // 老会话补绑：带 tw-route 标记、没有 twd —— 仍然 200，并补发设备 cookie。
  const legacy = await raw(base, '/taskwatch', {
    headers: { 'user-agent': UA_LEGACY, cookie: 'tw-route=remote' },
  })
  const legacyCookie = cookieFor(legacy, 'twd')
  check('老会话（只有 tw-route）不被踢下线，且补发 twd',
    legacy.status === 200 && Boolean(legacyCookie), 'status=' + legacy.status)

  section('[2] 两台设备：两条记录、lastSeen、当前设备标记')
  const bStart = Date.now()
  const bPage = await raw(base, '/taskwatch', { headers: { 'user-agent': UA_B } })
  const bCookie = cookieFor(bPage, 'twd')
  await new Promise((r) => setTimeout(r, 30))
  const aList = await raw(base, '/taskwatch/devices', asClient(aCookie, {
    headers: { 'user-agent': UA_A },
  }))
  check('列表接口 200', aList.status === 200, 'status=' + aList.status)
  const devices = (aList.body && aList.body.devices) || []
  check('列表出现三台设备（两台模拟 + 一台补绑）', devices.length === 3, '实际 ' + devices.length)
  const rowA = devices.find((d) => d.current)
  const rowB = devices.find((d) => d.name === 'Windows · Chrome')
  const rowLegacy = devices.find((d) => d.name === 'Android 14 · Chrome')
  check('当前设备恰好一台并被标记', Boolean(rowA) && devices.filter((d) => d.current).length === 1)
  check('设备名是可读摘要', rowA && rowA.name === 'iPhone · iOS 17.1 · Safari', rowA && rowA.name)
  check('另一台是 Windows · Chrome', Boolean(rowB), JSON.stringify(devices.map((d) => d.name)))
  check('老会话补绑的设备来自公网入口（tw-route=remote）',
    Boolean(rowLegacy) && rowLegacy.via === 'remote', rowLegacy && rowLegacy.via)
  check('当前设备的 lastSeen 不早于另一台', rowA && rowB && rowA.lastSeen > rowB.lastSeen,
    (rowB && rowB.lastSeen) + ' / ' + (rowA && rowA.lastSeen))
  check('另一台 lastSeen 落在它首次访问之后', rowB && rowB.lastSeen >= bStart - 1000,
    String(rowB && rowB.lastSeen))

  section('[3] 撤销一台：它 401，另一台仍 200')
  const revokeB = await postJson(base, '/taskwatch/devices/revoke', { deviceId: rowB.id }, aCookie)
  check('撤销接口 200 且 self=false', revokeB.status === 200 && revokeB.body
    && revokeB.body.ok === true && revokeB.body.self === false, JSON.stringify(revokeB.body))
  const bNext = await raw(base, '/taskwatch/data', asClient(bCookie))
  check('被撤销设备的下一次请求 401', bNext.status === 401, 'status=' + bNext.status)
  check('401 带 code=device-revoked 与 revoked:true', bNext.body
    && bNext.body.code === 'device-revoked' && bNext.body.revoked === true,
  JSON.stringify(bNext.body))
  const aNext = await raw(base, '/taskwatch/data', asClient(aCookie))
  check('另一台设备仍然 200', aNext.status === 200, 'status=' + aNext.status)
  const bPageAfter = await raw(base, '/taskwatch', asClient(bCookie))
  check('被撤销设备打开页面也是 401，并给出重配对入口',
    bPageAfter.status === 401 && bPageAfter.text.includes('此设备已被撤销')
      && bPageAfter.text.includes('/taskwatch?pair=1'), 'status=' + bPageAfter.status)

  section('[4] 撤销当前设备：本端 401 + revoked:true')
  const revokeA = await postJson(base, '/taskwatch/devices/revoke', { deviceId: rowA.id }, aCookie)
  check('撤销自己 200 且 self=true', revokeA.status === 200 && revokeA.body
    && revokeA.body.ok === true && revokeA.body.self === true, JSON.stringify(revokeA.body))
  const aRevoked = await raw(base, '/taskwatch/data', asClient(aCookie))
  check('本端下一次请求 401 且 revoked:true',
    aRevoked.status === 401 && aRevoked.body && aRevoked.body.revoked === true,
    aRevoked.status + ' ' + JSON.stringify(aRevoked.body))
  const pair = await raw(base, '/taskwatch?pair=1', asClient(aCookie))
  check('?pair=1 清掉 cookie 并 302 回 /taskwatch', pair.status === 302
    && (pair.headers.get('location') || '') === '/taskwatch'
    && setCookies(pair).some((c) => /^twd=;/.test(String(c))), pair.status + ' ' + setCookies(pair).join(' | '))
  const repage = await raw(base, '/taskwatch')
  check('重新配对后拿到一张新设备 cookie', repage.status === 200
    && Boolean(cookieFor(repage, 'twd')) && cookieFor(repage, 'twd') !== aCookie)

  section('[8] 撤销审计：只写摘要、入口与 self')
  const auditLines = readFileSync(join(AUDIT_HOME, 'taskwatch-audit.log'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'device-revoke')
  check('两台设备的撤销各写一行', auditLines.length === 2, String(auditLines.length))
  const auditSelf = auditLines.find((line) => line.self === true)
  const auditOther = auditLines.find((line) => line.self === false)
  check('审计记了 12 位摘要而不是 cookie 原值', Boolean(auditSelf && auditOther)
    && /^[0-9a-f]{12}$/.test(auditSelf.deviceId) && auditSelf.deviceId !== aCookie
    && auditOther.deviceId === rowB.id,
  JSON.stringify(auditLines))
  check('审计只含 {at,kind,deviceId,via,self}，无 IP / UA',
    auditLines.every((line) => JSON.stringify(Object.keys(line).sort())
      === JSON.stringify(['at', 'deviceId', 'kind', 'self', 'via']))
      && !/Mozilla|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(JSON.stringify(auditLines)),
  JSON.stringify(auditLines))
} finally {
  server.close()
  try { rmSync(AUDIT_HOME, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
}

console.log(`\n设备列表与撤销：${passed} 通过 / ${failed} 失败`)
if (failed) process.exitCode = 1
