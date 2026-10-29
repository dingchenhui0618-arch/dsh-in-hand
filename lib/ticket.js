/**
 * 跨进程换路票据（v3）：HMAC 签名 + 受众绑定 + 严格一次性。
 *
 * 背景（2026-10-29，v1.8.6）：v2 解决了"宿主签的票中继不认"（共用密钥互认），但留下两个
 * 真实缺口 ——
 *   1. **跨入口重放**：两边各自用同一密钥验签，票里却没有"受众"，给局域网入口签的票在
 *      60 秒内可以被拿去兑换公网中继（反之亦然）；两边不共享 nonce 记账，谁都不知道对方用过。
 *   2. **单进程原子性**：校验与"标记已用"若拆成两步，同一进程内也有极短的重放窗口。
 *
 * 票格式（两边必须一致）：
 *   v3 = 'v3.' + <expMs> + '.' + <nonce base64url> + '.' + <aud> + '.' + <hmac base64url>
 *   HMAC = HMAC-SHA256(secret, 'v3|' + expMs + '|' + nonce + '|' + aud)
 *   aud ∈ { 'remote', 'lan' } —— **校验方身份**，不是入口名字：
 *     · 'remote'：由公网中继兑现（中继只收这个）；
 *     · 'lan'   ：由插件宿主自己兑现（局域网直连，宿主只收这个）。
 *   两个入口若指向同一个校验方，用的就是同一个 aud —— 那种情况下单次性由该进程的
 *   nonce 记账保证，跨入口重放依然会发生 **一次**，但绝不会发生第二次。
 *
 * 向后兼容（硬要求，别把用户锁在门外）：
 *   · v2 票（`v2.<expMs>.<nonce>.<hmac>`）在过渡期内继续接受 —— 它没有 aud，无法绑定；
 *   · 过渡期截止 TICKET_V2_SUNSET_AT（2027-01-01T00:00:00Z，见 CHANGELOG v1.8.6），
 *     之后 v2 一律拒绝。两侧（插件 / 中继）用的是同一个常量语义；
 *   · 发版后"旧中继 + 新插件"必须照常工作，所以插件在拿不到中继的 v3 能力声明时**继续签 v2**
 *     （见 lib/index.js 的 relayTicketVersion）。
 *
 * 一次性（严格）：
 *   · verify 与 claim 在 redeemTicket 这**一个同步函数**内完成，中间没有 await —— Node 的
 *     单线程事件循环因此不给第二次兑换插入的机会；claim 在同一个函数里"查 Set + 写 Set"；
 *   · 记录带过期时间，claim 时按需清理 + 后台定时器（unref）清理，容量还有硬上限；
 *   · 已用过的票再来 → reason 'replay'，调用方回 401 并记一行 "replay attempt"（不含票面）。
 *
 * 这个模块不碰 HTTP、不碰宿主服务，只做纯函数与密钥解析，方便直接测。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const TICKET_TTL_MS = 60 * 1000
/** 允许 60 秒 TTL + 时钟偏差；超过这个跨度的一律当伪造/过期，不给无限期票。 */
export const TICKET_MAX_AGE_MS = 180 * 1000
/** 当前签发的票版本；TICKET_VERSIONS 是"本进程能验"的版本清单（能力声明用）。 */
export const TICKET_VERSION = 3
export const TICKET_VERSIONS = [3, 2]
/** 受众：校验方身份。中继只收 remote，插件宿主只收 lan。 */
export const TICKET_AUD_REMOTE = 'remote'
export const TICKET_AUD_LAN = 'lan'
export const TICKET_AUDIENCES = [TICKET_AUD_REMOTE, TICKET_AUD_LAN]
/**
 * v2 过渡期截止点（UTC）：这之后插件与中继都不再接受 v2 票。
 * 选 2027-01-01 是给"用户可能几周才升级一次"留足时间，同时给一个能写进文档的硬日期。
 * 两侧代码用的是同一个日期 —— 改日期必须两边一起改，否则会出现"一边认、一边不认"。
 */
