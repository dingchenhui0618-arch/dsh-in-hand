#!/usr/bin/env node
/**
 * v1.8.17 系统通知（Web Push）的契约测试。
 *
 * 这一版最该被钉住的不是"能不能收到通知"（那要真机），而是四件**算错也不报错**的事：
 *   1. **加密**：RFC 8291 Appendix A 的测试向量逐字节一致 —— 明文、双方密钥、auth
 *      secret、salt、连中间的 IKM / PRK / CEK / NONCE / ecdh_secret 全部对一遍。
 *      这里用的是 RFC 原文里的期望值（`RFC_8291_BODY`），不是本实现自己吐出来的。
 *   2. **往返**：换一套独立解密路径（crypto.hkdfSync + crypto.diffieHellman，
 *      与 lib/webpush.js 的 HMAC 展开 / createECDH 不同代码）解回原文，含中文与
 *      4096 / 4097 字节这个"单记录 / 多记录"的边界。
 *   3. **真实的推送请求**：本地假推送服务收到 POST，断言 VAPID 头、TTL、
 *      Content-Encoding，并把正文解回 JSON，确认标题是「N 件事等你」、正文
 *      没有把命令带出去；404/410 会删订阅。
 *   4. **只出掩码**：state / subscribe / test 的任何响应里都没有完整 endpoint。
 *
 * 所有地址都是 http://127.0.0.1:<随机端口>（内网 http 白名单的唯一合法用途）；
 * 密钥都是现场生成的；测试里没有任何真实端点的引用。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'tw-push-'))
process.env.DSH_HOME = home

const {
  apply,
  PUSH_FILE_NAME,
  PUSH_MAX_PER_DEVICE,
  PUSH_MAX_TOTAL,
  PUSH_VAPID_FILE_NAME,
  createPushStore,
  createVapidStore,
  createWebPushSender,
  maskPushEndpoint,
  pushStorePath,
  shortPushUa,
  vapidKeyPath,
  validatePushEndpoint,
  validatePushKeys,
  validatePushOrigin,
} = await import('../lib/index.js')
const {
  PUSH_CONTENT_ENCODING,
  PUSH_ICON,
  PUSH_RECORD_SIZE,
  PUSH_TAG,
  VAPID_EXP_SECONDS,
  VAPID_SUBJECT,
  VAPID_TTL,
  b64url,
  buildPushMessage,
  buildPushTestMessage,
  checkVapidKeys,
  createVapidJwt,
  encryptWebPush,
  generateVapidKeys,
  unb64url,
  vapidAuthorization,
} = await import('../lib/webpush.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const asyncTests = []
function test(name, fn) {
  asyncTests.push({ name, fn })
}
const b64 = (buf) => Buffer.from(buf).toString('base64url')

// ── 宿主假装（与 check-notify.mjs 同一套）──────────────────────────────────
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
// 日志里也不许出现 endpoint：抄一份，最后统一断言。
const logs = []
const realError = console.error
console.error = (...args) => { logs.push(args.map(String).join(' ')); realError(...args) }

apply(ctx, {
  approveFromPhone: true,
  approvalTimeoutMs: 120 * 1000,
  // 合并窗口压到下限 200ms：走的是同一条钳制逻辑，测试不必真等 1.2 秒。
  notify: { debounceMs: 200 },
})

// ── 假「推送服务」+ 应用路由的同一个 HTTP 服务器 ───────────────────────────
// /push/* 是被 createWebPushSender POST 的 endpoint（假的 FCM），其它路径是插件
// 自己注册的路由。/push/gone 固定回 410，用来验证"订阅失效就删掉"。
const pushHits = []
const ENDPOINT_TOKEN = 'pushtoken0123456789abcdef'
let pushStatus = 200
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname
  if (path.startsWith('/push/')) {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      pushHits.push({ path, headers: req.headers, body })
      const code = path === '/push/gone' ? 410 : pushStatus
      res.writeHead(code, { 'content-type': 'text/plain' })
      res.end(code === 410 ? 'gone' : 'ok')
    })
    return
  }
  const handler = routes.get(path)
  if (!handler) { res.writeHead(404); res.end(); return }
  Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: String((error && error.message) || error) }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

// 设备 cookie 罐：/taskwatch/push/* 全部由设备闸门包着，换一张 cookie 就是换一台
// 设备。push 的订阅按设备绑定，所以这条主键必须在整轮测试里保持一致。
let deviceCookie = ''
async function call(path, init = {}) {
  const headers = { ...(init.headers || {}) }
  if (deviceCookie) headers.cookie = deviceCookie
  const response = await fetch(base + path, { ...init, headers })
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie() : []
  for (const line of setCookies) {
    const m = /^twd=([^;]+)/.exec(line)
    if (m) deviceCookie = 'twd=' + m[1]
  }
  const text = await response.text()
  let body = {}
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: response.status, body, text }
}
const postJson = (path, body) => call(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const resetHits = () => { pushHits.length = 0 }

/** 触发一次审批（手机"离线"，桌面在等）—— 条目会在 next() 解析前一直留在
 *  approvals 里，正是「有事情等你」的真实形状。holdMs 要大于 200ms 的合并窗口。 */
