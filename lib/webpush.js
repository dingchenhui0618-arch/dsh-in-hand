/**
 * 掌上 DSH（dsh-in-hand）— Web Push 的三个密码学零件，全部只用 node:crypto。
 *
 * 这一份文件解决三件事，都在这里收口，因为它们的共同点是**算错不会有报错**：
 * 浏览器那边只会安静地收不到通知，日志里也没有任何线索。
 *
 *   1. VAPID（RFC 8292）：ES256 签的 JWT + `Authorization: vapid t=…,k=…`。
 *   2. 载荷加密（RFC 8291 / RFC 8188）：ECDH(P-256) → HKDF-SHA256 → AES-128-GCM，
 *      输出 `aes128gcm` 记录（header: salt | rs | idlen | keyid，然后密文）。
 *   3. 通知内容口径：标题 `N 件事等你` + 与 webhook 完全相同的那段摘要。
 *
 * 边界：**这里不读写文件、不发请求、不记日志**。VAPID 私钥落盘、订阅文件、HTTP
 * 请求全在 lib/index.js 的 O 段（宿主侧），所以这个模块可以被 scripts/check-webpush.mjs
 * 直接钉住字节。
 *
 * 为什么自己写而不引依赖：见 README「手机系统通知」。一句话 —— 加密部分只有
 * 100 行标准算法，而多一个运行时依赖就多一份要在用户机器上跟着升级的东西。
 */
import {
  createCipheriv, createECDH, createPrivateKey, createHmac, randomBytes, sign,
} from 'node:crypto'

/** VAPID 的 `sub`：推送服务在滥用时需要能联系到人。指向仓库，不写个人邮箱。 */
export const VAPID_SUBJECT = 'https://github.com/dingchenhui0618-arch/dsh-in-hand'
/** JWT 有效期 12 小时：短到推送服务不会因为「过期太久」拒收，长到不必每条都重签。 */
export const VAPID_EXP_SECONDS = 12 * 60 * 60
/** 推送服务替我们保留多久（秒）。事情等不了 5 分钟，过了就等下一次。 */
export const VAPID_TTL = 300
/** 内容编码名。请求头 `Content-Encoding` 与 HKDF info 里的那串必须一致。 */
export const PUSH_CONTENT_ENCODING = 'aes128gcm'
/** RFC 8188 的记录大小。单条正文远小于它，所以实际永远只有一条记录。 */
export const PUSH_RECORD_SIZE = 4096
/** 通知图标：与 manifest 同一个源，已经装到主屏幕的那份缓存里也有。 */
export const PUSH_ICON = '/taskwatch/icon-192.png'
/** 固定 tag：同一批待办反复推时由系统替换上一条，而不是叠成一列。 */
export const PUSH_TAG = 'taskwatch-pending'

const B64 = 'base64url'

/** base64url 编码。整个协议里所有二进制字段都用它（没有 `=` 填充）。 */
export function b64url(value) {
  if (Buffer.isBuffer(value)) return value.toString(B64)
  return Buffer.from(String(value), 'utf8').toString(B64)
}

/** base64url → Buffer。手写的配置里可能带 `=` 或空格，这里一并容忍。 */
export function unb64url(value) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, '')
  if (!text) return Buffer.alloc(0)
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** 把「base64url 字符串或 Buffer」统一成 Buffer。 */
function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : unb64url(value)
}

const HMAC_SHA256 = (key, data) => createHmac('sha256', key).update(data).digest()

/** RFC 5869 的 expand 步骤（extract 就是一个 HMAC，见下面各处的 PRK）。 */
function hkdfExpand(prk, info, length) {
  const parts = []
  let block = Buffer.alloc(0)
  let counter = 1
  let filled = 0
  while (filled < length) {
    block = HMAC_SHA256(prk, Buffer.concat([block, info, Buffer.from([counter])]))
    parts.push(block)
    filled += block.length
    counter++
  }
  return Buffer.concat(parts).subarray(0, length)
}

/** 生成一对 P-256 VAPID 密钥，返回 base64url（公钥 65 字节未压缩点，私钥 32 字节）。 */
export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
  }
}

/** 从私钥推出公钥。改文件 / 换机器后两者可能对不上，发送前用它对齐。 */
export function vapidPublicFromPrivate(privateKey) {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(asBuffer(privateKey))
  return b64url(ecdh.getPublicKey())
}

/** 校验一对 VAPID 密钥：私钥必须是 32 字节、公钥必须是 65 字节且由私钥推出。 */
export function checkVapidKeys(publicKey, privateKey) {
  const priv = asBuffer(privateKey)
  const pub = asBuffer(publicKey)
  if (priv.length !== 32) return { ok: false, error: 'VAPID 私钥长度应为 32 字节' }
  if (pub.length !== 65 || pub[0] !== 0x04) return { ok: false, error: 'VAPID 公钥应是 65 字节的未压缩点' }
  try {
    if (vapidPublicFromPrivate(priv) !== b64url(pub)) {
      return { ok: false, error: 'VAPID 公私钥不匹配' }
    }
  } catch {
    return { ok: false, error: 'VAPID 私钥不合法' }
  }
  return { ok: true }
}