export const TICKET_V2_SUNSET_AT = Date.UTC(2027, 0, 1, 0, 0, 0)
export const TICKET_RE = /^v3\.\d{13}\.[A-Za-z0-9_-]{16,}\.(remote|lan)\.[A-Za-z0-9_-]{20,}$/
export const TICKET_V2_RE = /^v2\.\d{13}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}$/
export const SECRET_MIN_LENGTH = 32
export const SECRET_FILE_NAME = 'taskwatch-ticket.key'

/** 任何端口上的这个插件/中继都读同一个文件：同一台机器、同一个用户。 */
export function secretPath(home = homedir()) {
  return join(home, '.dsh', SECRET_FILE_NAME)
}

function normalizeSecret(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text.length >= SECRET_MIN_LENGTH ? text : ''
}

function hmacInput(version, expMs, nonce, aud) {
  return version === 3 ? 'v3|' + expMs + '|' + nonce + '|' + aud : 'v2|' + expMs + '|' + nonce
}

/**
 * 签发一张票。默认 v3（带受众）；version: 2 时签 v2（没有 aud，过渡期兼容用）。
 * v3 必须给合法的 aud —— 没有受众的 v3 票等于把缺口留着。
 */
export function signTicket(secret, { now = Date.now, ttlMs = TICKET_TTL_MS, aud, version = TICKET_VERSION } = {}) {
  if (!normalizeSecret(secret)) throw new Error('票据密钥至少需要 ' + SECRET_MIN_LENGTH + ' 个字符')
  const expMs = now() + ttlMs
  const nonce = randomBytes(16).toString('base64url')
  if (version === 2) {
    const hmac = createHmac('sha256', secret).update(hmacInput(2, expMs, nonce)).digest('base64url')
    return 'v2.' + expMs + '.' + nonce + '.' + hmac
  }
  if (!TICKET_AUDIENCES.includes(aud)) throw new Error('v3 票据必须指定受众（remote / lan）')
  const hmac = createHmac('sha256', secret).update(hmacInput(3, expMs, nonce, aud)).digest('base64url')
  return 'v3.' + expMs + '.' + nonce + '.' + aud + '.' + hmac
}

/** 拆票面。不认识/形状不对 → null；不验签，也不看时间。 */
export function parseTicket(ticket) {
  if (typeof ticket !== 'string') return null
  const v3 = TICKET_RE.test(ticket)
  const v2 = !v3 && TICKET_V2_RE.test(ticket)
  if (!v3 && !v2) return null
  const parts = ticket.split('.')
  const expMs = Number(parts[1])
  if (!Number.isSafeInteger(expMs)) return null
  return {
    version: v3 ? 3 : 2,
    expMs,
    nonce: parts[2],
    aud: v3 ? parts[3] : '',
    hmac: v3 ? parts[4] : parts[3],
  }
}

function signatureOk(secret, parsed) {
  const expected = createHmac('sha256', secret).update(hmacInput(parsed.version, parsed.expMs, parsed.nonce, parsed.aud)).digest()
  let given
  try {
    given = Buffer.from(parsed.hmac, 'base64url')
  } catch {
    return false
  }
  // timingSafeEqual 要求等长；长度不同本身就不是本票。
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}

/** 只验签与时效，不记账。测试与"提前判断"用；兑换请一律走 redeemTicket。 */
export function verifyTicket(secret, ticket, { now = Date.now, aud, v2SunsetAt = TICKET_V2_SUNSET_AT } = {}) {
  const parsed = parseTicket(ticket)
  if (!parsed) return false
  if (!normalizeSecret(secret)) return false
  if (parsed.version === 3) {
    if (aud && parsed.aud !== aud) return false
    if (!signatureOk(secret, parsed)) return false
  } else {
    if (!(now() < v2SunsetAt)) return false
    if (!signatureOk(secret, parsed)) return false
  }
  const at = now()
  if (!(parsed.expMs > at)) return false
  if (parsed.expMs - at > TICKET_MAX_AGE_MS) return false
  return true
}

/**
 * 进程内严格一次性记账。
 *
 * claim() 在**同一次调用**里完成"查 + 写"，中间没有 await，也不会先返回再记 —— 这就是
 * "校验 + 标记已用合成一次原子调用"的落点。记录带过期时间：到点由 claim 时的按需清理
 * 或后台定时器清掉，再加上 max 硬上限，Set 不会无限涨。
 */