function triggerApproval(callId, reason, holdMs = 900, toolName = 'pwsh') {
  return handlers.get('approval/request')(
    { agent: { id: 'session-push' }, toolName, callId, reason },
    async () => { await sleep(holdMs); return 'unavailable' },
  )
}

// ── 一套「订阅方」密钥（浏览器那边会生成的东西）────────────────────────────
function newSubscription(extra = {}) {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    uaPrivate: ecdh.getPrivateKey(),
    keys: {
      p256dh: b64(ecdh.getPublicKey()),
      auth: b64(crypto.randomBytes(16)),
    },
    ...extra,
  }
}

/**
 * 独立解密路径：与 lib/webpush.js 的加密实现**不共享代码**。
 *   · ECDH 用 crypto.diffieHellman（KeyObject），不是 createECDH；
 *   · HKDF 用 crypto.hkdfSync，不是手写的 hmac + 计数器；
 *   · 记录切分 / 去零 / 分隔符按 RFC 8188 §2 重新实现一遍。
 */
function decryptPush(body, uaPrivate, authSecret) {
  assert.ok(body.length > 86, '正文太短，连记录头都不够')
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const idlen = body[20]
  const keyid = body.subarray(21, 21 + idlen)
  const recordsAt = 21 + idlen
  assert.equal(rs, PUSH_RECORD_SIZE)
  assert.equal(idlen, 65, 'keyid 必须是 65 字节未压缩点')

  const ecdh = crypto.createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const uaPub = ecdh.getPublicKey()
  const asKey = crypto.createPublicKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64(keyid.subarray(1, 33)), y: b64(keyid.subarray(33, 65)),
    },
    format: 'jwk',
  })
  const uaKey = crypto.createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64(uaPub.subarray(1, 33)), y: b64(uaPub.subarray(33, 65)), d: b64(uaPrivate),
    },
    format: 'jwk',
  })
  const secret = crypto.diffieHellman({ privateKey: uaKey, publicKey: asKey })
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPub, keyid])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, authInfo, 32))
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt,
    Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16))
  const baseNonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt,
    Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12))

  const parts = []
  let at = recordsAt
  let seq = 0
  while (at < body.length) {
    const size = Math.min(rs, body.length - at)
    const record = body.subarray(at, at + size)
    const nonce = Buffer.from(baseNonce)
    // NONCE = base XOR SEQ（96 位大端）：只动最后 6 字节。
    // 这里用逐字节除法，不用 `seq >> (8*i)` —— JS 的移位量按 32 取模，
    // i≥4 时会绕回低字节，算出来的 nonce 是错的（写这份测试时踩过一次）。
    let left = seq
    for (let i = 11; i >= 6 && left > 0; i--) {
      nonce[i] ^= left & 0xff
      left = Math.floor(left / 256)
    }
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
    decipher.setAuthTag(record.subarray(record.length - 16))
    let plain
    try {
      plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()])
    } catch (e) {
      throw new Error('第 ' + (seq + 1) + ' 条记录解不开（长度 ' + record.length + '，正文第 '
        + at + ' 字节起）：' + ((e && e.message) || e))
    }
    let end = plain.length
    while (end > 0 && plain[end - 1] === 0) end--
    assert.ok(end > 0, '整条记录都是 0（缺少分隔符）')
    const delimiter = plain[end - 1]
    assert.ok(delimiter === 1 || delimiter === 2, '分隔符只能是 1 / 2，实际 ' + delimiter)
    parts.push(plain.subarray(0, end - 1))
    if (delimiter === 2) { at = body.length; break }
    seq++
    at += size
  }
  return Buffer.concat(parts)
}

// ═════════════════════════════════════════════════════════════════════════
// 1. VAPID：JWT 验签、claims、Authorization 头
// ═════════════════════════════════════════════════════════════════════════
test('VAPID：JWT 用公钥验签通过，aud 是 endpoint 的 origin，exp 在 12 小时内', async () => {
  const keys = generateVapidKeys()
  assert.equal(typeof keys.publicKey, 'string')
  assert.equal(unb64url(keys.publicKey).length, 65)
  assert.equal(unb64url(keys.privateKey).length, 32)
  assert.equal(checkVapidKeys(keys.publicKey, keys.privateKey).ok, true)
  assert.equal(checkVapidKeys(keys.publicKey, generateVapidKeys().privateKey).ok, false)

  const now = Date.now()
  const endpoint = 'https://fcm.googleapis.com/fcm/send/' + ENDPOINT_TOKEN
  const signed = createVapidJwt({ ...keys, endpoint, now })
  const parts = signed.jwt.split('.')
  assert.equal(parts.length, 3, 'JWT 必须三段')

  const header = JSON.parse(unb64url(parts[0]).toString('utf8'))
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(unb64url(parts[1]).toString('utf8'))
  assert.equal(claims.aud, 'https://fcm.googleapis.com', 'aud 必须等于 endpoint 的 origin')
  assert.equal(claims.sub, VAPID_SUBJECT)
  assert.equal(claims.sub, 'https://github.com/dingchenhui0618-arch/dsh-in-hand')
  const restSeconds = claims.exp - Math.floor(now / 1000)
  assert.equal(restSeconds, VAPID_EXP_SECONDS)
  assert.equal(VAPID_EXP_SECONDS, 12 * 60 * 60, '有效期 12 小时')
  assert.ok(restSeconds > 0 && restSeconds <= 12 * 60 * 60, 'exp 在 12 小时内：' + restSeconds)

  const pub = createPublicKeyFromB64(keys.publicKey)
  const ok = crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1], 'utf8'),
    { key: pub, dsaEncoding: 'ieee-p1363' }, unb64url(parts[2]))
  assert.equal(ok, true, 'ES256 签名必须能用公钥验过')

  const authorization = vapidAuthorization({ ...keys, endpoint, now })
  assert.match(authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+,k=[\w-]+$/)
  assert.ok(authorization.endsWith(',k=' + keys.publicKey))
  assert.equal(VAPID_TTL, 300, 'TTL 固定 300 秒')
})