/** 推送 endpoint 的 origin，就是 JWT 的 `aud`。 */
export function pushAudience(endpoint) {
  let url
  try { url = new URL(String(endpoint == null ? '' : endpoint)) } catch { return '' }
  return url.origin && url.origin !== 'null' ? url.origin : ''
}

/**
 * 签一个 VAPID JWT（ES256）。
 *
 * claims 只有三个：`aud`（推送服务的 origin）、`exp`（now+12h，单位秒）、`sub`。
 * 签名用 `dsaEncoding: 'ieee-p1363'` —— 默认的 DER 编码在 JOSE 里是错的，
 * 这条是整段里最容易踩、且对方只会回 401 的地方。
 */
export function createVapidJwt({
  privateKey,
  publicKey,
  endpoint,
  now = Date.now(),
  expSeconds = VAPID_EXP_SECONDS,
  subject = VAPID_SUBJECT,
} = {}) {
  const aud = pushAudience(endpoint)
  if (!aud) throw new Error('推送地址不合法，算不出 aud')
  const priv = asBuffer(privateKey)
  if (priv.length !== 32) throw new Error('VAPID 私钥长度应为 32 字节')
  const pub = publicKey ? asBuffer(publicKey) : asBuffer(vapidPublicFromPrivate(priv))
  const header = { typ: 'JWT', alg: 'ES256' }
  const claims = {
    aud,
    exp: Math.floor(now / 1000) + expSeconds,
    sub: subject,
  }
  const input = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims))
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: b64url(priv),
    },
    format: 'jwk',
  })
  const signature = sign('sha256', Buffer.from(input, 'utf8'), { key, dsaEncoding: 'ieee-p1363' })
  return { jwt: input + '.' + b64url(signature), claims, header }
}

/** `Authorization` 头的完整值：`vapid t=<jwt>,k=<公钥 base64url>`。 */
export function vapidAuthorization(options = {}) {
  const signed = createVapidJwt(options)
  const publicKey = options.publicKey || vapidPublicFromPrivate(options.privateKey)
  return 'vapid t=' + signed.jwt + ',k=' + String(publicKey)
}

/**
 * RFC 8291 的两级 HKDF。返回值里每个中间量都留着 —— 不是给人看的，是为了
 * scripts/check-webpush.mjs 能拿 RFC 附录里的 CEK / NONCE / IKM / PRK 逐项对。
 */
export function deriveContentKeys({ ecdhSecret, authSecret, uaPublicKey, asPublicKey, salt }) {
  const secret = asBuffer(ecdhSecret)
  const auth = asBuffer(authSecret)
  const ua = asBuffer(uaPublicKey)
  const as = asBuffer(asPublicKey)
  const saltBuf = asBuffer(salt)
  // auth_info = "WebPush: info" || 0x00 || ua_public || as_public
  const authInfo = Buffer.concat([Buffer.from('WebPush: info', 'utf8'), Buffer.from([0]), ua, as])
  // PRK_key = HMAC(auth_secret, ecdh_secret)；IKM = HKDF-Expand(PRK_key, auth_info, 32)
  const prkKey = HMAC_SHA256(auth, secret)
  const ikm = hkdfExpand(prkKey, authInfo, 32)
  // PRK = HMAC(salt, IKM) —— 注意这里的 salt 是正文头里的那个，不是 auth_secret。
  const prk = HMAC_SHA256(saltBuf, ikm)
  const cek = hkdfExpand(prk,
    Buffer.concat([Buffer.from('Content-Encoding: aes128gcm', 'utf8'), Buffer.from([0])]), 16)
  const nonce = hkdfExpand(prk,
    Buffer.concat([Buffer.from('Content-Encoding: nonce', 'utf8'), Buffer.from([0])]), 12)
  return { prkKey, ikm, prk, cek, nonce }
}

/** 第 seq 条记录用的 nonce：`NONCE = base XOR SEQ`（SEQ 是 96 位大端）。
 *  seq 实际上就是"第几条记录"，远小于 2^48，所以只动最后 6 个字节。
 *  **不要**用 `tail ^ seq` 再写回 6 字节：JS 的 ^ 会截成 32 位，前两个字节会被
 *  写成 0 —— 单记录场景永远看不出来，一超过 4079 字节就整条解不开。 */
function sequenceNonce(base, seq) {
  const out = Buffer.from(base)
  let left = seq
  for (let i = 11; i >= 6 && left > 0; i--) {
    out[i] ^= left & 0xff
    left = Math.floor(left / 256)
  }
  return out
}