export function createReplayGuard({ now = Date.now, max = 8192, sweepMs = 30 * 1000, autoSweep = true } = {}) {
  const seen = new Map()
  let nextSweep = now() + sweepMs
  /** 删掉所有已过期的记录。now 可注入，测试里不必真等 60 秒。 */
  const prune = (at = now()) => {
    for (const [key, exp] of seen) if (exp <= at) seen.delete(key)
    nextSweep = at + sweepMs
    return seen.size
  }
  /** 第一次见到 key → true（并立即写入）；重复 → false。原子：查与写在同一个函数体内。 */
  const claim = (key, expMs) => {
    if (typeof key !== 'string' || !key) return false
    const at = now()
    if (at >= nextSweep || seen.size >= max) prune(at)
    if (seen.has(key)) return false
    // 上限兜底：全是未过期记录时丢最早的一条（票本身只有 60 秒寿命，丢掉的几乎都是残留）。
    while (seen.size >= max) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
    seen.set(key, Math.max(Number(expMs) || 0, at + 1000))
    return true
  }
  let timer = null
  if (autoSweep && typeof setInterval === 'function') {
    timer = setInterval(() => prune(), sweepMs)
    // 后台清理不能拖住进程退出：插件/中继里这只是一个 Set。
    if (typeof timer.unref === 'function') timer.unref()
  }
  return {
    claim,
    /** 老名字（v1.8.5 及以前的测试用过）：第一次见到返回 false。 */
    replayed(nonce, expMs) { return !claim(nonce, expMs) },
    prune,
    get size() { return seen.size },
    stop() { if (timer) { clearInterval(timer); timer = null } },
  }
}

/**
 * 兑换一张票：解析 → 受众 → 验签 → 时效 → 记账，**全部在这一个同步函数里**。
 *
 * 返回 { ok, reason, version, aud }，reason 只用来写日志与测试，绝不回显给客户端：
 *   'format' | 'audience' | 'signature' | 'expired' | 'window' | 'v2-sunset' | 'replay'
 */
export function redeemTicket(secret, ticket, {
  aud,
  guard,
  now = Date.now,
  v2SunsetAt = TICKET_V2_SUNSET_AT,
} = {}) {
  const parsed = parseTicket(ticket)
  if (!parsed) return { ok: false, reason: 'format', version: 0, aud: '' }
  const meta = { version: parsed.version, aud: parsed.aud }
  if (!guard) return { ok: false, reason: 'format', ...meta }
  if (!normalizeSecret(secret)) return { ok: false, reason: 'signature', ...meta }
  if (parsed.version === 3) {
    if (aud && parsed.aud !== aud) return { ok: false, reason: 'audience', ...meta }
    if (!signatureOk(secret, parsed)) return { ok: false, reason: 'signature', ...meta }
  } else {
    // v2 没有受众，只能靠过渡期之内的"短期 + 单次"兜着。
    if (!(now() < v2SunsetAt)) return { ok: false, reason: 'v2-sunset', ...meta }
    if (!signatureOk(secret, parsed)) return { ok: false, reason: 'signature', ...meta }
  }
  const at = now()
  if (!(parsed.expMs > at)) return { ok: false, reason: 'expired', ...meta }
  if (parsed.expMs - at > TICKET_MAX_AGE_MS) return { ok: false, reason: 'window', ...meta }
  // 记账用 "版本:受众:nonce"：同一 nonce 换个受众也不能再兑一次。
  if (!guard.claim(parsed.version + ':' + (parsed.aud || '-') + ':' + parsed.nonce, parsed.expMs)) {
    return { ok: false, reason: 'replay', ...meta }
  }
  return { ok: true, reason: '', ...meta }
}

/**
 * 票据闸门：统一签发、统一兑换。aud 是这个**校验方**接受的受众。
 *
 * redeem 的回落规则仍是刻意写成"只认格式"的：非 v2/v3 形状（老页面/老票）才走原来的
 * 进程内 Map；一旦长得像票就只按受众 + 签名 + 时效 + 单次判断，签名不对直接拒绝，
 * **不**回落 —— 否则伪造一张票反而比随机串更容易被误放行。
 */