function createPublicKeyFromB64(publicKey) {
  const raw = unb64url(publicKey)
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64(raw.subarray(1, 33)), y: b64(raw.subarray(33, 65)) },
    format: 'jwk',
  })
}

// ═════════════════════════════════════════════════════════════════════════
// 2. 记录头结构 + Content-Encoding
// ═════════════════════════════════════════════════════════════════════════
test('加密：aes128gcm 记录头 = salt(16) | rs(4) | idlen(1) | keyid(65)', async () => {
  const sub = newSubscription()
  const out = encryptWebPush({
    plaintext: 'hello web push', uaPublicKey: sub.keys.p256dh, authSecret: sub.keys.auth,
  })
  assert.equal(out.body.length, 86 + 'hello web push'.length + 1 + 16, '头 86 + 明文 + 分隔符 + tag')
  assert.equal(out.body.subarray(0, 16).length, 16, 'salt 16 字节')
  assert.equal(out.body.readUInt32BE(16), 4096, 'rs 大端 4096')
  assert.equal(out.body[20], 65, 'idlen = 65')
  const keyid = out.body.subarray(21, 86)
  assert.equal(b64(keyid), out.asPublicKey, 'keyid 是本条消息的服务端临时公钥')
  assert.equal(keyid[0], 0x04, '未压缩点')
  assert.equal(PUSH_CONTENT_ENCODING, 'aes128gcm')
  assert.notEqual(out.salt.toString('hex'), encryptWebPush({
    plaintext: 'x', uaPublicKey: sub.keys.p256dh, authSecret: sub.keys.auth,
  }).salt.toString('hex'), '每条消息的 salt 必须不同')

  // 订阅密钥的入口校验：长度不对直接拒，不许带着坏密钥走到"安静地收不到"。
  assert.equal(validatePushKeys(sub.keys).ok, true)
  assert.equal(validatePushKeys({ p256dh: 'AA', auth: sub.keys.auth }).ok, false)
  assert.equal(validatePushKeys({ p256dh: sub.keys.p256dh, auth: 'AA' }).ok, false)
})

// ═════════════════════════════════════════════════════════════════════════
// 3. RFC 8291 Appendix A：字节一致（含全部中间量）
// ═════════════════════════════════════════════════════════════════════════
// 期望值全部照抄 RFC 8291 §5 与 Appendix A（去掉折行空格），不是本实现的输出。
const RFC_8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
}

test('RFC 8291 附录 A：加密结果与官方向量逐字节一致（不是"看起来能解"）', async () => {
  const out = encryptWebPush({
    plaintext: RFC_8291.plaintext,
    uaPublicKey: RFC_8291.uaPublic,
    authSecret: RFC_8291.authSecret,
    asPrivateKey: RFC_8291.asPrivate,
    salt: RFC_8291.salt,
  })
  assert.equal(out.asPublicKey, RFC_8291.asPublic, '服务端公钥应与 RFC 一致')
  assert.equal(b64(out.ecdhSecret), RFC_8291.ecdhSecret, 'ecdh_secret')
  assert.equal(b64(out.prkKey), RFC_8291.prkKey, 'PRK_key')
  assert.equal(b64(out.ikm), RFC_8291.ikm, 'IKM')
  assert.equal(b64(out.prk), RFC_8291.prk, 'PRK')
  assert.equal(b64(out.cek), RFC_8291.cek, 'CEK')
  assert.equal(b64(out.nonce), RFC_8291.nonce, 'NONCE')
  assert.equal(out.headerLength, 86, 'RFC 原文：86 字节头')
  assert.equal(out.body.toString('base64url'), RFC_8291.body, '整条正文必须与 RFC §5 一致')

  // 反向也对一次：RFC 给的那条正文能被独立解密器解回原文。
  assert.equal(decryptPush(unb64url(RFC_8291.body), unb64url(RFC_8291.uaPrivate),
    unb64url(RFC_8291.authSecret)).toString('utf8'), RFC_8291.plaintext)
})