/** 按 RFC 8188 把明文切成记录：非最后一条固定 rs-17 字节，最后一条可以更短。 */
function splitRecords(data, rs) {
  const per = rs - 17
  const chunks = []
  for (let at = 0; at < data.length; at += per) chunks.push(data.subarray(at, at + per))
  if (!chunks.length) chunks.push(Buffer.alloc(0))
  return chunks
}

/**
 * 加密一条推送正文，产出完整的 `aes128gcm` 请求体。
 *
 *   body = salt(16) | rs(4, 大端) | idlen(1) | keyid(=as_public) | 记录密文
 *
 * `asPrivateKey` / `salt` 只给测试注入（RFC 8291 的测试向量是确定性的）；
 * 生产调用不传，函数自己生成一对临时服务端密钥和 16 字节随机 salt —— 每条消息
 * 一套，绝不复用。
 */
export function encryptWebPush({
  plaintext,
  uaPublicKey,
  authSecret,
  asPrivateKey = null,
  salt = null,
  rs = PUSH_RECORD_SIZE,
} = {}) {
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext == null ? '' : plaintext), 'utf8')
  const ua = asBuffer(uaPublicKey)
  const auth = asBuffer(authSecret)
  if (ua.length !== 65 || ua[0] !== 0x04) throw new Error('订阅公钥 p256dh 不合法（要 65 字节未压缩点）')
  if (auth.length !== 16) throw new Error('订阅 auth 密钥不合法（要 16 字节）')
  if (!Number.isInteger(rs) || rs < 18) throw new Error('记录大小 rs 不合法')

  const ecdh = createECDH('prime256v1')
  if (asPrivateKey) {
    const priv = asBuffer(asPrivateKey)
    if (priv.length !== 32) throw new Error('服务端临时私钥长度应为 32 字节')
    ecdh.setPrivateKey(priv)
  } else {
    ecdh.generateKeys()
  }
  const asPublic = ecdh.getPublicKey()
  const ecdhSecret = ecdh.computeSecret(ua)
  const saltBuf = salt ? asBuffer(salt) : randomBytes(16)
  if (saltBuf.length !== 16) throw new Error('salt 长度应为 16 字节')

  const keys = deriveContentKeys({
    ecdhSecret, authSecret: auth, uaPublicKey: ua, asPublicKey: asPublic, salt: saltBuf,
  })
  const chunks = splitRecords(data, rs)
  const records = chunks.map((chunk, index) => {
    const last = index === chunks.length - 1
    // 非最后一条必须正好填满 rs-16 字节的输入；最后一条只带分隔符，不加零。
    const plain = last ? Buffer.alloc(chunk.length + 1) : Buffer.alloc(rs - 16)
    chunk.copy(plain, 0)
    // 分隔符：最后一条 0x02，其余 0x01；后面补 0 到 rs-16（只有最后一条可以更短）。
    plain[chunk.length] = last ? 2 : 1
    const cipher = createCipheriv('aes-128-gcm', keys.cek, sequenceNonce(keys.nonce, index))
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  })

  const header = Buffer.concat([
    saltBuf,
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(rs, 0); return b })(),
    Buffer.from([asPublic.length]),
    asPublic,
  ])
  return {
    body: Buffer.concat([header, ...records]),
    salt: saltBuf,
    rs,
    asPublicKey: b64url(asPublic),
    ecdhSecret,
    ...keys,
    headerLength: header.length,
    records: records.length,
  }
}

/**
 * 通知内容口径（纯函数，测试直接钉住）。
 *
 *   标题：`N 件事等你`（N 就是还在等的那批；和 webhook 正文首行同一份口径）
 *   正文：buildNotifyText() 的输出 —— 工具名 + 一句说明前 30 字，多条只列 3 条
 *   点击：该订阅记录里的 origin + `#home`，打开就是首页待办
 *   tag：固定 taskwatch-pending，后来的替换前一条而不是叠加
 */
export function buildPushMessage({ count = 1, text = '', origin = '' } = {}) {
  const n = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.round(Number(count)) : 1
  return {
    title: n + ' 件事等你',
    body: String(text == null ? '' : text),
    tag: PUSH_TAG,
    icon: PUSH_ICON,
    data: { url: String(origin || '') + '#home' },
  }
}

/** 「发一条测试通知」用的固定文案。tag 与正式通知一致，所以它会替换掉上一条。 */
export function buildPushTestMessage({ origin = '' } = {}) {
  return {
    title: '测试通知',
    body: '通知已接通，收到这条说明设置生效。',
    tag: PUSH_TAG,
    icon: PUSH_ICON,
    data: { url: String(origin || '') + '#home' },
  }
}
