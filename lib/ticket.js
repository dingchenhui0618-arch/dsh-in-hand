/**
 * 跨进程换路票据（v2）：HMAC 签名，让插件宿主与中继互认同一张票。
 *
 * 背景（2026-10-21 的真实故障）：宿主签的票打到公网（域名后面是中继）→ 中继只认
 * 自己进程内 Map 里的随机串 → 401。两边跑在同一台机器、同一个用户下，所以只要
 * **共用同一个密钥**，就能互相验签而不必共享内存。
 *
 * 票格式（两边必须一致）：
 *   t = 'v2.' + <expMs 十进制> + '.' + <nonce base64url> + '.' + <hmac base64url>
 *   HMAC = HMAC-SHA256(secret, 'v2|' + expMs + '|' + nonce)
 *
 * 安全边界（诚实写清，别把"签名"说成"严格一次性"）：
 *   - 签名保证票是本机签的、内容没被改；短时效（60 秒 TTL）压缩重放窗口；
 *   - 跨进程无法共享"已用过"的状态，所以只在**各自进程内**做 best-effort 去重
 *     （nonce Set + TTL 清理）。两个进程都还没见过的票在窗口内理论上可重放一次。
 *   - 这不是"严格一次性"。要严格一次性得引入共享存储（Redis/SQLite），代价与
 *     可用性影响都不小，当前场景（换路跳转，60 秒）不值得。
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
export const TICKET_RE = /^v2\.\d{13}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}$/
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

/** 签发一张 v2 票。nonce 必须是 16 字节（base64url 后 22 字符）。 */
export function signTicket(secret, { now = Date.now, ttlMs = TICKET_TTL_MS } = {}) {
  if (!normalizeSecret(secret)) throw new Error('票据密钥至少需要 ' + SECRET_MIN_LENGTH + ' 个字符')
  const expMs = now() + ttlMs
  const nonce = randomBytes(16).toString('base64url')
  const hmac = createHmac('sha256', secret).update('v2|' + expMs + '|' + nonce).digest('base64url')
  return 'v2.' + expMs + '.' + nonce + '.' + hmac
}

/** 校验 v2 票。格式不符 / 签名不对 / 过期 / 超出最大跨度 → false（当作"不是本票"）。 */
export function verifyTicket(secret, ticket, { now = Date.now } = {}) {
  if (!normalizeSecret(secret) || typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return false
  const parts = ticket.split('.')
  const expMs = Number(parts[1])
  if (!Number.isSafeInteger(expMs)) return false
  const expected = createHmac('sha256', secret).update('v2|' + expMs + '|' + parts[2]).digest()
  let given
  try {
    given = Buffer.from(parts[3], 'base64url')
  } catch {
    return false
  }
  // timingSafeEqual 要求等长；长度不同本身就不是本票。
  if (given.length !== expected.length) return false
  if (!timingSafeEqual(given, expected)) return false
  const at = now()
  if (!(expMs > at)) return false
  if (expMs - at > TICKET_MAX_AGE_MS) return false
  return true
}

export function nonceOf(ticket) {
  return typeof ticket === 'string' ? String(ticket.split('.')[2] || '') : ''
}

export function expOf(ticket) {
  const n = Number(typeof ticket === 'string' ? ticket.split('.')[1] : NaN)
  return Number.isSafeInteger(n) ? n : 0
}

/** 进程内 best-effort 去重：记下见过的 nonce，过期就清。不是跨进程的严格一次性。 */
export function createReplayGuard({ now = Date.now, max = 1024 } = {}) {
  const seen = new Map()
  const prune = (at) => {
    for (const [nonce, exp] of seen) if (exp <= at) seen.delete(nonce)
  }
  return {
    /** 第一次见到返回 false；重复的 nonce 返回 true。 */
    replayed(nonce, expMs) {
      const at = now()
      if (seen.size >= max) prune(at)
      if (seen.has(nonce)) return true
      seen.set(nonce, Math.max(expMs || 0, at + 1000))
      return false
    },
    get size() { return seen.size },
  }
}

/**
 * 票据闸门：统一签发 v2、统一兑换。
 *
 * redeem 的回落规则是刻意写成"只认格式"的：非 v2 形状（老页面/老票）才走原来的
 * 进程内 Map；一旦长得像 v2 就只按签名/时效判断，签名不对直接拒绝，**不**回落 ——
 * 否则伪造一张 `v2.…` 反而比随机串更容易被误放行。
 */
export function createTicketGate({ secret, store, now = Date.now, ttlMs = TICKET_TTL_MS, replay } = {}) {
  const guard = replay || createReplayGuard({ now })
  return {
    mint() {
      return signTicket(secret, { now, ttlMs })
    },
    redeem(ticket) {
      const text = typeof ticket === 'string' ? ticket.trim() : ''
      if (!text) return false
      if (TICKET_RE.test(text)) {
        if (!verifyTicket(secret, text, { now })) return false
        return !guard.replayed(nonceOf(text), expOf(text))
      }
      // 向后兼容：老格式随机票仍只在本进程 Map 里有效。
      return store ? store.redeem(text) : false
    },
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