// ═════════════════════════════════════════════════════════════════════════
// 4. 往返：短文本 / 中文 / 4096 与 4097 字节（单记录 / 多记录边界）
// ═════════════════════════════════════════════════════════════════════════
test('往返：短文本、中文、4096 与 4097 字节都能解回原文（独立解密实现）', async () => {
  const cases = [
    { name: '空正文', text: '' },
    { name: '短文本', text: '1 件事等你：pwsh · 删除 build/cache 下的…' },
    { name: '中文', text: '三件事等你：编辑 · 改一处文案；提问 · 发布窗口是今天还是明天？' },
    { name: '4096 字节（正好一条记录）', text: 'a'.repeat(4096 - 3) + '界' },
    { name: '4097 字节（跨两条记录）', text: 'b'.repeat(4097) },
    { name: '中文 4KB', text: '通'.repeat(1400) + 'notify' },
  ]
  for (const item of cases) {
    const sub = newSubscription()
    const plain = Buffer.from(item.text, 'utf8')
    const out = encryptWebPush({
      plaintext: plain, uaPublicKey: sub.keys.p256dh, authSecret: sub.keys.auth,
    })
    let back
    try {
      back = decryptPush(out.body, sub.uaPrivate, unb64url(sub.keys.auth))
    } catch (e) {
      throw new Error(item.name + '：解密失败（' + ((e && e.message) || e) + '；'
        + plain.length + ' 字节 / ' + out.records + ' 条记录 / 正文 ' + out.body.length + ' 字节）')
    }
    assert.deepEqual(back, plain, item.name + '：解回来必须逐字节一致')
    if (plain.length > 4096 - 17) assert.ok(out.records >= 2, item.name + '：必须拆成多条记录')
  }
  // 4096 字节整满：正好一条记录（4096 - 17 的上限之外要拆，验证记录数）
  const sub = newSubscription()
  const out = encryptWebPush({
    plaintext: 'x'.repeat(4096), uaPublicKey: sub.keys.p256dh, authSecret: sub.keys.auth,
  })
  assert.equal(out.records, 2, '4096 字节明文必须拆成 2 条记录')
})