export function createTicketGate({ secret, aud, store, now = Date.now, ttlMs = TICKET_TTL_MS, replay, log, v2SunsetAt = TICKET_V2_SUNSET_AT } = {}) {
  const guard = replay || createReplayGuard({ now })
  const say = typeof log === 'function' ? log : () => {}
  /** 带原因的兑换：调用方据此写日志，但**只**写原因，绝不写票面。 */
  const redeemDetailed = (ticket) => {
    const text = typeof ticket === 'string' ? ticket.trim() : ''
    if (!text) return { ok: false, reason: 'format', version: 0, aud: '' }
    if (TICKET_RE.test(text) || TICKET_V2_RE.test(text)) {
      const result = redeemTicket(secret, text, { aud, guard, now, v2SunsetAt })
      // 只有"签名/受众/时效都过了、只是这张票已经用过"才值得记一行 —— 垃圾请求不刷日志。
      if (!result.ok && result.reason === 'replay') {
        say('dsh-in-hand: replay attempt (aud=' + (result.aud || 'v2') + ', v=' + result.version + ')')
      }
      return result
    }
    // 向后兼容：老格式随机票仍只在本进程 Map 里有效。
    if (store && store.redeem(text)) return { ok: true, reason: '', version: 0, aud: '' }
    return { ok: false, reason: 'format', version: 0, aud: '' }
  }
  return {
    /** aud 缺省用闸门自己的受众（校验方视角）；签给别人的票请显式传。 */
    mint(options = {}) {
      const { aud: target = aud, version = TICKET_VERSION } = options
      return signTicket(secret, { now, ttlMs, aud: target, version })
    },
    redeemDetailed,
    redeem(ticket) { return redeemDetailed(ticket).ok },
    get replaySize() { return guard.size },
  }
}

/**
 * 两边同一套解析顺序：
 *   1. 环境变量 TASKWATCH_TICKET_SECRET（trim 后至少 32 字符）
 *   2. <home>/.dsh/taskwatch-ticket.key（UTF-8、trim、至少 32 字符）
 *   3. 都没有 → 先生成 32 字节随机值写进该文件，**收紧权限**后使用。
 *
 * 返回 { secret, source, file, permission }；任何失败都退回内存密钥，
 * 绝不因为一个密钥文件写不了就让插件/中继启动失败。调用方不得把 secret 打日志。
 */
export function loadTicketSecret({
  env = process.env,
  home = homedir(),
  platform = process.platform,
  fs = { mkdirSync, writeFileSync, readFileSync, chmodSync },
  run = spawnSync,
} = {}) {
  const fromEnv = normalizeSecret(env && env.TASKWATCH_TICKET_SECRET)
  if (fromEnv) return { secret: fromEnv, source: 'env', file: '', permission: 'n/a' }

  const file = secretPath(home)
  let existing = ''
  try {
    existing = normalizeSecret(fs.readFileSync(file, 'utf8'))
  } catch { /* 没有文件就走生成 */ }
  if (existing) return { secret: existing, source: 'file', file, permission: 'existing' }

  const secret = randomBytes(32).toString('base64url')
  let permission = 'unknown'
  try {
    fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    // mode 只在创建时生效；已存在的文件由下面的 chmod / icacls 收紧。
    fs.writeFileSync(file, secret + '\n', { mode: 0o600 })
    if (platform === 'win32') {
      // Windows 没有 POSIX 权限位。用 icacls 去掉继承、只给当前用户完全控制。
      // 这一步失败时文件仍在（用户目录下），但权限状态要如实标成 failed。
      const user = String((env && (env.USERNAME || env.USER)) || '').trim()
      if (!user) {
        permission = 'icacls-no-user'
      } else {
        const result = run('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], {
          windowsHide: true,
          timeout: 5000,
        })
        permission = result && result.status === 0 ? 'icacls-owner' : 'icacls-failed'
      }
    } else {
      try {
        fs.chmodSync(file, 0o600)
        permission = 'chmod-600'
      } catch {
        permission = 'chmod-failed'
      }
    }
    return { secret, source: 'generated', file, permission }
  } catch (error) {
    // 目录只读 / 磁盘满：仍然能签发与校验（本进程内），只是无法跨进程互认。
    return {
      secret,
      source: 'memory',
      file,
      permission: 'write-failed',
      error: String((error && error.message) || error),
    }
  }
}