// ═════════════════════════════════════════════════════════════════════════
// 5. 真实 HTTP：假推送服务收到请求 + 解出标题与摘要
// ═════════════════════════════════════════════════════════════════════════
test('推送请求：Authorization: vapid、TTL、Content-Encoding 与可解密正文', async () => {
  const sub = newSubscription()
  const endpoint = base + '/push/' + ENDPOINT_TOKEN + '_abcdef'
  const added = await postJson('/taskwatch/push/subscribe', {
    endpoint, keys: sub.keys, origin: base,
  })
  assert.equal(added.status, 200, added.text)
  assert.equal(added.body.ok, true)
  assert.equal(added.body.mine, 1)
  assert.ok(!added.text.includes(endpoint), '订阅响应里不能有完整 endpoint')

  const state = await call('/taskwatch/push/state')
  assert.equal(state.body.ok, true)
  assert.equal(state.body.devices, 1)
  assert.equal(state.body.subscriptions.length, 1)
  assert.ok(!state.text.includes(endpoint), 'state 响应里不能有完整 endpoint')
  assert.ok(!state.text.includes(ENDPOINT_TOKEN), 'state 响应里不能有 endpoint 的路径片段')
  assert.equal(state.body.subscriptions[0].masked, maskPushEndpoint(endpoint))
  assert.ok(state.body.subscriptions[0].masked.startsWith('http://127.0.0.1:'))
  assert.ok(state.body.subscriptions[0].masked.endsWith('/…/abcdef'))
  assert.equal(typeof state.body.vapid, 'string')
  assert.equal(unb64url(state.body.vapid).length, 65)

  resetHits()
  // 一条带命令的 reason：正文只该带前 30 字，命令本身不能出现。
  const reason = '删除 build/cache 下的 3 个过期产物目录，命令为 rm -rf build/cache --force'
  await triggerApproval('call-push-1', reason)
  assert.equal(pushHits.length, 1, '一条待办只该产生一条推送，实际 ' + pushHits.length)

  const hit = pushHits[0]
  assert.match(String(hit.headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+,k=[\w-]+$/)
  assert.equal(hit.headers.ttl, '300')
  assert.equal(hit.headers['content-encoding'], 'aes128gcm')
  assert.equal(hit.headers['content-type'], 'application/octet-stream')
  assert.equal(Number(hit.headers['content-length']), hit.body.length)

  const raw = decryptPush(hit.body, sub.uaPrivate, unb64url(sub.keys.auth))
  const message = JSON.parse(raw.toString('utf8'))
  assert.equal(message.title, '1 件事等你')
  assert.ok(message.body.startsWith('1 件事等你：pwsh · '), message.body)
  assert.ok(message.body.includes('删除 build/cache 下的 3 个过期产物目录，命令…'), message.body)
  assert.ok(!message.body.includes('rm -rf'), '正文里不能出现完整命令')
  assert.ok(!message.body.includes(base), '正文里不能出现服务地址')
  assert.equal(message.tag, PUSH_TAG)
  assert.equal(message.icon, PUSH_ICON)
  assert.equal(message.data.url, base + '#home', '点通知要回到这个入口的首页')

  // 审计里不能出现 endpoint 的任何片段（这条用例不产生失败，文件可能还没有）。
  let audit = ''
  try { audit = readFileSync(join(home, 'taskwatch-audit.log'), 'utf8') } catch { audit = '' }
  assert.ok(!audit.includes(endpoint) && !audit.includes(ENDPOINT_TOKEN), '审计里不能出现 endpoint')
})

// ═════════════════════════════════════════════════════════════════════════
// 6. endpoint 校验：公网 http 被拒，内网 http / https 放行
// ═════════════════════════════════════════════════════════════════════════
test('endpoint 校验：公网 http 被拒；内网 http 与 https 允许', async () => {
  assert.equal(validatePushEndpoint('https://fcm.googleapis.com/fcm/send/abc').ok, true)
  assert.equal(validatePushEndpoint('http://127.0.0.1:1234/push/a').ok, true)
  assert.equal(validatePushEndpoint('http://10.1.2.3/push/a').ok, true)
  assert.equal(validatePushEndpoint('http://192.168.1.9:8080/push/a').ok, true)
  assert.equal(validatePushEndpoint('http://172.20.0.2/push/a').ok, true)
  assert.equal(validatePushEndpoint('http://172.32.0.2/push/a').ok, false)
  const pub = validatePushEndpoint('http://push.example.com/push/a')
  assert.equal(pub.ok, false)
  assert.ok(pub.error.includes('https'), pub.error)
  assert.ok(!pub.error.includes('example.com'), '错误文案不能回显地址')
  assert.equal(validatePushEndpoint('http://10.evil.com/push/a').ok, false, '以 10. 开头的公网域名不能被前缀判断放过去')
  assert.equal(validatePushEndpoint('ftp://example.com/x').ok, false)
  assert.equal(validatePushEndpoint('https://' + ['user', 'pw'].join(':') + '@example.com/x').ok, false)
  assert.equal(validatePushEndpoint('').ok, false)
  assert.equal(validatePushEndpoint('x'.repeat(2000)).ok, false)

  // 真实的订阅路由同样要拒：错误文案是固定串，不回显地址。
  const sub = newSubscription()
  const bad = await postJson('/taskwatch/push/subscribe', {
    endpoint: 'http://push.example.com/push/' + ENDPOINT_TOKEN,
    keys: sub.keys,
    origin: base,
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.ok, false)
  assert.ok(bad.body.error.includes('https'), bad.body.error)
  assert.ok(!bad.body.error.includes('push.example.com'), '错误文案不能回显地址')

  // origin 也只认 http(s)，公网 http 同样被拒。
  assert.equal(validatePushOrigin(base).ok, true)
  assert.equal(validatePushOrigin('https://dsh.example.com/taskwatch').origin, 'https://dsh.example.com')
  assert.equal(validatePushOrigin('http://example.com').ok, false)
  assert.equal(validatePushOrigin('javascript:alert(1)').ok, false)
})

// ═════════════════════════════════════════════════════════════════════════
// 7. 410 → 删订阅
// ═════════════════════════════════════════════════════════════════════════
test('推送服务返回 410：该订阅被删掉，下一次不再发', async () => {
  // 这台设备先清空，只留一条会 410 的订阅。
  await postJson('/taskwatch/push/unsubscribe', {})
  const sub = newSubscription()
  const goneEndpoint = base + '/push/gone'
  const added = await postJson('/taskwatch/push/subscribe', {
    endpoint: goneEndpoint, keys: sub.keys, origin: base,
  })
  assert.equal(added.status, 200, added.text)
  const id = added.body.id
  resetHits()
  await triggerApproval('call-push-gone', '确认发布')
  assert.equal(pushHits.length, 1, '应有一次尝试，实际 ' + pushHits.length)
  assert.equal(pushHits[0].path, '/push/gone')
  const state = await call('/taskwatch/push/state')
  assert.equal(state.body.devices, 0, '410 之后订阅必须被删掉')
  assert.equal(state.body.subscriptions.length, 0)
  assert.ok(!state.text.includes(id), '响应里不该再出现这条订阅')
  const saved = JSON.parse(readFileSync(join(home, PUSH_FILE_NAME), 'utf8'))
  assert.equal(saved.subscriptions.length, 0, '文件里也要删掉')
  const audit = readFileSync(join(home, 'taskwatch-audit.log'), 'utf8')
  assert.ok(audit.includes('push failed'), '失败要在审计里留一行 push failed')
  assert.ok(!audit.includes('/push/gone'), '审计里不能出现 endpoint')

  // 下一次有事时不再尝试这条已失效的订阅。
  resetHits()
  await triggerApproval('call-push-gone-2', '第二件事')
  assert.equal(pushHits.length, 0, '订阅已删，不该再发')
})

// ═════════════════════════════════════════════════════════════════════════
// 8. 文件权限 + 上限 + 掩码函数
// ═════════════════════════════════════════════════════════════════════════
test('订阅与 VAPID 文件：权限收紧（POSIX 0600 / Windows icacls），上限 20 / 5', async () => {
  assert.equal(pushStorePath({ DSH_HOME: home }, 'C:\\ignored'), join(home, PUSH_FILE_NAME))
  assert.equal(pushStorePath({}, 'C:\\Users\\demo'), join('C:\\Users\\demo', '.dsh', PUSH_FILE_NAME))
  assert.equal(vapidKeyPath({ DSH_HOME: home }, 'C:\\ignored'), join(home, PUSH_VAPID_FILE_NAME))

  // VAPID 密钥文件：第一次 GET state 时就该生成好，且只有一对有效密钥。
  const vapid = JSON.parse(readFileSync(join(home, PUSH_VAPID_FILE_NAME), 'utf8'))
  assert.equal(vapid.version, 1)
  assert.equal(checkVapidKeys(vapid.publicKey, vapid.privateKey).ok, true)
  assert.equal(unb64url(vapid.privateKey).length, 32)

  if (process.platform === 'win32') {
    // Windows 没有 0600：退化成「去掉继承、只授权当前用户」的 best-effort。
    for (const create of [createPushStore, createVapidStore]) {
      const calls = []
      const dir = mkdtempSync(join(tmpdir(), 'tw-push-perm-'))
      try {
        const store = create({
          file: join(dir, 'x.json'),
          platform: 'win32',
          env: { USERNAME: 'demo-user' },
          run: (cmd, args) => { calls.push({ cmd, args }); return { status: 0 } },
        })
        if (create === createPushStore) {
          const added = store.add({
            deviceId: '0123456789ab',
            endpoint: 'https://fcm.googleapis.com/fcm/send/x',
            keys: newSubscription().keys,
            origin: 'https://dsh.example.com',
          })
          assert.equal(added.ok, true)
        } else {
          store.get()
        }
        assert.equal(calls.length >= 1, true, '写盘后必须调用一次权限收紧')
        assert.equal(calls[0].cmd, 'icacls')
        assert.equal(calls[0].args[1], '/inheritance:r')
        assert.equal(calls[0].args[2], '/grant:r')
        assert.equal(calls[0].args[3], 'demo-user:F')
        assert.equal(store.stats().permission, 'icacls:user-only(best-effort)')
      } finally {
        try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 锁 */ }
      }
    }
  } else {
    assert.equal(statSync(join(home, PUSH_FILE_NAME)).mode & 0o777, 0o600)
    assert.equal(statSync(join(home, PUSH_VAPID_FILE_NAME)).mode & 0o777, 0o600)
  }

  // 上限：单设备 5 条、全机 20 条。用独立文件，不动上面那条链路。
  const dir = mkdtempSync(join(tmpdir(), 'tw-push-cap-'))
  try {
    const store = createPushStore({
      file: join(dir, PUSH_FILE_NAME), platform: 'linux', env: {}, run: () => ({ status: 0 }),
    })
    const keys = newSubscription().keys
    for (let i = 0; i < PUSH_MAX_PER_DEVICE; i++) {
      const got = store.add({
        deviceId: 'device-a', endpoint: 'https://fcm.googleapis.com/fcm/send/' + i,
        keys, origin: 'https://dsh.example.com',
      })
      assert.equal(got.ok, true, '第 ' + (i + 1) + ' 条应允许')
    }
    const over = store.add({
      deviceId: 'device-a', endpoint: 'https://fcm.googleapis.com/fcm/send/over',
      keys, origin: 'https://dsh.example.com',
    })
    assert.equal(over.ok, false)
    assert.ok(over.error.includes(String(PUSH_MAX_PER_DEVICE)), over.error)
    // 同一 endpoint 重复订阅不涨数。
    const dup = store.add({
      deviceId: 'device-a', endpoint: 'https://fcm.googleapis.com/fcm/send/0',
      keys, origin: 'https://dsh.example.com',
    })
    assert.equal(dup.ok, true)
    assert.equal(dup.existed, true)
    assert.equal(store.counts().total, PUSH_MAX_PER_DEVICE)
    // 全机 20 条：4 台设备 × 5 条填满后第 21 条被拒。
    let added = PUSH_MAX_PER_DEVICE
    for (let d = 1; d < PUSH_MAX_TOTAL / PUSH_MAX_PER_DEVICE; d++) {
      for (let i = 0; i < PUSH_MAX_PER_DEVICE; i++) {
        const got = store.add({
          deviceId: 'device-' + d, endpoint: 'https://fcm.googleapis.com/fcm/send/' + d + '-' + i,
          keys, origin: 'https://dsh.example.com',
        })
        assert.equal(got.ok, true, '第 ' + (added + 1) + ' 条应允许：' + got.error)
        added++
      }
    }
    const full = store.add({
      deviceId: 'device-z', endpoint: 'https://fcm.googleapis.com/fcm/send/21',
      keys, origin: 'https://dsh.example.com',
    })
    assert.equal(full.ok, false)
    assert.ok(full.error.includes(String(PUSH_MAX_TOTAL)), full.error)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 锁 */ }
  }

  // 掩码：保留域名 + 尾部 6 字符，不含路径里的那串凭据。
  const masked = maskPushEndpoint(base + '/push/' + ENDPOINT_TOKEN + '_abcdef')
  assert.ok(masked.includes('127.0.0.1'), masked)
  assert.ok(masked.endsWith('/…/abcdef'), masked)
  assert.ok(!masked.includes(ENDPOINT_TOKEN), '掩码不能带完整 token')
  assert.equal(maskPushEndpoint('not a url'), '（已保存）')
})

// ═════════════════════════════════════════════════════════════════════════
// 9. 合并：三件只推一条，「3 件事等你」
// ═════════════════════════════════════════════════════════════════════════
test('合并：同时三件只推一条，标题「3 件事等你」', async () => {
  await postJson('/taskwatch/push/unsubscribe', {})
  const sub = newSubscription()
  const added = await postJson('/taskwatch/push/subscribe', {
    endpoint: base + '/push/merge_' + ENDPOINT_TOKEN,
    keys: sub.keys,
    origin: base,
  })
  assert.equal(added.status, 200, added.text)
  resetHits()
  const batch = [
    triggerApproval('call-m1', '删除 build/cache 下的过期产物'),
    triggerApproval('call-m2', '改一处文案'),
    triggerApproval('call-m3', '确认发布'),
  ]
  await Promise.all(batch)
  assert.equal(pushHits.length, 1, '三件合并成一条，实际 ' + pushHits.length)
  const raw = decryptPush(pushHits[0].body, sub.uaPrivate, unb64url(sub.keys.auth))
  const message = JSON.parse(raw.toString('utf8'))
  assert.equal(message.title, '3 件事等你')
  assert.equal((message.body.match(/^· /gm) || []).length, 3)
  assert.ok(!message.body.includes('还有'), message.body)

  // 「发一条测试通知」：固定文案，仍走真实加密 + 真实签名。
  resetHits()
  const tested = await postJson('/taskwatch/push/test', {})
  assert.equal(tested.status, 200, tested.text)
  assert.equal(tested.body.ok, true, tested.text)
  assert.equal(tested.body.sent, 1)
  assert.equal(pushHits.length, 1)
  const testMessage = JSON.parse(
    decryptPush(pushHits[0].body, sub.uaPrivate, unb64url(sub.keys.auth)).toString('utf8'))
  assert.deepEqual(testMessage, buildPushTestMessage({ origin: base }))
  assert.equal(testMessage.title, '测试通知')
  // 测试路由的响应只给掩码。
  assert.ok(!tested.text.includes(ENDPOINT_TOKEN), '测试响应里不能有完整 endpoint')
  assert.equal(tested.body.results[0].masked, maskPushEndpoint(base + '/push/merge_' + ENDPOINT_TOKEN))
})

// ═════════════════════════════════════════════════════════════════════════
// 10. 通知内容口径 + 发送器失败形态
// ═════════════════════════════════════════════════════════════════════════
test('内容口径：标题 N 件事等你、tag 固定、点通知回 #home；失败文案不含地址', async () => {
  const message = buildPushMessage({ count: 4, text: '4 件事等你：pwsh · x', origin: 'https://dsh.example.com' })
  assert.equal(message.title, '4 件事等你')
  assert.equal(message.body, '4 件事等你：pwsh · x')
  assert.equal(message.tag, 'taskwatch-pending')
  assert.equal(message.icon, '/taskwatch/icon-192.png')
  assert.equal(message.data.url, 'https://dsh.example.com#home')

  // 发送器：404 / 410 标记 gone，5xx 不标；错误文案里绝不含 endpoint。
  const sub = newSubscription()
  const vapid = generateVapidKeys()
  const make = (status) => createWebPushSender({
    vapid,
    fetchImpl: async (url) => {
      assert.ok(String(url).includes(ENDPOINT_TOKEN), '请求应该打到订阅的 endpoint')
      return { status, body: { cancel: async () => {} } }
    },
  })
  const target = { endpoint: 'https://fcm.googleapis.com/fcm/send/' + ENDPOINT_TOKEN, keys: sub.keys }
  const gone410 = await make(410).send(target, { title: 'x' })
  assert.equal(gone410.ok, false)
  assert.equal(gone410.gone, true)
  assert.equal((await make(404).send(target, {})).gone, true)
  const err500 = await make(500).send(target, {})
  assert.equal(err500.gone, false, '只有 404 / 410 才算订阅失效')
  assert.equal(err500.status, 500)
  assert.ok(!String(err500.error).includes(ENDPOINT_TOKEN), '错误文案不能带 endpoint')

  // fetch 抛的 TypeError 里通常带完整 URL：绝不能透传。
  const throwing = createWebPushSender({
    vapid,
    fetchImpl: async () => { throw new TypeError('fetch failed: https://fcm.googleapis.com/fcm/send/' + ENDPOINT_TOKEN) },
  })
  const boom = await throwing.send(target, {})
  assert.equal(boom.ok, false)
  assert.equal(boom.status, 0)
  assert.ok(!String(boom.error).includes(ENDPOINT_TOKEN), '失败文案不能回显 endpoint')
  assert.ok(!String(boom.error).includes('googleapis'), '失败文案不能回显域名')
  assert.equal(shortPushUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari · iOS')
  assert.equal(shortPushUa('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'), 'Chrome · Android')
  assert.equal(shortPushUa(''), '浏览器')
})

// ═════════════════════════════════════════════════════════════════════════
// 11. 页面 / SW 静态契约（iOS 引导、按钮、SW 的 push / click）
// ═════════════════════════════════════════════════════════════════════════
test('页面：iOS 非 standalone 走引导分支，且在「开启」之前；SW 有 push / notificationclick', async () => {
  const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')
  const sw = readFileSync(join(ROOT, 'lib', 'sw.js'), 'utf8')

  for (const needle of ['系统通知', '开启系统通知', '发一条测试通知', '关闭此设备',
    '添加到主屏幕', '分享', 'iOS 16.4', '不支持', '已开启 ']) {
    assert.ok(page.includes(needle), '页面缺少：' + needle)
  }

  // 状态机：iOS 判定必须排在"未开启"之前，且引导分支不产生"开启"按钮。
  const infoStart = page.indexOf('function pushStateInfo()')
  const infoEnd = page.indexOf('function renderPush()')
  assert.ok(infoStart > 0 && infoEnd > infoStart, '页面里应有 pushStateInfo() / renderPush()')
  const infoBody = page.slice(infoStart, infoEnd)
  const guideAt = infoBody.indexOf('PUSH.ios && !PUSH.standalone')
  const offAt = infoBody.indexOf("key: 'off'")
  assert.ok(guideAt > 0, 'iOS 判定必须存在')
  assert.ok(guideAt < offAt, 'iOS 判定必须排在普通「未开启」之前（先引导，不显示开启按钮）')
  assert.ok(/standalone/.test(infoBody) && /matchMedia/.test(page), '要用 navigator.standalone / display-mode 判断')

  const renderBody = page.slice(infoEnd, page.indexOf('function pushKeyBytes'))
  assert.match(renderBody, /var canOn = info\.key === 'off' \|\| \(info\.key === 'on' && PUSH\.mine === 0\)/,
    '「开启」只在未开启（或别处开了、这台没开）时出现 —— iOS 引导 / 权限被拒都不出按钮')
  assert.ok(/guide\.hidden = info\.key !== 'guide'/.test(renderBody), 'iOS 引导块只在 guide 状态展开')
  assert.ok(/denied/.test(infoBody), '权限被拒要有独立的说明分支')
  // 权限只在一处申请：被拒后不再反复弹窗。
  assert.equal((page.match(/Notification\.requestPermission\(\)/g) || []).length, 1,
    'requestPermission() 只该在开启动作里真正调用一次（被拒后不再弹窗）')

  // 页面只从 /taskwatch/push/state 读订阅状态，且请求路径都对得上。
  for (const path of ['/taskwatch/push/state', '/taskwatch/push/subscribe',
    '/taskwatch/push/unsubscribe', '/taskwatch/push/test']) {
    assert.ok(page.includes(path), '页面缺少接口调用：' + path)
  }
  assert.ok(!page.includes('ENDPOINT'), '页面不该保存完整 endpoint')

  // SW：push → showNotification；click → 已有窗口 focus + 导航，否则 openWindow。
  assert.match(sw, /addEventListener\('push'/)
  assert.match(sw, /showNotification/)
  assert.match(sw, /addEventListener\('notificationclick'/)
  assert.match(sw, /client\.focus\(\)/)
  assert.match(sw, /client\.navigate\(target\)/)
  assert.match(sw, /clients\.openWindow\(target\)/)
  assert.match(sw, /includeUncontrolled: true/)
  assert.ok(sw.includes("const CACHE = 'taskwatch-v32'"), '外壳版本要跟着升到 v32')
  assert.match(sw, /tag: .*taskwatch-pending/, 'SW 侧兜底的 tag 也要是 taskwatch-pending')
})

// ═════════════════════════════════════════════════════════════════════════
// 12. 不新增运行时依赖
// ═════════════════════════════════════════════════════════════════════════
test('package.json 没有新增任何运行时依赖（dependencies 必须为空或缺省）', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const deps = pkg.dependencies || {}
  assert.deepEqual(Object.keys(deps), [], 'dependencies 必须为空：' + JSON.stringify(deps))
  const optional = pkg.optionalDependencies || {}
  assert.deepEqual(Object.keys(optional), [], 'optionalDependencies 也必须为空')
  assert.equal(JSON.stringify(pkg).includes('web-push'), false, '不能偷偷引入 web-push 这类库')
})

// ── 跑完所有用例 ──────────────────────────────────────────────────────────
try {
  for (const { name, fn } of asyncTests) {
    try {
      await fn()
      console.log('  PASS  ' + name)
    } catch (e) {
      failures++
      console.log('  FAIL  ' + name + ' — ' + ((e && e.message) || e))
    }
  }
  // 最后一道闸：整轮跑完，日志里也不许出现 endpoint 的任何片段。
  const leaked = logs.filter((line) => line.includes(ENDPOINT_TOKEN) || line.includes('/push/')
    || line.includes('googleapis'))
  if (leaked.length) {
    failures++
    console.log('  FAIL  日志泄漏 endpoint — ' + leaked[0].slice(0, 160))
  } else {
    console.log('  PASS  日志里没有出现 endpoint')
  }
  for (const path of ['/taskwatch/push/state', '/taskwatch/push/subscribe',
    '/taskwatch/push/unsubscribe', '/taskwatch/push/test']) {
    if (!routes.has(path)) { failures++; console.log('  FAIL  缺少路由 ' + path) }
  }
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections() } catch { /* 旧 Node */ }
  await new Promise((resolve) => server.close(resolve))
  try { rmSync(home, { recursive: true, force: true }) } catch { /* Windows 锁 */ }
}
