/**
 * dsh-in-hand（掌上 DSH）—— Host 半边
 *
 * 采集 DSH 运行时状态并以两个固定路径暴露：
 *   GET /taskwatch        只读移动页（自带轮询）
 *   GET /taskwatch/data   同一份数据的 JSON
 *
 * 采集面：会话（运行/空闲、最后活动、activeJobs）、后台任务 jobs、
 * 子代理树、目标轮次与阻塞、工作流阶段、等待审批/提问。
 *
 * 只读为主：除对话接口外不写宿主状态、不代理 DSH 自身的 /api。唯一的例外是
 * 换路票据（POST /taskwatch/ticket）—— v1.7.2 起签的是 60 秒、HMAC 签名的票，与中继
 * 共用同一个本机密钥，所以跨进程能互认；v1.8.6 起是**带受众的 v3**（中继只认 remote、
 * 宿主只认 lan）且严格一次性。进程内只记已用的 nonce，不碰会话、文件或配置，
 * 见下方「双入口」一节与 lib/ticket.js。
 *
 * 静态资源（PWA）都挂在 /taskwatch/ 之下，service worker 的作用域也限定为
 * /taskwatch —— 绝不允许它有机会拦截主 GUI 的请求。
 */

// ---- 分区索引（行号为本次注释时）----
//
// 归属依据 docs/PORTABILITY.md：[服务层] 绑 DSH 服务与事件，换宿主需要重写；
// [宿主无关] 页面契约 / 票据 / 设备 / 外壳可原样复用；[契约] 指 URL、字段与错误码，
// 其 handler 仍可能读服务层。
//
// A. 入口与配置（插件元数据 / 静态资源 / 消息读取 / 通用工具，混合）  L41–L243
// B. 换路票据与入口地址（宿主无关）  L244–L354
// C. 设备账本：签发 / 清扫 / 撤销（宿主无关）  L355–L578
// D. 决策桥：审批 / 选项式提问 / 高危判定 / 审计（服务层，绑 DSH）  L579–L1427
// E. 请求门禁与通用小工具（宿主无关）  L1428–L1476
// F. apply 装配：服务读取 / 设备闸门 / 决策桥与运行事件接线 / 上传账本（服务层，绑 DSH）  L1477–L1812
// G. 快照、首页事实与并行结果（服务层，绑 DSH）  L1813–L2197
// H. HTTP 响应工具与交付文件只读出口（含会话引用白名单）（服务层，绑 DSH）  L2198–L2407
// I. 状态与决策页面契约：data / decisions / stream / approve / answer / session（路由与页面契约）  L2408–L2622
// J. 对话（远程控制）：上传 / 会话 / 发送 / 队列 / 流 / 模型（服务层，绑 sessionController）  L2623–L3657
// K. 双入口：entries / ticket（含中继 v3 探测）（路由与页面契约；宿主无关）  L3658–L3956
// L. 设备列表与撤销（路由与页面契约）  L3957–L4074
// M. 页面外壳与静态资源：/taskwatch、manifest、sw、图标（宿主无关）  L4075–L4531
// N. 离屏通知：飞书 / Server酱 / 通用 webhook（服务层 + 路由；凭据只在本机）  L4532–L5221
// O. 系统通知（Web Push）：VAPID / 订阅存储 / 发送器 / 四条路由（v1.8.17）  L5222–

// ===== A. 入口与配置 =====
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { homedir, networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
// 交付文件的解析与安全边界都在 files.js —— 白名单、穿越防护、类型白名单需要能被
// 测试直接调用，放在路由闭包里就证明不了。
import { MAX_BYTES, MAX_SESSION_BYTES, SESSION_PATH_MAX, buildSessionWhitelist, dispositionFor, infoOf, resolveSessionTarget, resolveTarget, rootsFrom } from './files.js'
// 跨进程换路票据：宿主与中继共用同一套 HMAC 格式与密钥解析顺序（v1.8.6 起为带受众的 v3）。
// 单独成模块是为了纯函数能被测试直接钉住，也避免两边各写一份实现后悄悄漂移。
import {
  TICKET_AUD_LAN, TICKET_AUD_REMOTE, TICKET_V2_SUNSET_AT, TICKET_VERSION, TICKET_VERSIONS,
  createTicketGate, loadTicketSecret,
} from './ticket.js'
// Web Push 的三个密码学零件（VAPID / RFC 8291 加密 / 通知口径）单独成模块：
// 它们全是纯函数，能被 scripts/check-webpush.mjs 直接对着 RFC 向量钉字节；
// 混进 4000 行的 index.js 就只能靠"发出去一条看看"来验证了。
// 文件读写、HTTP 与设备绑定仍然在下面 O 段，与通知模块同一套目录与权限习惯。
import {
  PUSH_CONTENT_ENCODING, VAPID_TTL,
  b64url, buildPushMessage, buildPushTestMessage, checkVapidKeys, encryptWebPush,
  generateVapidKeys, unb64url, vapidAuthorization,
} from './webpush.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const ICONS = new Map([
  ['/taskwatch/icon-192.png', { file: join(HERE, 'icons', 'icon-192.png'), type: 'image/png' }],
  ['/taskwatch/icon-512.png', { file: join(HERE, 'icons', 'icon-512.png'), type: 'image/png' }],
])

/** Web app manifest 放在独立文件里，理由与 page.html / sw.js 相同：中继直接读同一个
 *  文件，内联副本迟早会和仓库里的那份漂移。
 *
 *  theme_color / background_color 只能各写一个值（manifest 没有 prefers-color-scheme），
 *  取的是页面 <meta name="theme-color"> 的**亮色真值** #f5f6f7。暗色真值是 #151517，
 *  仍由页面里的 media 查询负责，不在这里重复。
 */
const MANIFEST_FILE = join(HERE, 'manifest.webmanifest')

function readManifest() {
  try {
    return readFileSync(MANIFEST_FILE)
  } catch (e) {
    console.error('dsh-in-hand: 读不到 lib/manifest.webmanifest —— ' + String((e && e.message) || e))
    // 读不到也不能让 <link rel="manifest"> 拿到一段 HTML：回一份最小合法 manifest。
    return Buffer.from(JSON.stringify({
      name: '掌上 DSH', short_name: '掌上 DSH', start_url: '/taskwatch', scope: '/taskwatch',
      display: 'standalone', theme_color: '#f5f6f7', background_color: '#f5f6f7',
    }))
  }
}

/** service worker 与页面外壳一样放在独立文件里，理由相同：内联副本必然漂移。
 *
 * 这里曾经内联过一份，版本停在 taskwatch-v1，而部署侧中继里那份已经升到 v3 并
 * 补上了「删除旧缓存」——同一个插件对外提供了两个行为不同的 SW，取决于请求先命中
 * 谁。所以收敛成一个来源。
 */
function readSw() {
  try {
    return readFileSync(join(HERE, 'sw.js'), 'utf8')
  } catch (e) {
    console.error('dsh-in-hand: 读不到 lib/sw.js —— ' + String((e && e.message) || e))
    return '/* lib/sw.js 缺失，本插件不提供离线外壳 */\n'
  }
}

/** 页面外壳放在独立的 lib/page.html。
 *
 * 为什么不内联在代码里：公开访问的页面由中继直接提供同一个文件（常驻插件挂载
 * 之前也一样可用）。两份内联副本必然漂移，所以只留一个来源，改一处两边同时生效。
 *
 * 为什么**每次请求都重读**而不是启动时读一次（2026-10-10 改）：
 * 中继那边本来就是按请求读盘的，所以手机刷新就生效；而插件这边原先在模块加载时
 * 读一次并缓存，结果是同一份 page.html 有两条生效时机 —— 手机立刻看到新版，
 * 本机 /taskwatch 还是旧版，并且要重启整个客户端才更新。实测：改完页面后手机上
 * 已是 112018 字符的新版，宿主内存里仍是 110001 字符的旧版。
 * 一个几十 KB 的本地文件，每次请求读一次可以忽略，换来的是"改了就生效"。
 *
 * 读不到时降级成一句提示而不是抛异常：一个缺失的静态文件不该让插件加载失败，
 * 那会连带把整个 DSH 的启动拖垮。
 */
function readPage() {
  try {
    return readFileSync(join(HERE, 'page.html'), 'utf8')
  } catch (e) {
    console.error('dsh-in-hand: 读不到 lib/page.html —— ' + String((e && e.message) || e))
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>任务监控</title></head><body style="font:15px/1.6 system-ui;padding:24px">'
      + '<h1 style="font-size:17px">页面外壳读不到</h1>'
      + '<p>lib/page.html 缺失或不可读。数据接口仍可用：<code>/taskwatch/data</code></p>'
      + '</body></html>'
  }
}

/**
 * 从 ContentBlock[] 抽出可读文本。
 *
 * 只取叶子字段，绝不把消息对象或会话日志整个带走 —— 那些是活的内部对象，
 * 序列化它们既不可靠也不安全。这里产出的是新造的纯字符串。
 */
function blocksText(blocks) {
  let out = ''
  if (!Array.isArray(blocks)) return out
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text
  }
  return out
}

/** 从 ContentBlock[] 抽出工具调用名，供一行概览用。 */
function blocksTools(blocks) {
  const names = []
  if (!Array.isArray(blocks)) return names
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'tool-call' && typeof b.name === 'string' && names.indexOf(b.name) < 0) names.push(b.name)
  }
  return names
}

/**
 * 某个会话的可读消息 —— `/taskwatch/session` 与「会话引用白名单」**共用这一份实现**。
 *
 * 为什么抽出来：页面看到的引用与白名单认可的引用必须是同一批文本。两份解析一旦漂移，
 * 就会出现「页面上明明有一张图、服务端却说不在此会话引用里」——而且只会在真机上出现。
 * 返回的 `text` 是完整文本；截断是路由自己的输出格式决定的事。
 */
function readSessionMessages(store, id, limit = 20) {
  const out = { id: String(id || ''), live: false, total: 0, messages: [], error: null }
  if (!out.id) {
    out.error = '缺少 id 参数'
    return out
  }
  const session = store !== undefined && store ? store.get(out.id) : undefined
  if (session === undefined) {
    out.error = '这个会话不在内存里（已落盘但未加载的会话读不到）'
    return out
  }
  out.live = true
  // deriveMessages() 产出的 Message 不带时间，时间从原始事件按 message id 建索引。
  const at = new Map()
  for (const ev of session.snapshotEvents()) {
    const d = ev && ev.data
    if (!d) continue
    if (ev.type === 'user/message' && d.id) at.set(String(d.id), ev.time)
    else if (ev.type === 'assistant/message' && d.message && d.message.id) at.set(String(d.message.id), ev.time)
  }
  const picked = []
  for (const m of session.deriveMessages()) {
    if (!m || m.role === 'system') continue
    const text = blocksText(m.content)
    const tools = blocksTools(m.content)
    if (!text && !tools.length) continue
    picked.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      text,
      tools,
      at: at.get(String(m.id)) || 0,
    })
  }
  out.total = picked.length
  out.messages = Number.isFinite(limit) ? picked.slice(-Math.max(1, Math.floor(limit))) : picked
  return out
}

// 快照的 ETag 算法单独抽成纯函数，就是为了能被直接测。
//
// 关键在于**对 generatedAt 免疫**：它是每次采集都不同的 Date.now()，直接拿整份
// JSON 做哈希的话内容哈希永远在变，304 会退化成永不命中的死代码。所以先把这个
// 字段丢掉再哈希 —— 其余字段（任务状态、标题、计数）才是「内容到底变没变」的
// 真正依据。check-bundle 里有一条单测专门钉住这条性质。
export function etagOf(payload) {
  const stable = JSON.stringify(payload, (key, value) => (key === 'generatedAt' ? undefined : value))
  return '"' + createHash('sha1').update(stable).digest('hex').slice(0, 20) + '"'
}

export const name = 'dsh-in-hand'

// webServer 是**硬依赖**，必须写进 inject，不能只靠 ctx.get() 软读。
//
// 教训（2026-09-21，v1.0.0 的实际故障）：webserver 那一行的服务是在启动阶段
// 之后才发布的，而 apply 会在组合期就被调用。此时 ctx.get('webServer') 拿到
// undefined，于是整段路由注册被静默跳过 —— 现象是 /taskwatch 一律 404，
// 但插件「装好了、也没报错」，极难排查。声明 inject 后 Cordis 会等该服务
// 就绪再调用 apply，从根上消除这个竞态。
//
// 其余服务（jobs / agents / sessions / goals / subagents / sessionTitle）
// 刻意保持软读 ctx.get()：只读监控缺哪块就少显示哪块，不该因为某个服务没装
// 就整页不可用。
export const inject = ['webServer']

const asText = (v) => (typeof v === 'string' ? v : '')
const asNum = (v) => (typeof v === 'number' && isFinite(v) ? v : 0)
const why = (e) => (e && e.message ? String(e.message) : String(e))

const ENV_ASSIGN = /^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=/i

// ===== B. 换路票据与入口地址 =====
// ── 双入口：入口清单与一次性换路票据 ────────────────────────────────────────
//
// 背景（2026-10-21，v1.7.1 修的真实故障）：页面在插件宿主上打开时，点「去远端」
// 会打 POST /taskwatch/ticket 与 GET /taskwatch/entries。这两个接口原先**只有中继
// 实现**，宿主没有：实测宿主回 405 / 404，页面拿不到 url，探测循环每 12 秒再试一次，
// 于是在手机上看就是"点了去远端就一直报错"。
//
// 现在宿主按中继的语义补齐这两条；公网地址只从配置项 publicUrl 来，**绝不写死域名**。
// 没配就只报价局域网入口，ticket 明确回 409 no-public-entry。
//
// v1.7.2：票据从"进程内随机串"升级成 v2 HMAC。根因是宿主签的票打到公网（域名后面是
// 中继）→ 中继只认自己 Map 里的串 → 401。两边共用 <home>/.dsh/taskwatch-ticket.key，
// 所以现在互认；老格式随机票仍回落到进程内 Map。
//
// 鉴权边界不变：宿主这层不做令牌校验（和中继的分工见 README），但 ticket 是**写**路由，
// 所以和中继的写路由一样要求 POST + application/json（跨站表单发不出这个 content-type，
// 天然需要 preflight，而宿主不应答 CORS 预检），另加一道 Origin / Sec-Fetch-Site 校验。
//
// v1.8.6：v2 只解决了"互认"，没解决"这张票是给谁签的"。给局域网入口签的票在 60 秒内
// 能被拿去兑换公网中继（反之亦然），因为两边各记各的 nonce。现在票里带受众（aud）：
//   · 中继只收 aud=remote，宿主只收 aud=lan；
//   · 校验与"标记已用"合并在 lib/ticket.js 的 redeemTicket 一个同步函数里；
//   · 升级顺序任意 —— 插件默认仍签 v2，探测到中继声明支持 v3 才签 v3（见下方
//     relayTicketVersion）。旧中继 + 新插件照常工作，新中继 + 旧插件也照常工作。
export const TICKET_TTL_MS = 60 * 1000
const TICKET_MAX = 256

/** 公网入口只接受纯 origin（https://host[:port]），带路径的一律当作没配 ——
 *  否则 302 的 Location 是根绝对路径，和子路径部署对不上，切换会静默跳到错地方。 */
export function normalizePublicUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  if (!text) return ''
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (!parsed.hostname) return ''
    if (parsed.pathname && parsed.pathname !== '/') return ''
    return parsed.origin
  } catch {
    return ''
  }
}

/** 局域网 IPv4 地址。虚拟网卡（WSL / Hyper-V / docker）不算"手机能连的入口"，
 *  否则入口清单里会出现一个手机永远打不开的地址 —— 那比不显示更糟。 */
const VIRTUAL_IFACE = /vEthernet|Hyper-V|WSL|VMware|VirtualBox|Loopback|docker|Bluetooth|TAP-/i
export function lanAddresses(ifaces, includeVirtual = false) {
  const table = ifaces && typeof ifaces === 'object' ? ifaces : networkInterfaces()
  const out = []
  for (const name of Object.keys(table)) {
    if (!includeVirtual && VIRTUAL_IFACE.test(name)) continue
    for (const addr of table[name] || []) {
      if (!addr || addr.internal) continue
      if (addr.family !== 'IPv4' && addr.family !== 4) continue
      const ip = asText(addr.address)
      if (ip) out.push({ iface: name, ip })
    }
  }
  return out
}

/** 局域网入口也可以指向别处（通常是中继的局域网入口）。
 *
 *  v1.7.3 之前这里和 publicUrl 共用同一个"只收纯 origin"的归一化函数，结果很自然
 *  会写出来的 `http://10.0.51.18:3099/taskwatch`（入口的完整 URL）被**静默丢弃**，
 *  再回落到自动探测内网 IP —— 用户看到的就是"配了 lanUrl 却没生效"。
 *  现在允许且只允许入口自己的那个 `/taskwatch` 后缀：entries / ticket 还会再拼一次，
 *  不把后缀吃掉就会拼成 /taskwatch/taskwatch。其它路径仍然当作没配（返回 ''），
 *  调用方会打一条告警，不再无声无息。 */
export function normalizeLanUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return ''
  const trimmed = text.replace(/\/+$/, '').replace(/\/taskwatch$/, '')
  return normalizePublicUrl(trimmed)
}

/** 票据存储：60 秒、一次性。单独抽出来的原因是"过期"要能被测试钉住 ——
 *  真等 60 秒的测试不会有人跑，而"只删不校验过期"是这类实现最常见的漏洞。
 *
 *  v1.7.2 起它只承担**向后兼容**：老页面的随机串仍在这个 Map 里兑换；新签发的
 *  票是 v2 HMAC（见 lib/ticket.js），跨进程可用。 */
export function createTicketStore({ ttlMs = TICKET_TTL_MS, now = Date.now } = {}) {
  const tickets = new Map()
  return {
    mint() {
      const at = now()
      for (const [key, exp] of tickets) if (exp <= at) tickets.delete(key)
      // 突发时丢最早的一张：票据只有 60 秒寿命，超出上限的多半是重试风暴的残留。
      while (tickets.size >= TICKET_MAX) {
        const oldest = tickets.keys().next().value
        if (oldest === undefined) break
        tickets.delete(oldest)
      }
      const ticket = randomBytes(18).toString('base64url')
      tickets.set(ticket, at + ttlMs)
      return ticket
    },
    /** 命中即删 —— 无论是否过期，同一张票据第二次兑换一律无效。 */
    redeem(ticket) {
      const key = asText(ticket)
      if (!key) return false
      const exp = tickets.get(key)
      if (exp === undefined) return false
      tickets.delete(key)
      return exp > now()
    },
    get size() { return tickets.size },
  }
}

// ===== C. 设备账本 =====
// ── 设备账本（v1.8.7，P4）─────────────────────────────────────────────────
//
// 「现在哪些设备在用这个入口」只能靠**宿主自己签发的设备身份**回答：宿主这层
// 没有账号体系（那会和 danger-full-access 直接冲突），所以身份就是一个随机
// UUID，第一次访问时下发到 HttpOnly + SameSite=Lax 的 twd cookie 里。
//
// 账本只回答两件事：这台设备最近什么时候来过、要不要踢掉它。所以它刻意**只**
// 保留 {firstSeen, lastSeen, ua, via, sessions, revoked}：
//   · ua 是 system/browser 摘要（≤80 字），绝不落完整 UA —— 完整 UA 里带机型、
//     系统小版本与一堆可指纹化的字段，对「显示一行设备名」没有帮助；
//   · 不存 IP（也不需要：判断局域网/公网只留一个 via 枚举）；
//   · sessions 只记**配对事件**（时间 + 入口 + 类型），不存 cookie / 票据原值。
//
// 撤销 = 标记 revoked + 清空 sessions；所有 /taskwatch 动态路由先过设备闸门，
// 被撤销设备的下一次请求一律 401。cookie 是 HttpOnly 的，页面脚本删不掉它。
export const DEVICE_LEDGER_MAX = 50
export const DEVICE_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const DEVICE_COOKIE = 'twd'
export const DEVICE_COOKIE_MAX_AGE = Math.floor(DEVICE_IDLE_TTL_MS / 1000)
export const DEVICE_UA_MAX = 80
export const DEVICE_SESSIONS_MAX = 8
export const DEVICE_RECORD_FIELDS = Object.freeze([
  'firstSeen', 'lastSeen', 'ua', 'via', 'sessions', 'revoked',
])

/** 完整 UA → 一行可读摘要（系统 · 浏览器），上限 80 字符。
 *
 *  这里**不是**截断原 UA：截断后的 `Mozilla/5.0 (iPhone; CPU iPhone OS 17_1...`
 *  既不可读、又把指纹原样留下。只取能认出来的系统/浏览器名，认不出就写「未知设备」。
 *  返回值不会包含完整的 `Mozilla/5.0 (...)` 片段。 */
export function summarizeDeviceUa(raw) {
  const ua = typeof raw === 'string' ? raw : ''
  if (!ua.trim()) return '未知设备'
  const os = []
  const ios = /(iPhone|iPad|iPod)/.exec(ua)
  if (ios) {
    const m = /OS (\d+)[._](\d+)/.exec(ua)
    os.push(ios[1] + (m ? ' · iOS ' + m[1] + '.' + m[2] : ''))
  } else if (/Android/.test(ua)) {
    const m = /Android (\d+(?:\.\d+)?)/.exec(ua)
    os.push('Android' + (m ? ' ' + m[1] : ''))
  } else if (/Windows/.test(ua)) {
    os.push('Windows')
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    os.push('macOS')
  } else if (/CrOS/.test(ua)) {
    os.push('ChromeOS')
  } else if (/Linux/.test(ua)) {
    os.push('Linux')
  }

  let browser = ''
  if (/MicroMessenger\//i.test(ua)) browser = '微信'
  else if (/Edg(?:A|iOS)?\//.test(ua)) browser = 'Edge'
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera'
  else if (/FxiOS\/|Firefox\//.test(ua)) browser = 'Firefox'
  else if (/CriOS\/|Chrome\/|Chromium\//.test(ua)) browser = 'Chrome'
  else if (/Version\/[\d.]+.*Safari\//.test(ua)) browser = 'Safari'
  else if (/curl\//i.test(ua)) browser = '命令行'

  const name = (os.length ? os : ['未知设备']).concat(browser ? [browser] : []).join(' · ')
  return name.length > DEVICE_UA_MAX ? name.slice(0, DEVICE_UA_MAX - 1) + '…' : name
}

const DEVICE_VIA = new Set(['lan', 'remote'])
const deviceVia = (v) => (v === 'remote' ? 'remote' : 'lan')

/** 设备账本。纯内存、进程内；重启即清空 —— 这是有意的，身份的价值只在
 *  「这一次运行里哪些设备还在用」，不是长期账号。
 *
 *  容量与清理规则都要能被注入时间后验证（check-devices.mjs），所以 now 可替换。 */
export function createDeviceLedger({
  max = DEVICE_LEDGER_MAX,
  idleMs = DEVICE_IDLE_TTL_MS,
  now = Date.now,
} = {}) {
  const devices = new Map()
  const digest = (id) => createHash('sha256').update('dsh-in-hand:device:' + String(id)).digest('hex').slice(0, 12)

  function sweep(at) {
    for (const [id, d] of devices) {
      if (at - d.lastSeen > idleMs) devices.delete(id)
    }
  }

  /** 超出容量时淘汰「最久未活跃且未撤销」的那台；如果剩下的全都已撤销，
   *  退而求其次删最久未活跃的（容量是硬上限，不能靠「都是撤销的」破例）。 */
  function evictOne() {
    let victim = ''
    let oldest = Infinity
    for (const [id, d] of devices) {
      if (!d.revoked && d.lastSeen < oldest) { oldest = d.lastSeen; victim = id }
    }
    if (!victim) {
      oldest = Infinity
      for (const [id, d] of devices) {
        if (d.lastSeen < oldest) { oldest = d.lastSeen; victim = id }
      }
    }
    if (victim) devices.delete(victim)
    return victim ? digest(victim) : ''
  }

  function ensure(id, meta = {}) {
    const key = String(id)
    if (!key) return null
    const at = now()
    sweep(at)
    const existing = devices.get(key)
    if (existing) {
      existing.lastSeen = at
      if (meta.ua !== undefined) existing.ua = summarizeDeviceUa(meta.ua)
      if (meta.via !== undefined) existing.via = deviceVia(meta.via)
      if (meta.session) bind(key, meta.session)
      return existing
    }
    if (devices.size >= max) evictOne()
    const record = {
      firstSeen: at,
      lastSeen: at,
      ua: summarizeDeviceUa(meta.ua),
      via: deviceVia(meta.via),
      sessions: [],
      revoked: false,
    }
    devices.set(key, record)
    if (meta.session) bind(key, meta.session)
    return record
  }

  function touch(id, meta = {}) {
    const key = String(id)
    const d = devices.get(key)
    if (!d) return null
    const at = now()
    if (at - d.lastSeen > idleMs) { devices.delete(key); return null }
    d.lastSeen = at
    if (meta.ua !== undefined) d.ua = summarizeDeviceUa(meta.ua)
    if (meta.via !== undefined) d.via = deviceVia(meta.via)
    return d
  }

  /** 绑定一次配对事件（老会话补绑 / 票据兑换 / 首次访问）。只记时间与入口。 */
  function bind(id, meta = {}) {
    const d = devices.get(String(id))
    if (!d) return null
    d.sessions.push({
      at: now(),
      via: deviceVia(meta.via !== undefined ? meta.via : d.via),
      kind: asText(meta.kind) || 'session',
    })
    if (d.sessions.length > DEVICE_SESSIONS_MAX) d.sessions.splice(0, d.sessions.length - DEVICE_SESSIONS_MAX)
    return d
  }

  function get(id) {
    return devices.get(String(id)) || null
  }

  function find(ref) {
    const key = asText(ref)
    if (!key) return null
    if (devices.has(key)) return { id: key, record: devices.get(key) }
    for (const [id, record] of devices) if (digest(id) === key) return { id, record }
    return null
  }

  function list() {
    sweep(now())
    return Array.from(devices, ([id, d]) => ({
      id: digest(id),
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      ua: d.ua,
      via: d.via,
      sessions: d.sessions.length,
      revoked: d.revoked,
    })).sort((a, b) => b.lastSeen - a.lastSeen || b.firstSeen - a.firstSeen)
  }

  /** 撤销：标记 + 清空配对记录。返回 null 表示没有这台设备（别静默成功）。 */
  function revoke(ref) {
    const hit = find(ref)
    if (!hit) return null
    const { id, record } = hit
    const sessions = record.sessions.length
    record.revoked = true
    record.sessions = []
    return { id, digest: digest(id), record, sessions }
  }

  return { ensure, touch, bind, get, find, list, revoke, digest, max, idleMs, get size() { return devices.size } }
}

/** 被撤销设备的页面响应。**不是** SPA：它要在一个已经被 401 的导航里也能
 *  自己说清楚发生了什么，所以是独立的最小 HTML（明暗跟随系统）。 */
function revokedPageHtml() {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<meta name="theme-color" content="#f5f6f7"><title>设备已被撤销 · 掌上 DSH</title>'
    + '<style>'
    + ':root{color-scheme:light dark}'
    + 'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;'
    + 'font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;'
    + 'background:#f5f6f7;color:#0f1115}'
    + 'main{max-width:360px;width:100%;padding:24px;border:1px solid rgba(0,0,0,.1);'
    + 'border-radius:16px;background:#fff;box-sizing:border-box}'
    + 'h1{margin:0 0 8px;font-size:19px;letter-spacing:0}'
    + 'p{margin:0 0 20px;color:#61666b}'
    + 'a{display:flex;align-items:center;justify-content:center;min-height:48px;border-radius:12px;'
    + 'background:#0f1115;color:#f5f6f7;text-decoration:none;font-weight:600}'
    + 'small{display:block;margin-top:16px;color:#6b7076;font-size:12px;line-height:1.6}'
    + '@media (prefers-color-scheme:dark){body{background:#151517;color:#f9fafb}'
    + 'main{background:#1b1b1c;border-color:rgba(255,255,255,.14)}p{color:#adb2b8}'
    + 'a{background:#f9fafb;color:#151517}small{color:#979da6}}'
    + '</style></head><body><main>'
    + '<h1>此设备已被撤销</h1>'
    + '<p>这台设备上的会话已经销毁，不能再读取任务与对话。</p>'
    + '<a href="/taskwatch?pair=1">重新配对</a>'
    + '<small>如果这不是你做的，请在桌面端打开设备列表检查。</small>'
    + '</main></body></html>'
}

// ===== D. 决策桥（审批 / 提问 / 高危 / 审计） =====
// ── 手机端一次性审批（v1.8.0）─────────────────────────────────────────────
//
// approval/request 是 waterfall：不调 next() 就等于认领了这次审批。手机端只允许
// allowed-once / rejected 两个结论，绝不提供 always-allow —— 那会把一次性放行
// 变成永久的写权限。四条失败语义比功能本身更重要：
//   1. 没有手机在线 → 立刻 next()，一秒都不等；
//   2. 超时 / 内部异常 → next()，宁可手机没批到也不能把 agent 悬在半空；
//   3. req.signal abort（桌面已处理）→ 立刻交还；
//   4. 手机决定只成功一次，重复提交 409，过期或已交还 410。
export const APPROVAL_TIMEOUT_DEFAULT_MS = 120 * 1000
export const APPROVAL_TIMEOUT_MIN_MS = 10 * 1000
export const APPROVAL_TIMEOUT_MAX_MS = 600 * 1000
export const PHONE_ONLINE_TTL_MS = 15 * 1000
export const APPROVAL_TOMBSTONE_MS = 60 * 1000
export const AUDIT_FILE_NAME = 'taskwatch-audit.log'
export const AUDIT_REASON_MAX = 120
// v1.8.3：选项式提问。标题取 header，没有就取问题前 40 字；自定义回答上限
// 2000 字 —— 再长就不是"补一句"，而是把手机当编辑器用了。
export const QUESTION_TITLE_MAX = 40
export const ANSWER_CUSTOM_MAX = 2000
// 一条回答最多覆盖 12 道题、每题最多 24 个选项：宿主自己也会截断到这个量级，
// 校验侧与展示侧用同一个上界，避免"页面上看不见、却必须回答"的题。
export const QUESTION_MAX_ITEMS = 12
export const QUESTION_MAX_OPTIONS = 24

// ── 高危动作二次确认（v1.8.8，P4 收尾）────────────────────────────────────
//
// 判定**只在宿主侧**做：页面拿到的只有 pending.risk === 'high' | 'normal'，
// 绝不把默认模式表交给页面、也不让页面用正则自己猜。原因有三条：
//   1. 页面是唯一暴露在公网的静态资源，模式表放进去等于公开我们的安全策略；
//   2. 审批请求的真实字段（reason / displayReason）只在宿主手里，页面看到的
//      是被截断过的快照，按快照匹配会漏；
//   3. 以后改判定（加规则、调边界）不该要求已安装的 PWA 换外壳。
//
// 匹配对象是 toolName + reason + displayReason —— **不是完整命令**：我们本来
// 就不存命令全文（审计也不记），能拿来判断的只有宿主自己生成的这几段说明。
// 所以这是一道"按可见信息加的门槛"，不是命令级沙箱；绕过文案的调用仍可能
// 被判成 normal，真正的权限边界仍然是桌面端。
//
// 默认模式（README 里逐条公布；用户可增删）：
//   命令类：rm -rf、Remove-Item、del /f、format、mkfs、shutdown、Stop-Process、
//           taskkill /F、DROP TABLE、TRUNCATE、git push --force、npm publish、
//           git tag -d、git reset --hard
//   路径类：.ssh、.dsh、C:\Windows、/etc、.git
// 路径类按"被操作对象"匹配：模式必须以 `.` `/` `~` 或盘符开头，且前后不能紧挨
// 字母数字 —— 否则 `.gitignore` 会被当成 `.git`，把一次普通读取也标成高危。
export const HIGH_RISK_PATTERN_MAX_ITEMS = 64
export const HIGH_RISK_PATTERN_MAX_LENGTH = 120
export const DEFAULT_HIGH_RISK_PATTERNS = Object.freeze([
  'rm -rf',
  'Remove-Item',
  'del /f',
  'format',
  'mkfs',
  'shutdown',
  'Stop-Process',
  'taskkill /F',
  'DROP TABLE',
  'TRUNCATE',
  'git push --force',
  'npm publish',
  'git tag -d',
  'git reset --hard',
  '.ssh',
  '.dsh',
  'C:\\Windows',
  '/etc',
  '.git',
])

/** 配置声明的可读形态。Cordis 这一层没有强校验器，真正的钳制在
 *  resolveApprovalConfig() 里，并由 check-approval.mjs / check-risk.mjs 逐条钉住。 */
export const APPROVAL_CONFIG_SCHEMA = Object.freeze({
  approveFromPhone: { type: 'boolean', default: true, description: '允许手机端批准 / 拒绝一次工具调用、回答选项式提问' },
  approvalTimeoutMs: {
    type: 'integer',
    default: APPROVAL_TIMEOUT_DEFAULT_MS,
    minimum: APPROVAL_TIMEOUT_MIN_MS,
    maximum: APPROVAL_TIMEOUT_MAX_MS,
    description: '手机等待决定的毫秒数；越界取边界值',
  },
  highRiskPatterns: {
    type: 'array',
    items: { type: 'string', maxLength: HIGH_RISK_PATTERN_MAX_LENGTH },
    maxItems: HIGH_RISK_PATTERN_MAX_ITEMS,
    default: DEFAULT_HIGH_RISK_PATTERNS,
    description: '判定为高危的模式（大小写不敏感；最多 '
      + HIGH_RISK_PATTERN_MAX_ITEMS + ' 条、每条 ≤' + HIGH_RISK_PATTERN_MAX_LENGTH + ' 字符）',
  },
  riskConfirm: {
    type: 'boolean',
    default: true,
    description: '高危动作在手机上是否要两步确认；false 只显示高危徽标，点击直接提交',
  },
})

/** 把任意配置值收敛成 { approveFromPhone, timeoutMs, highRiskPatterns, riskConfirm }。
 *  越界不是"忽略"，而是取边界值并 warn —— 用户改小到 5 秒以为生效，实际 10 秒，
 *  必须让他知道；直接忽略则会悄悄回到 120 秒，更难查。
 *  高危模式同理：65 条只留前 64 条、超长的截到 120 字符，都要在启动时说出来 ——
 *  悄悄丢掉一条规则，等于悄悄拆掉一道门槛。 */
export function resolveApprovalConfig(config, warn = () => {}) {
  const src = config && typeof config === 'object' ? config : {}
  const approveFromPhone = src.approveFromPhone !== false
  const raw = src.approvalTimeoutMs
  let timeoutMs = APPROVAL_TIMEOUT_DEFAULT_MS
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(n)) {
      timeoutMs = Math.round(n)
      if (timeoutMs < APPROVAL_TIMEOUT_MIN_MS) {
        timeoutMs = APPROVAL_TIMEOUT_MIN_MS
        warn('approvalTimeoutMs 小于 ' + APPROVAL_TIMEOUT_MIN_MS + '，已按最小值处理')
      } else if (timeoutMs > APPROVAL_TIMEOUT_MAX_MS) {
        timeoutMs = APPROVAL_TIMEOUT_MAX_MS
        warn('approvalTimeoutMs 大于 ' + APPROVAL_TIMEOUT_MAX_MS + '，已按最大值处理')
      }
    } else {
      warn('approvalTimeoutMs 不是数字，已按默认值 ' + APPROVAL_TIMEOUT_DEFAULT_MS + ' 处理')
    }
  }

  let highRiskPatterns = DEFAULT_HIGH_RISK_PATTERNS.slice()
  const riskRaw = src.highRiskPatterns
  if (riskRaw !== undefined && riskRaw !== null) {
    if (!Array.isArray(riskRaw)) {
      warn('highRiskPatterns 不是数组，已按默认的 ' + DEFAULT_HIGH_RISK_PATTERNS.length + ' 条处理')
    } else {
      const list = []
      const seen = new Set()
      let truncated = 0
      let dropped = 0
      for (const item of riskRaw) {
        if (typeof item !== 'string') { dropped++; continue }
        let pattern = item.trim()
        if (!pattern) { dropped++; continue }
        if (pattern.length > HIGH_RISK_PATTERN_MAX_LENGTH) {
          pattern = pattern.slice(0, HIGH_RISK_PATTERN_MAX_LENGTH)
          truncated++
        }
        const key = pattern.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        list.push(pattern)
      }
      if (truncated) {
        warn('highRiskPatterns 有 ' + truncated + ' 条超过 ' + HIGH_RISK_PATTERN_MAX_LENGTH
          + ' 字符，已截断后再匹配')
      }
      if (dropped) warn('highRiskPatterns 有 ' + dropped + ' 项不是非空字符串，已忽略')
      if (list.length > HIGH_RISK_PATTERN_MAX_ITEMS) {
        warn('highRiskPatterns 超过 ' + HIGH_RISK_PATTERN_MAX_ITEMS + ' 条，已只保留前 '
          + HIGH_RISK_PATTERN_MAX_ITEMS + ' 条')
        list.length = HIGH_RISK_PATTERN_MAX_ITEMS
      }
      highRiskPatterns = list
    }
  }

  return { approveFromPhone, timeoutMs, highRiskPatterns, riskConfirm: src.riskConfirm !== false }
}

/** 路径类的默认模式（`.ssh` / `/etc` / `C:\Windows` …）只在"作为被操作对象"时命中：
 *  前后不能紧挨字母数字，否则 `.gitignore` 会命中 `.git`。大小写不敏感；
 *  反斜杠统一成 `/`，这样 `C:\Windows` 与 `C:/Windows` 是同一个模式。 */
function isPathLikePattern(pattern) {
  return /^(?:\.|\/|~\/|[a-z]:\/)/i.test(pattern)
}

function hitHighRiskPattern(text, raw) {
  const pattern = String(raw || '').replace(/\\/g, '/').toLowerCase().trim()
  if (!pattern) return false
  const pathLike = isPathLikePattern(pattern)
  let from = 0
  while (from <= text.length) {
    const at = text.indexOf(pattern, from)
    if (at < 0) return false
    if (!pathLike) return true
    const before = at === 0 ? '' : text.charAt(at - 1)
    const after = text.charAt(at + pattern.length)
    const boundary = (ch) => ch === '' || !/[a-z0-9_]/.test(ch)
    if (boundary(before) && boundary(after)) return true
    from = at + 1
  }
  return false
}

/** 宿主侧风险判定：返回 'high' | 'normal'。
 *  输入刻意只有三段文本 —— toolName、reason（宿主原始说明）、detail（displayReason）。
 *  页面拿到的永远是这里算好的结果，不是命令本身。 */
export function assessRisk({ toolName = '', reason = '', detail = '' } = {}, patterns = DEFAULT_HIGH_RISK_PATTERNS) {
  const parts = []
  for (const value of [toolName, reason, detail]) {
    if (typeof value === 'string' && value) parts.push(value)
  }
  if (!parts.length) return 'normal'
  const text = parts.join('\n').replace(/\\/g, '/').toLowerCase()
  for (const pattern of patterns) {
    if (hitHighRiskPattern(text, pattern)) return 'high'
  }
  return 'normal'
}

/** 审计日志路径与 DSH 自己的目录习惯保持一致：DSH_HOME 优先，否则 ~/.dsh。 */
export function auditLogPath(env = process.env, home = homedir()) {
  const raw = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const root = raw ? resolve(raw) : join(home, '.dsh')
  return join(root, AUDIT_FILE_NAME)
}

/** JSON Lines 审计：追加写，不记录完整命令，只记 toolName 与 reason 前 120 字。
 *  Windows 用 icacls 去掉继承、只留当前用户；POSIX 用 chmod 600。写失败只 warn
 *  一次 —— 审计不该反过来阻断审批链。 */
export function createAuditLog({
  file,
  platform = process.platform,
  fs = { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync },
  run = spawnSync,
  logger = console,
  env = process.env,
} = {}) {
  let ready = false
  let warned = false
  const warnOnce = (msg) => {
    if (warned) return
    warned = true
    try { if (logger && typeof logger.error === 'function') logger.error('dsh-in-hand: ' + msg) } catch { /* 日志失败不影响主链路 */ }
  }
  const ensure = () => {
    if (ready) return true
    try {
      fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 })
      if (platform === 'win32') {
        const user = String((env && (env.USERNAME || env.USER)) || '').trim()
        if (!user) {
          warnOnce('审计日志无法识别当前用户，权限未收紧：' + file)
        } else {
          const result = run('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], {
            windowsHide: true,
            timeout: 5000,
          })
          if (!result || result.status !== 0) warnOnce('审计日志权限收紧失败（icacls）：' + file)
        }
      } else {
        fs.chmodSync(file, 0o600)
      }
      ready = true
      return true
    } catch (e) {
      warnOnce('审计日志不可写（' + why(e) + '）：' + file)
      return false
    }
  }
  return {
    file,
    write(entry) {
      try {
        if (!ensure()) return false
        fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
        return true
      } catch (e) {
        warnOnce('审计日志写入失败（' + why(e) + '）：' + file)
        return false
      }
    },
  }
}

/** 一次决定的状态机。单独成纯函数是为了让 50ms 超时能被测试真正跑完，
 *  而不是靠"读源码里有没有 setTimeout"这种假绿灯。
 *
 *  v1.8.3：同一个 broker 现在同时承载「一次性审批」与「选项式提问」两种决定。
 *  刻意**不**再写一套并行实现 —— 超时、abort、只成功一次、墓碑清理、
 *  审计这五件事对两者完全一样，差别只在 settle 时带不带 answers、审计写什么。
 *  kind 缺省仍是 approval，所以 v1.8.0 的调用点与语义一个字都没变。 */
export function createApprovalBroker({
  timeoutMs = APPROVAL_TIMEOUT_DEFAULT_MS,
  now = Date.now,
  newId = randomUUID,
  audit = () => {},
  onSettled = () => {},
} = {}) {
  const decisions = new Map()

  function sweep() {
    const at = now()
    for (const [id, d] of decisions) {
      if (d.settled && at - d.settledAt > APPROVAL_TOMBSTONE_MS) decisions.delete(id)
    }
  }

  /** 审计的两种形状都收敛在这里：审批记 toolName / reason，提问记
   *  kind/title/selectedCount/custom —— 两者都刻意**不记答案原文**，
   *  只记"选了几个、有没有自定义"，避免把用户写的话写进日志。 */
  function auditEntry(d, outcome, by, extra) {
    const at = new Date(d.settledAt).toISOString()
    if (d.kind === 'question') {
      const entry = { at, session: d.session, kind: 'question', title: d.title, outcome, by }
      if (extra && Array.isArray(extra.answers)) {
        let selectedCount = 0
        let custom = false
        for (const a of extra.answers) {
          if (a && Array.isArray(a.selected)) selectedCount += a.selected.length
          if (a && a.custom) custom = true
        }
        entry.selectedCount = selectedCount
        entry.custom = custom
      }
      return entry
    }
    // v1.8.8：审批决定行追加 risk（字段名不变，只是多一个词）。判定在宿主侧
    // 完成，审计据此能回答"这次放行是不是高危动作"，而仍然不记命令全文。
    const entry = {
      at,
      session: d.session,
      toolName: d.toolName,
      outcome,
      by,
      risk: d.risk === 'high' ? 'high' : 'normal',
    }
    if (d.reason) entry.reason = String(d.reason).slice(0, AUDIT_REASON_MAX)
    return entry
  }

  function settle(d, outcome, by, extra) {
    if (d.settled) return false
    d.settled = true
    d.settledBy = by
    d.settledAt = now()
    if (d.timer) { clearTimeout(d.timer); d.timer = null }
    if (d.signal && d.onAbort) {
      try { d.signal.removeEventListener('abort', d.onAbort) } catch { /* 已移除 */ }
      d.onAbort = null
    }
    try { audit(auditEntry(d, outcome, by, extra)) } catch { /* 审计失败不影响决定 */ }
    const result = { outcome, delegated: by !== 'phone', by, ...(extra || {}) }
    try { onSettled(d, result) } catch { /* 推送失败不影响决定 */ }
    d.resolve(result)
    return true
  }

  /** 所有「还能不能决定」的判定都收在这里，decide() 与 answer() 共用 ——
   *  这样 404 / 409 / 410 三档对两种决定完全一致，不会各自漂移。 */
  function claim(id) {
    sweep()
    const d = decisions.get(asText(id))
    if (!d) {
      return { error: { status: 404, body: { ok: false, code: 'unknown-id', error: '未知的请求（可能已经过期）' } } }
    }
    const asked = d.kind === 'question' ? '这次提问' : '这次审批'
    if (d.settled) {
      if (d.settledBy === 'phone') {
        return { error: { status: 409, body: { ok: false, code: 'already-decided', error: asked + '已经处理过了' } } }
      }
      return { error: { status: 410, body: { ok: false, code: 'expired-or-delegated', error: asked + '已过期或已交还桌面' } } }
    }
    if (now() >= d.expiresAt) {
      settle(d, 'delegated', 'timeout')
      return { error: { status: 410, body: { ok: false, code: 'expired-or-delegated', error: asked + '已过期或已交还桌面' } } }
    }
    if (d.signal && d.signal.aborted) {
      settle(d, 'cancelled', 'desktop')
      return { error: { status: 410, body: { ok: false, code: 'expired-or-delegated', error: asked + '已过期或已交还桌面' } } }
    }
    return { decision: d }
  }

  return {
    decisions,
    begin({ session = '', toolName = '', reason = '', signal = null, kind = 'approval', title = '', questions = null, risk = 'normal' } = {}) {
      sweep()
      const at = now()
      const id = newId()
      const expiresAt = at + timeoutMs
      let resolvePromise
      const promise = new Promise((resolve) => { resolvePromise = resolve })
      const d = {
        id,
        session,
        toolName,
        reason,
        at,
        expiresAt,
        resolve: resolvePromise,
        settled: false,
        settledBy: '',
        settledAt: 0,
        signal: null,
        onAbort: null,
        timer: null,
        // v1.8.8：'high' | 'normal'。只影响展示与审计，不影响能不能放行 ——
        // 这道门槛是"再确认一次"，不是新的权限。
        risk: risk === 'high' ? 'high' : 'normal',
        // 提问专用（kind 仍是 'approval' 时全部为空，不改变旧行为）
        kind,
        title: String(title || ''),
        questions: Array.isArray(questions) ? questions : null,
      }
      decisions.set(id, d)
      d.timer = setTimeout(() => settle(d, 'delegated', 'timeout'), timeoutMs)
      if (d.timer && typeof d.timer.unref === 'function') d.timer.unref()
      if (signal) {
        d.signal = signal
        if (signal.aborted) {
          settle(d, 'cancelled', 'desktop')
        } else {
          d.onAbort = () => settle(d, 'cancelled', 'desktop')
          try { signal.addEventListener('abort', d.onAbort, { once: true }) } catch { /* 不是标准 AbortSignal */ }
        }
      }
      return { id, expiresAt, promise }
    },
    decide(id, decision) {
      // 防御性再判一次：即使路由层被改坏，broker 也只接受这两个词。
      if (decision !== 'allow' && decision !== 'reject') {
        return { status: 400, body: { ok: false, code: 'bad-request', error: 'decision 只能是 allow 或 reject' } }
      }
      const got = claim(id)
      if (got.error) return got.error
      const outcome = decision === 'allow' ? 'allowed-once' : 'rejected'
      settle(got.decision, outcome, 'phone')
      return { status: 200, body: { ok: true, outcome } }
    },
    /** 认领一次提问并带回答案。校验在 createQuestionGate 里先做完再调这里 ——
     *  400 绝不能把这次提问消费掉，否则一次手滑就永久丢失回答机会。 */
    answer(id, answers) {
      const got = claim(id)
      if (got.error) return got.error
      if (got.decision.kind !== 'question') {
        return { status: 404, body: { ok: false, code: 'unknown-id', error: '未知的提问（可能已经过期）' } }
      }
      settle(got.decision, 'answered', 'phone', { answers })
      return { status: 200, body: { ok: true, answers } }
    },
    list() {
      const at = now()
      return [...decisions.values()]
        .filter((d) => !d.settled && at < d.expiresAt)
        .map((d) => ({
          id: d.id,
          kind: d.kind,
          session: d.session,
          toolName: d.toolName,
          title: d.title,
          reason: d.reason,
          at: d.at,
          expiresAt: d.expiresAt,
          risk: d.kind === 'question' ? undefined : d.risk,
        }))
    },
  }
}

/** 审批闸门：把「记录 → 判断在线 → 认领 → 等结果」串成一条控制流。
 *  所有内部异常只吞在自己的这一段；next() 自身的异常必须原样抛出去，不能重试。 */
export function createApprovalGate({
  approveFromPhone = true,
  timeoutMs = APPROVAL_TIMEOUT_DEFAULT_MS,
  isPhoneOnline = () => false,
  now = Date.now,
  newId = randomUUID,
  highRiskPatterns = DEFAULT_HIGH_RISK_PATTERNS,
  audit = () => {},
  onPending = () => {},
  onRelease = () => {},
  onBroadcast = () => {},
  onError = () => {},
} = {}) {
  const pendingByDecision = new Map()
  const broker = createApprovalBroker({
    timeoutMs,
    now,
    newId,
    audit,
    onSettled(d, result) {
      const entry = pendingByDecision.get(d.id)
      if (entry) {
        entry.canDecide = false
        entry.settled = true
      }
      pendingByDecision.delete(d.id)
      try {
        onBroadcast({ type: 'approval', state: 'settled', id: d.id, outcome: result.outcome, by: result.by })
      } catch { /* 推送失败不影响决定 */ }
    },
  })

  async function handle(req, next) {
    let pendingKey = ''
    let entry = null
    let claim = null
    let session = ''
    let toolName = ''
    let reason = ''
    try {
      session = req && req.agent ? String(req.agent.id) : ''
      toolName = asText(req && req.toolName) || '(tool)'
      const shown = req && req.displayReason && typeof req.displayReason === 'object'
        ? (asText(req.displayReason['zh-CN']) || asText(req.displayReason['zh']) || asText(req.displayReason.en))
        : ''
      const rawReason = asText(req && req.reason)
      reason = shown || rawReason
      // v1.8.8：判定在宿主侧完成。toolName + reason（宿主原始说明）+ detail
      // （displayReason 的中文/英文展示文案）—— 页面不参与，也不拿命令全文。
      const risk = assessRisk({ toolName, reason: rawReason, detail: shown }, highRiskPatterns)
      const at = now()
      const pendingId = newId()
      const expiresAt = at + timeoutMs
      pendingKey = 'approval:' + ((req && req.callId ? String(req.callId) : '') || pendingId)
      entry = {
        kind: 'approval',
        id: pendingId,
        session,
        title: toolName,
        detail: reason,
        risk,
        at,
        expiresAt,
        timeoutMs,
        canDecide: false,
        settled: false,
      }
      onPending(pendingKey, entry)

      const aborted = Boolean(req && req.signal && req.signal.aborted)
      if (approveFromPhone && !aborted && isPhoneOnline()) {
        claim = broker.begin({ session, toolName, reason, signal: req ? req.signal : null, risk })
        entry.id = claim.id
        entry.expiresAt = claim.expiresAt
        entry.canDecide = true
        onPending(pendingKey, entry)
        pendingByDecision.set(claim.id, entry)
        try {
          onBroadcast({
            type: 'approval',
            state: 'pending',
            id: claim.id,
            session,
            toolName,
            reason: String(reason).slice(0, 240),
            risk,
            expiresAt: claim.expiresAt,
          })
        } catch { /* 推送失败不影响等待 */ }
      }
    } catch (e) {
      // 内部异常也要留审计：outcome=error / by=error。错误消息可能带命令内容，
      // 所以只记会话与工具名，不把 e.message 写进去。
      try {
        audit({
          at: new Date(now()).toISOString(),
          session,
          toolName,
          outcome: 'error',
          by: 'error',
        })
      } catch { /* 审计失败不影响主链路 */ }
      try { onError(e, { session, toolName, reason }) } catch { /* 观测失败不影响主链路 */ }
      if (pendingKey) onRelease(pendingKey)
      return await next()
    }

    if (!claim) {
      try { return await next() } finally { if (pendingKey) onRelease(pendingKey) }
    }

    const result = await claim.promise
    if (entry) {
      entry.canDecide = false
      entry.settled = true
    }
    pendingByDecision.delete(claim.id)
    if (result.delegated) {
      try { return await next() } finally { if (pendingKey) onRelease(pendingKey) }
    }
    if (pendingKey) onRelease(pendingKey)
    return result.outcome
  }

  return {
    handle,
    decide: broker.decide,
    list: broker.list,
    get decisions() { return broker.decisions },
    timeoutMs,
  }
}

/** 提问标题：header 优先，否则问题正文前 40 字（折叠空白，超长加省略号）。
 *  单独成纯函数是为了让「标题取对了没有」能被断言，而不是靠截图肉眼判断。 */
export function questionTitleOf(item) {
  const header = asText(item && item.header).trim()
  const question = asText(item && item.question).replace(/\s+/g, ' ').trim()
  const base = header || question || '(提问)'
  return base.length > QUESTION_TITLE_MAX ? base.slice(0, QUESTION_TITLE_MAX) + '…' : base
}

/** 请求里的 questions[] 收敛成**纯标量**：只留页面要显示、校验要用的字段。
 *  绝不把请求对象本身带进内存 —— 那是活着的宿主对象，序列化与生命周期都不由我们决定。
 *  没有 id 的题直接丢掉：没有 id 就无法对齐答案，留着只会让"必须覆盖全部题目"永远失败。 */
export function normalizeQuestionItems(request) {
  const raw = request && Array.isArray(request.questions) ? request.questions : []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = asText(item.id)
    if (!id) continue
    const options = []
    if (Array.isArray(item.options)) {
      for (const o of item.options) {
        if (!o || typeof o !== 'object') continue
        const label = asText(o.label)
        if (!label) continue
        options.push({ label, description: asText(o.description) })
        if (options.length >= QUESTION_MAX_OPTIONS) break
      }
    }
    const intent = item.intent && typeof item.intent === 'object' && item.intent.kind === 'plan-review'
      ? { kind: 'plan-review', approve: asText(item.intent.approve) }
      : null
    out.push({
      id,
      question: asText(item.question),
      header: asText(item.header),
      detail: asText(item.detail),
      options,
      multiSelect: item.multiSelect === true,
      intent,
    })
    if (out.length >= QUESTION_MAX_ITEMS) break
  }
  return out
}

/** 回答校验（纯函数）。规则逐条对应 README 里公布的那份清单：
 *    ① 必须覆盖请求里所有 questions[].id（多答不认识的 id 也算错）；
 *    ② selected 只能取该题 options[].label 里的值；
 *    ③ multiSelect=false 时最多一个；
 *    ④ custom ≤ 2000 字符。
 *  失败一律带 field，指向具体是哪一条（`answers[1].selected` 这种），
 *  否则页面上只能得到一句"参数不对"，用户无从修正。 */
export function validateAnswers(questions, rawAnswers) {
  const fail = (field, error) => ({ ok: false, field, error })
  if (!Array.isArray(rawAnswers)) return fail('answers', 'answers 必须是数组')
  const list = questions && Array.isArray(questions) ? questions : []
  const byId = new Map(list.map((q) => [q.id, q]))
  const seen = new Set()
  const answers = []
  for (let i = 0; i < rawAnswers.length; i++) {
    const item = rawAnswers[i]
    if (!item || typeof item !== 'object') return fail('answers[' + i + ']', '每条回答必须是对象')
    const id = asText(item.id)
    if (!id) return fail('answers[' + i + '].id', '缺少题目 id')
    const q = byId.get(id)
    if (!q) return fail('answers[' + i + '].id', '这个题目不在本次请求里（id 不匹配）')
    if (seen.has(id)) return fail('answers[' + i + '].id', '同一道题被回答了两次')
    seen.add(id)
    if (!Array.isArray(item.selected)) return fail('answers[' + i + '].selected', 'selected 必须是数组')
    const selected = []
    for (const label of item.selected) {
      if (typeof label !== 'string') return fail('answers[' + i + '].selected', 'selected 只能包含字符串')
      if (!q.options.some((o) => o.label === label)) {
        return fail('answers[' + i + '].selected', '「' + label.slice(0, 60) + '」不在题目给出的 options 里')
      }
      if (selected.indexOf(label) < 0) selected.push(label)
    }
    if (!q.multiSelect && selected.length > 1) {
      return fail('answers[' + i + '].selected', '这道题是单选，最多只能选一个')
    }
    let custom
    if (item.custom !== undefined && item.custom !== null) {
      if (typeof item.custom !== 'string') return fail('answers[' + i + '].custom', 'custom 必须是字符串')
      if (item.custom.length > ANSWER_CUSTOM_MAX) {
        return fail('answers[' + i + '].custom', 'custom 不能超过 ' + ANSWER_CUSTOM_MAX + ' 字符')
      }
      custom = item.custom
    }
    const answer = { id, selected }
    if (custom !== undefined) answer.custom = custom
    answers.push(answer)
  }
  for (let qi = 0; qi < list.length; qi++) {
    if (!seen.has(list[qi].id)) {
      return fail('answers[' + qi + ']', '缺少这道题的回答：' + list[qi].id)
    }
  }
  return { ok: true, answers }
}

/** 提问闸门：控制流与 createApprovalGate 完全同形（记录 → 在线判断 → 认领 → 等答案），
 *  只是认领的是 user-questions/request、带回来的是 { answers }。
 *  失败语义逐条对齐审批：离线 / 超时 / abort / 内部异常都只交还 next()。
 *
 *  复用面（这是刻意的，不另建机制）：broker（超时 + 一次性 + 墓碑）、
 *  audit 回调、isPhoneOnline、同一条 SSE 流、同一个 approvalTimeoutMs。 */
export function createQuestionGate({
  enabled = true,
  timeoutMs = APPROVAL_TIMEOUT_DEFAULT_MS,
  isPhoneOnline = () => false,
  now = Date.now,
  newId = randomUUID,
  audit = () => {},
  onPending = () => {},
  onRelease = () => {},
  onBroadcast = () => {},
  onError = () => {},
} = {}) {
  const pendingById = new Map()
  const broker = createApprovalBroker({
    timeoutMs,
    now,
    newId,
    audit,
    onSettled(d, result) {
      const entry = pendingById.get(d.id)
      if (entry) {
        entry.canDecide = false
        entry.settled = true
      }
      pendingById.delete(d.id)
      try {
        onBroadcast({ type: 'question', state: 'settled', id: d.id, outcome: result.outcome, by: result.by })
      } catch { /* 推送失败不影响决定 */ }
    },
  })

  async function handle(request, next) {
    // 解析失败（极端情况：带 getter 抛错的请求对象）也不能挡住宿主，直接交还。
    let questions
    try {
      questions = normalizeQuestionItems(request)
    } catch {
      return next()
    }
    // 没有可回答的题目时，连观测卡都不必建 —— 没有 id 就没有"回答"这件事。
    if (!questions.length) return next()

    let pendingKey = ''
    let entry = null
    let claim = null
    let session = ''
    let title = ''
    try {
      session = request && request.agent ? String(request.agent.id) : ''
      const first = questions[0]
      title = questionTitleOf(first)
      const at = now()
      const pendingId = newId()
      const expiresAt = at + timeoutMs
      const waitId = request && request.wait && request.wait.callId ? String(request.wait.callId) : ''
      // 同一次工具调用的重复水合不该出现两张卡：有 callId 就用它做键。
      pendingKey = 'question:' + (waitId || pendingId)
      entry = {
        kind: 'question',
        id: pendingId,
        session,
        title,
        detail: (first.detail || first.question || '').slice(0, 1000),
        options: first.options.slice(),
        multiSelect: first.multiSelect,
        intent: first.intent,
        // 多题回答要能逐题渲染：页面拿这份完整清单，扁平字段只是给单题卡片用的摘要。
        questions: questions.slice(),
        at,
        expiresAt,
        timeoutMs,
        canDecide: false,
        settled: false,
      }
      onPending(pendingKey, entry)

      const aborted = Boolean(request && request.signal && request.signal.aborted)
      if (enabled && !aborted && isPhoneOnline()) {
        claim = broker.begin({ session, kind: 'question', title, questions, signal: request ? request.signal : null })
        entry.id = claim.id
        entry.expiresAt = claim.expiresAt
        entry.canDecide = true
        onPending(pendingKey, entry)
        pendingById.set(claim.id, entry)
        try {
          onBroadcast({
            type: 'question',
            state: 'pending',
            id: claim.id,
            session,
            title: String(title).slice(0, 240),
            expiresAt: claim.expiresAt,
          })
        } catch { /* 推送失败不影响等待 */ }
      }
    } catch (e) {
      // 内部异常也留审计：outcome=error / by=error。绝不把 e.message 写进去
      // （里面可能带题目正文或答案），只记会话、kind 与标题。
      try {
        audit({ at: new Date(now()).toISOString(), session, kind: 'question', title, outcome: 'error', by: 'error' })
      } catch { /* 审计失败不影响主链路 */ }
      try { onError(e, { session, title }) } catch { /* 观测失败不影响主链路 */ }
      if (pendingKey) onRelease(pendingKey)
      return next()
    }

    if (!claim) {
      try { return await next() } finally { if (pendingKey) onRelease(pendingKey) }
    }

    const result = await claim.promise
    if (entry) {
      entry.canDecide = false
      entry.settled = true
    }
    pendingById.delete(claim.id)
    if (result.delegated) {
      try { return await next() } finally { if (pendingKey) onRelease(pendingKey) }
    }
    if (pendingKey) onRelease(pendingKey)
    // 认领成功：这就是 AskUserQuestionAnswer —— 不调 next()，直接交给宿主。
    return { answers: Array.isArray(result.answers) ? result.answers : [] }
  }

  return {
    handle,
    /** 手机提交答案。先校验内容再认领：400 不能被当成"用掉了一次机会"。 */
    answer(id, answers) {
      const key = asText(id)
      const d = broker.decisions.get(key)
      if (d && d.kind === 'question') {
        const checked = validateAnswers(d.questions, answers)
        if (!checked.ok) {
          return {
            status: 400,
            body: { ok: false, code: 'bad-request', field: checked.field, error: checked.error },
          }
        }
        return broker.answer(key, checked.answers)
      }
      // 未知 id / 过期 / 已交还 / 已答过 / 不是提问：统一交给 broker 判，错误码与审批一致。
      return broker.answer(key, answers)
    },
    list: broker.list,
    get decisions() { return broker.decisions },
    timeoutMs,
  }
}

/** 写路由的跨站门禁：显式声明 cross-site 的直接拒；带 Origin 的必须与 Host 同源。
 *  没有 Origin 的（curl、非浏览器客户端）放行 —— 与"宿主不做令牌校验"的边界一致，
 *  这里只负责挡住浏览器里的跨站页面。 */
// ===== E. 请求门禁与通用小工具 =====
function isCrossSite(req) {
  const headers = (req && req.headers) || {}
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return true
  const origin = asText(headers.origin)
  if (!origin) return false
  let originHost = ''
  try { originHost = new URL(origin).host.toLowerCase() } catch { return true }
  const host = asText(headers.host).toLowerCase()
  return Boolean(host) && originHost !== host
}

function hostOnly(value) {
  return asText(value).toLowerCase().replace(/:\d+$/, '')
}

function requestHost(req) {
  return hostOnly(req && req.headers && req.headers.host)
}

/** 端口取自请求的 Host 头 —— 这样同一个插件在任意端口上都报得对，不需要写死 52676。 */
function requestPort(req) {
  const m = /:(\d+)$/.exec(asText(req && req.headers && req.headers.host))
  if (!m) return ''
  const port = Number(m[1])
  return Number.isFinite(port) && port > 0 && port < 65536 ? String(port) : ''
}

/** 后台任务的 label 常是多行 shell 命令（含纯环境变量赋值行），折成一行可读文本。 */
function cleanLabel(raw) {
  const all = asText(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!all.length) return ''
  const kept = all.filter((line) => !ENV_ASSIGN.test(line))
  const chosen = kept.length ? kept : all
  const joined = chosen.join(' ; ').replace(/\s+/g, ' ').trim()
  return joined.length > 140 ? joined.slice(0, 137) + '\u2026' : joined
}

const isActiveJob = (status) => status === 'running' || status === 'stopping'

function safe(fn, fallback, errors, label) {
  try {
    return fn()
  } catch (e) {
    if (errors && label) errors.push(label + ': ' + why(e))
    return fallback
  }
}

// ===== F. apply 装配 =====
export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const approvalConfig = resolveApprovalConfig(settings, (msg) => {
    console.error('dsh-in-hand: ' + msg)
  })
  const jobsSvc = ctx.get('jobs')
  const agentsSvc = ctx.get('agents')
  const sessionsSvc = ctx.get('sessions')
  const goalsSvc = ctx.get('goals')
  const subagentsSvc = ctx.get('subagents')
  const titlesSvc = ctx.get('sessionTitle')
  const rawWebServer = ctx.get('webServer')

  // ── 设备身份与闸门（v1.8.7，P4）────────────────────────────────────────
  //
  // 所有 /taskwatch 动态路由统一在注册层包一层：先认设备，再进原 handler。
  // 放在注册层而不是每个 handler 里，是因为漏包一条就是一个后门；静态资源
  // （外壳 / SW / 图标 / manifest）必须放行，否则被撤销的设备连错误页都拿不到。
  const deviceLedger = createDeviceLedger()
  let devicePublicUrl = ''
  const DEVICE_OPEN_PATHS = new Set([
    '/taskwatch',
    '/taskwatch/sw.js',
    '/taskwatch/manifest.webmanifest',
    '/taskwatch/icon-192.png',
    '/taskwatch/icon-512.png',
  ])

  function readCookies(req) {
    const out = Object.create(null)
    const raw = asText(req && req.headers && req.headers.cookie)
    if (!raw) return out
    for (const part of raw.split(';')) {
      const i = part.indexOf('=')
      if (i <= 0) continue
      const key = part.slice(0, i).trim()
      if (!key || out[key] !== undefined) continue
      let value = part.slice(i + 1).trim()
      try { value = decodeURIComponent(value) } catch { /* 非法编码按原文 */ }
      out[key] = value
    }
    return out
  }

  function addCookie(res, value) {
    try {
      const prev = typeof res.getHeader === 'function' ? res.getHeader('set-cookie') : undefined
      const list = prev === undefined
        ? []
        : (Array.isArray(prev) ? prev.slice() : [String(prev)])
      list.push(value)
      res.setHeader('set-cookie', list)
    } catch { /* 已断开的响应 */ }
  }

  function deviceCookie(id, maxAge = DEVICE_COOKIE_MAX_AGE) {
    return DEVICE_COOKIE + '=' + encodeURIComponent(String(id || ''))
      + '; Path=/taskwatch; HttpOnly; SameSite=Lax; Max-Age=' + maxAge
  }

  function requestVia(req) {
    const cookies = readCookies(req)
    if (cookies['tw-route'] === 'remote') return 'remote'
    if (devicePublicUrl) {
      try {
        const host = hostOnly(asText(req && req.headers && req.headers.host))
        if (host && host === hostOnly(new URL(devicePublicUrl).host)) return 'remote'
      } catch { /* 配置了非法 URL 时按局域网 */ }
    }
    return 'lan'
  }

  /** 认设备：没有就发一张新身份（老客户端不会因此下线），被撤销则回 ok:false。
   *  老会话（有 tw-route 换路标记、没有 twd）在这里补绑，不踢下线。 */
  function ensureDevice(req, res) {
    const cookies = readCookies(req)
    const via = requestVia(req)
    const ua = asText(req && req.headers && req.headers['user-agent'])
    const raw = asText(cookies[DEVICE_COOKIE])
    const found = raw ? deviceLedger.find(raw) : null
    if (found && found.record.revoked) {
      return {
        ok: false, revoked: true, id: found.id, record: found.record,
        digest: deviceLedger.digest(found.id), via, fresh: false,
      }
    }
    let id = found ? found.id : ''
    let record = id ? deviceLedger.touch(id, { ua, via }) : null
    let fresh = false
    if (!record) {
      id = randomUUID()
      record = deviceLedger.ensure(id, { ua, via })
      fresh = true
      // 老会话补绑：v1.6–v1.8.6 的页面只有 tw-route 标记，没有设备 cookie。
      if (cookies['tw-route']) deviceLedger.bind(id, { via, kind: 'legacy-session' })
      addCookie(res, deviceCookie(id))
    }
    const info = { id, record, fresh, via, digest: deviceLedger.digest(id) }
    try { req.taskwatchDevice = info } catch { /* 只读请求对象 */ }
    return { ok: true, ...info }
  }

  function deviceRejected(res) {
    send(res, 401, 'application/json; charset=utf-8', JSON.stringify({
      ok: false,
      code: 'device-revoked',
      revoked: true,
      error: '此设备已被撤销，请重新配对',
    }))
  }

  const webServer = rawWebServer && typeof rawWebServer.register === 'function'
    ? {
        register(route) {
          const path = String((route && route.path) || '')
          if (!route || route.kind !== 'exact' || DEVICE_OPEN_PATHS.has(path)) {
            return rawWebServer.register(route)
          }
          const inner = route.handler
          return rawWebServer.register({
            ...route,
            handler: (req, res) => {
              const gate = ensureDevice(req, res)
              if (!gate.ok) { deviceRejected(res); return }
              return inner(req, res)
            },
          })
        },
      }
    : rawWebServer

  // 只保留标量，绝不持有 live 的 Service / Agent / Session 对象。
  const approvals = new Map()
  const questions = new Map()
  const runningById = new Map()
  const runs = new Map()

  // 「有手机在线」的判据只复用手头已有的两条现成通道：
  //   · 手机页每 5 秒打一次 /taskwatch/data?view=phone（桌面 GUI 打的是不带
  //     view 的同一个接口，故意不算在线，否则桌面开着面板会让手机审批空等 120 秒）；
  //   · 手机页可见时保持一条 /taskwatch/approvals/stream SSE，隐藏时关闭
  //     （页面 stopPolling 里一起收），所以锁屏 / 切走就等于离线。
  // TTL 15 秒覆盖三次漏拍；没有任何连接或最近活动就立刻 next()。
  let phoneLastSeenAt = 0
  const approvalStreams = new Set()
  const markPhoneSeen = () => { phoneLastSeenAt = Date.now() }
  const phoneOnline = () => approvalStreams.size > 0 || (Date.now() - phoneLastSeenAt) <= PHONE_ONLINE_TTL_MS

  const auditLog = createAuditLog({ file: auditLogPath() })
  const writeAudit = (entry) => auditLog.write(entry)

  // ── 离屏通知（v1.8.15）──────────────────────────────────────────────────
  //
  // 接线只有一处：approvals / questions 两个 Map 的任何一次进出都 poke 一次，
  // 「何时推、推几条」全在 createNotifier 里（见 N 段）。这里刻意不判断"手机在不在线"
  // —— 恰恰是手机不在的时候才需要推到飞书；也不在 gate 里加分支，免得把审批的
  // 四条失败语义搅进通知逻辑。
  const notifyConfig = resolveNotifyConfig(settings.notify, (msg) => {
    console.error('dsh-in-hand: ' + msg)
  })
  const notifyStore = createNotifyStore({ file: notifyConfigPath() })
  let notifySender = null
  const sendNotify = (channel, text) => {
    // 按需创建：没配通道的机器连 fetch 都不用碰。
    if (!notifySender) notifySender = createNotifySender()
    return notifySender.send(channel, text)
  }

  // ── 系统通知（v1.8.17）──────────────────────────────────────────────────
  //
  // 与上面的通道共享同一个合并窗口：一次 flush 里先给通道，再给每台设备的订阅
  // 各发一条。两边都是"发不出去也不能影响审批链"的形状，所以 push 的失败也只
  // 进审计（一行 `push failed`），不 throw 到 notifier 外面。
  // 设备被撤销后不再给它推：订阅按 deviceId 绑定，但设备账本才是"这台手机还在不在"
  // 的权威 —— 撤销后下一次请求就 401 了，还往它锁屏上推是错的。
  const pushStore = createPushStore({ file: pushStorePath() })
  const vapidStore = createVapidStore({ file: vapidKeyPath() })
  let pushSender = null
  const sendPush = (target, message) => {
    // 只在真有订阅时才碰 VAPID 密钥文件（第一次发送会生成一对）。
    if (!pushSender) pushSender = createWebPushSender({ vapid: () => vapidStore.get() })
    return pushSender.send(target, message)
  }
  const pushTargets = () => {
    let active = null
    try { active = new Set(deviceLedger.list().filter((d) => !d.revoked).map((d) => d.id)) } catch { active = null }
    return pushStore.targets().filter((t) => !active || active.has(t.deviceId))
  }

  const notifier = createNotifier({
    enabled: notifyConfig.enabled,
    debounceMs: notifyConfig.debounceMs,
    store: notifyStore,
    send: sendNotify,
    audit: writeAudit,
    pending: () => [
      ...approvals.values(),
      ...questions.values(),
    ],
    pushTargets,
    sendPush,
    onPushGone(id) { try { pushStore.drop(id) } catch { /* 删不掉就下次再删 */ } },
  })
  const notifyPoke = () => {
    try { notifier.poke() } catch { /* 通知失败不影响审批链 */ }
  }

  function broadcastApproval(event) {
    if (!approvalStreams.size) return
    // v1.8.3：同一条流也推提问事件，只是事件名不同。页面按 event 名监听，
    // 所以审批 / 提问各走各的处理函数，共用一条连接与同一个「手机在线」信号。
    const name = event && event.type === 'question' ? 'question' : 'approval'
    const frame = 'event: ' + name + '\ndata: ' + JSON.stringify(event) + '\n\n'
    for (const res of approvalStreams) {
      try { res.write(frame) } catch { /* 单条断开的流不影响其它 */ }
    }
  }

  const approvalGate = createApprovalGate({
    approveFromPhone: approvalConfig.approveFromPhone,
    timeoutMs: approvalConfig.timeoutMs,
    highRiskPatterns: approvalConfig.highRiskPatterns,
    isPhoneOnline: phoneOnline,
    audit: writeAudit,
    onPending(key, entry) { approvals.set(key, entry); notifyPoke() },
    onRelease(key) { approvals.delete(key); notifyPoke() },
    onBroadcast: broadcastApproval,
    onError(error) {
      // 审计由 gate 自己写入（outcome=error / by=error），这里只留一条运维日志。
      console.error('dsh-in-hand: 审批内部异常，已交还桌面：' + why(error))
    },
  })

  // approval/request 是 waterfall：认领成功才返回 allowed-once / rejected，
  // 其余所有失败路径（离线 / 超时 / abort / 内部异常）都必须交还 next()。
  ctx.on('approval/request', (req, next) => approvalGate.handle(req, next))

  // ── 手机端回答选项式提问（v1.8.3）──────────────────────────────────────────
  //
  // user-questions/request 与 approval/request 一样是 waterfall：不调 next() 就是
  // 认领。这里刻意**复用**审批那套 broker / 超时 / 审计 / 在线判断 / SSE，
  // 只把"带回什么"从 allowed-once 换成 { answers }。四条失败语义逐条对齐：
  // 离线立刻 next()、超时 next() 且审计 by=timeout、abort 立刻交还、内部异常 next()。
  //
  // 待回答项仍然进同一个 `questions` Map —— /taskwatch/data 的 pending 里两种卡
  // 用 kind 区分（approval / question），页面不需要第二套清单接口。
  const questionGate = createQuestionGate({
    enabled: approvalConfig.approveFromPhone,
    timeoutMs: approvalConfig.timeoutMs,
    isPhoneOnline: phoneOnline,
    audit: writeAudit,
    onPending(key, entry) { questions.set(key, entry); notifyPoke() },
    onRelease(key) { questions.delete(key); notifyPoke() },
    onBroadcast: broadcastApproval,
    onError(error) {
      console.error('dsh-in-hand: 提问内部异常，已交还桌面：' + why(error))
    },
  })

  ctx.on('user-questions/request', (request, next) => questionGate.handle(request, next))

  // 只保存本入口签发的会话内上传记录；大小来自实际字节流而非客户端声明。
  // 文件仍由宿主 receipt 授权，图片由不透明 token 授权；成功接收后才消费。
  const pendingUploads = new Map()
  const UPLOAD_TTL_MS = 30 * 60 * 1000
  const MAX_PENDING_UPLOADS = 128
  const MAX_SESSION_UPLOADS = 16
  let activeUploads = 0

  ctx.on('agent/status', (payload) => {
    try {
      const id = payload && payload.agent ? String(payload.agent.id) : ''
      if (id) runningById.set(id, payload.status === 'running')
    } catch { /* 观测失败不能影响主链路 */ }
  })

  ctx.on('api-session/status', (sessionId, isRunning) => {
    try {
      if (typeof sessionId === 'string') runningById.set(sessionId, isRunning === true)
    } catch { /* 同上 */ }
  })

  ctx.on('workflow/start', (info) => {
    try {
      const id = info ? String(info.id) : ''
      if (!id) return
      const meta = info.meta || {}
      runs.set(id, {
        id,
        name: asText(meta.name),
        description: asText(meta.description),
        phase: '',
        logs: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      })
    } catch { /* 同上 */ }
  })

  ctx.on('workflow/phase', (info, title) => {
    try {
      const id = info ? String(info.id) : ''
      if (!id) return
      const known = runs.get(id)
      const meta = (info && info.meta) || {}
      runs.set(id, {
        id,
        name: known ? known.name : asText(meta.name),
        description: known ? known.description : asText(meta.description),
        phase: asText(title),
        logs: known ? known.logs : 0,
        startedAt: known ? known.startedAt : Date.now(),
        updatedAt: Date.now(),
      })
    } catch { /* 同上 */ }
  })

  ctx.on('workflow/log', (info) => {
    try {
      const id = info ? String(info.id) : ''
      const known = id ? runs.get(id) : undefined
      if (known) {
        known.logs = asNum(known.logs) + 1
        known.updatedAt = Date.now()
      }
    } catch { /* 同上 */ }
  })

  ctx.on('workflow/end', (info) => {
    try {
      const id = info ? String(info.id) : ''
      if (id) runs.delete(id)
    } catch { /* 同上 */ }
  })

// ===== G. 快照与首页事实 =====
  // ── 首页要的会话事实（v1.8.2，P1）────────────────────────────────────────
  //
  // 「在跑」那三条要一句话说清「它现在在干什么、跑了多久」，底部那行还想要今日
  // 轮次 / 步数。这些只能从事件里读：tool/call 给出最新动作，turn/start 给出本轮
  // 起点，step/start 数得出本轮第几步。
  //
  // 成本是这里唯一的风险点：snapshot() 每 2 秒最多跑一次，而事件可能上万条。
  // 所以三条约束 ——
  //   ① 只对「在跑」或「今天有过活动」的会话算；
  //   ② 同一会话的 seq 没变就直接复用上次结果（空闲会话几乎每轮都命中）；
  //   ③ 单次最多回看 FACTS_MAX_EVENTS 条，读不完就标 partial：页面宁可不显示
  //      今日数字，也不编一个偏小的数字出来。
  const FACTS_MAX_EVENTS = 400
  const factsCache = new Map()
  // v1.8.10：并行视图要区分「失败 / 运行中 / 已结束」。失败只能从事件里读：
  // 最后一条 turn/end 的 reason.kind === 'error'（DSH 的 TurnEndReason），
  // 原因在 reason.error.message / reason.error.code。
  //
  // 成本：这是**每个会话**都要问一次的（失败可能发生在几天前），不像 facts 只算
  // 在跑 / 今天的。所以单独一份缓存、按 seq 失效，并且只回看最后 40 条 ——
  // 一个空闲会话的末尾几条就是上次 turn 的收尾，读 40 条足够；读不到就返回 null
  // （宁可不标失败，也不编一个失败出来）。
  const OUTCOME_MAX_EVENTS = 40
  const outcomeCache = new Map()
  const dayStart = (() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  })()

  function eachEventBackward(session, seq, limit, visit) {
    let own = null
    try {
      if (typeof session.ownEvents === 'function') own = session.ownEvents()
    } catch { own = null }
    if (Array.isArray(own)) {
      let seen = 0
      for (let i = own.length - 1; i >= 0 && seen < limit; i--, seen++) {
        if (visit(own[i]) === false) return 'full'
      }
      return own.length > limit ? 'capped' : 'full'
    }
    let seen = 0
    for (let k = 1; k <= limit; k++, seen++) {
      let ev = null
      try { ev = session.eventAt(seq - k) } catch { ev = null }
      if (!ev) return 'full'
      if (visit(ev) === false) return 'full'
    }
    return seq > limit ? 'capped' : 'full'
  }

  /** 一个会话的事实：最新工具 / 本轮步数 / 本轮起点 / 今日轮次与步数。 */
  function sessionFacts(session, seq) {
    const key = String(session.id)
    const hit = factsCache.get(key)
    if (hit && hit.seq === seq) return hit.value
    const value = {
      lastTool: '',
      lastToolAt: 0,
      turnStartedAt: 0,
      stepsInTurn: null,
      todayTurns: 0,
      todaySteps: 0,
      partial: false,
    }
    let turnSeen = false
    let toolSeen = false
    let steps = 0
    let seenAny = 0
    let oldest = 0
    const visit = (e) => {
      if (!e || typeof e.type !== 'string') return true
      seenAny++
      const t = Number(e.time) || 0
      if (t) oldest = t
      if (!toolSeen && e.type === 'tool/call') {
        toolSeen = true
        value.lastTool = asText(e.data && e.data.name).slice(0, 60)
        value.lastToolAt = t
      }
      if (!turnSeen) {
        if (e.type === 'turn/start') {
          turnSeen = true
          value.turnStartedAt = t
          value.stepsInTurn = steps
        } else if (e.type === 'step/start') steps++
      }
      if (!t || t >= dayStart) {
        if (e.type === 'turn/start') value.todayTurns++
        else if (e.type === 'step/start') value.todaySteps++
      }
      return true
    }
    const status = eachEventBackward(session, seq, FACTS_MAX_EVENTS, visit)
    if (!seenAny) value.partial = true
    if (status === 'capped' && oldest && oldest >= dayStart) value.partial = true
    factsCache.set(key, { seq, value })
    if (factsCache.size > 400) {
      let drop = factsCache.size - 400
      for (const k of factsCache.keys()) {
        if (drop-- <= 0) break
        factsCache.delete(k)
      }
    }
    return value
  }

  /** 一个会话最后一批事件里，最近一次 turn/end 的结局。
   *
   *  只报两类「失败」：reason.kind === 'error'（模型 / 工具 / 宿主报错）和
   *  'max-tokens'（这一轮被输出上限截断，继续等下去也不会有结果）。
   *  aborted / interrupted 是用户或宿主主动停的，不算失败 —— 把它们也标红会让
   *  「失败」变成噪音，反而埋掉真正需要看的那条。
   *
   *  返回 { at, kind, reason } 或 null（还在跑 / 读不到 / 正常结束）。 */
  function sessionOutcome(session, seq) {
    const key = String(session.id)
    const hit = outcomeCache.get(key)
    if (hit && hit.seq === seq) return hit.value
    let value = null
    const visit = (e) => {
      if (!e || typeof e.type !== 'string') return true
      if (e.type === 'turn/end') {
        const r = (e.data && e.data.reason) || {}
        const kind = asText(r.kind)
        const at = Number(e.time) || 0
        if (kind === 'error') {
          const err = r.error || {}
          const reason = asText(err.message) || asText(err.code) || '回合以错误结束'
          // 截到 300 字：页面只显示 60 字，但留出空间给后续文案调整。
          value = { at, kind, reason: reason.slice(0, 300) }
        } else if (kind === 'max-tokens') {
          value = { at, kind, reason: '输出达到上限，这一轮被截断' }
        } else {
          value = { at, kind, reason: '' }
        }
        return false
      }
      // 末尾先撞上 turn/start = 这一轮还没收口，没有可报的结局。
      if (e.type === 'turn/start') return false
      return true
    }
    eachEventBackward(session, seq, OUTCOME_MAX_EVENTS, visit)
    outcomeCache.set(key, { seq, value })
    if (outcomeCache.size > 400) {
      let drop = outcomeCache.size - 400
      for (const k of outcomeCache.keys()) {
        if (drop-- <= 0) break
        outcomeCache.delete(k)
      }
    }
    return value
  }

  async function snapshot() {
    const now = Date.now()
    const errors = []
    const out = {
      generatedAt: now,
      totals: { sessions: 0, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
      sessions: [],
      jobs: [],
      subagents: [],
      pending: [],
      workflows: [],
      // v1.8.8：页面只读这个开关决定高危卡片要不要两步确认；模式表不下发。
      riskConfirm: approvalConfig.riskConfirm,
      // 今日轮次 / 步数（首页底部那一行）。partial=true 时页面不显示这两个数字：
      // 读不全就不报，比报个偏小的数更接近事实。
      today: { since: dayStart, turns: 0, steps: 0, sessions: 0, partial: false },
      errors,
    }

    let agents = []
    if (agentsSvc) {
      const listed = safe(() => agentsSvc.list(), null, errors, 'agents.list')
      if (Array.isArray(listed)) agents = listed
    }

    // jobs.list 按属主围栏：不带 caller 只返回无主任务，
    // 所以必须逐个 agent 追问，才能看到各会话自己的后台任务。
    const activeByOwner = new Map()
    if (jobsSvc) {
      const seen = new Set()
      const addJob = (s) => {
        try {
          const id = String(s.id)
          if (seen.has(id)) return
          seen.add(id)
          if (out.jobs.length >= 120) return
          const status = asText(s.status)
          const owner = s.ownerSession ? String(s.ownerSession) : ''
          if (owner && isActiveJob(status)) activeByOwner.set(owner, (activeByOwner.get(owner) || 0) + 1)
          out.jobs.push({
            id,
            kind: asText(s.kind),
            label: cleanLabel(s.label),
            status,
            owner,
            detail: asText(s.detail),
            startedAt: asNum(s.startedAt),
            finishedAt: asNum(s.finishedAt),
          })
        } catch { /* 单条坏数据不该毁掉整次采集 */ }
      }
      const unowned = safe(() => jobsSvc.list(), null, errors, 'jobs.list')
      if (Array.isArray(unowned)) unowned.forEach(addJob)
      for (const a of agents) {
        const owned = safe(() => jobsSvc.list(a), null, null, '')
        if (Array.isArray(owned)) owned.forEach(addJob)
      }
      out.jobs.sort((x, y) => {
        const rx = isActiveJob(x.status) ? 0 : 1
        const ry = isActiveJob(y.status) ? 0 : 1
        return rx - ry || y.startedAt - x.startedAt
      })
    }

    let live = []
    if (sessionsSvc) {
      const listed = safe(() => sessionsSvc.list(), null, errors, 'sessions.list')
      if (Array.isArray(listed)) live = listed
    }

    for (const session of live) {
      try {
        const id = String(session.id)
        const header = session.header || {}
        // 最后活动时间取自日志末条事件的 time；seq 是排他上界。
        let lastActivity = asNum(header.createdAt)
        const seq = asNum(session.seq)
        if (seq > 0) {
          const ev = safe(() => session.eventAt(seq - 1), null, null, '')
          if (ev && typeof ev.time === 'number') lastActivity = ev.time
        }
        let title = ''
        if (titlesSvc) {
          const t = safe(() => titlesSvc.get(session), null, null, '')
          if (t) title = asText(t.title)
        }
        const owner = agents.find((a) => String(a.id) === id)
        const isRunning = runningById.get(id) === true
        // 首页「在跑」那一行与底部计数用的事实。只对在跑 / 今天动过的会话算，
        // 其余会话连事件都不看 —— 手机页每 3 秒轮询，这一圈不能变贵。
        let facts = null
        if (seq > 0 && (isRunning || lastActivity >= dayStart)) {
          facts = safe(() => sessionFacts(session, seq), null, null, '')
        }
        // 失败与「在不在跑」互斥：正在跑的一轮还没有 turn/end，上一轮的 error
        // 不该把这一条继续标成失败。outcome 的缓存与 facts 各自按 seq 失效。
        // 正在跑的会话不必回看：此刻它没有 turn/end，失败也轮不到它显示。
        const outcome = !isRunning && seq > 0
          ? safe(() => sessionOutcome(session, seq), null, null, '')
          : null
        const failed = outcome && (outcome.kind === 'error' || outcome.kind === 'max-tokens')
        if (facts) {
          out.today.sessions++
          out.today.turns += facts.todayTurns
          out.today.steps += facts.todaySteps
          if (facts.partial) out.today.partial = true
        }
        let goal = null
        if (goalsSvc && owner) {
          const g = safe(() => goalsSvc.get(owner), null, null, '')
          if (g) {
            goal = {
              phase: asText(g.phase),
              activation: asText(g.activation),
              roundsStarted: asNum(g.roundsStarted),
              maxGoalRounds: asNum(g.maxGoalRounds),
              objective: asText(g.objective).slice(0, 200),
              blockedCode: g.blockedReason ? asText(g.blockedReason.code) : '',
              blockedMessage: g.blockedReason ? asText(g.blockedReason.message).slice(0, 400) : '',
            }
          }
        }
        out.sessions.push({
          id,
          title,
          running: isRunning,
          activeJobs: activeByOwner.get(id) || 0,
          origin: asText(header.origin),
          parent: header.parentSession ? String(header.parentSession) : '',
          depth: asNum(header.delegationDepth),
          preset: asText(header.agentPreset),
          createdAt: asNum(header.createdAt),
          lastActivity,
          // 「在跑」那一行的三个数字（v1.8.2）。读不到就是空 / 0，页面自己降级显示。
          lastTool: facts ? facts.lastTool : '',
          lastToolAt: facts ? facts.lastToolAt : 0,
          turnStartedAt: facts ? facts.turnStartedAt : 0,
          stepsInTurn: facts && typeof facts.stepsInTurn === 'number' ? facts.stepsInTurn : null,
          live: Boolean(owner),
          goal,
          // v1.8.10（并行视图）：失败时给一句原因。只在**已结束**的轮次上给，
          // 正在跑的一轮不看上一轮的旧错误；读不到就是 null，页面按正常结束处理。
          failure: failed
            ? { at: Number(outcome.at) || 0, kind: outcome.kind, reason: outcome.reason }
            : null,
        })
      } catch { /* 同上 */ }
    }
    out.sessions.sort((a, b) => b.lastActivity - a.lastActivity)

    if (subagentsSvc) {
      for (const a of agents) {
        let rootId = ''
        try { rootId = String(a.id) } catch { rootId = '' }
        if (!rootId) continue
        let list = null
        try {
          list = await subagentsSvc.listDescendants(rootId)
        } catch {
          list = null // 投影未挂载时会抛；这是可接受的缺失，不算采集错误
        }
        if (!Array.isArray(list)) continue
        for (const entry of list) {
          try {
            if (entry.kind !== 'child') continue
            out.subagents.push({
              id: String(entry.id),
              parent: entry.parentId ? String(entry.parentId) : '',
              depth: asNum(entry.depth),
              activity: asText(entry.activity),
              mode: asText(entry.mode),
              label: asText(entry.label),
            })
          } catch { /* 同上 */ }
        }
        if (out.subagents.length > 250) break
      }
      // 每个 root 的 listDescendants 已经返回整棵树，跨 root 会重复。
      const seenSub = new Set()
      out.subagents = out.subagents.filter((x) => {
        if (seenSub.has(x.id)) return false
        seenSub.add(x.id)
        return true
      })
    }

    out.pending = Array.from(approvals.values()).concat(Array.from(questions.values()))
    out.pending.sort((a, b) => a.at - b.at)
    out.workflows = Array.from(runs.values())

    out.totals.sessions = out.sessions.length
    out.totals.running = out.sessions.filter((x) => x.running).length
    out.totals.jobs = out.jobs.length
    out.totals.jobsRunning = out.jobs.filter((x) => isActiveJob(x.status)).length
    out.totals.subagents = out.subagents.length
    out.totals.workflows = out.workflows.length
    out.totals.pending = out.pending.length
    return out
  }

  // snapshot() 一次要问一圈服务：jobs.list(每个 agent 一次) + sessions.list
  // + 每个会话的 eventAt/title/goal + 每个 agent 的 listDescendants。手机页面
  // 每 3 秒轮询，桌面面板和多个标签页还会各来一份，叠加起来相当可观。
  //
  // 所以在这里收口：TTL 内共享同一份采集结果，并发请求共用同一个 Promise
  // （不是各算各的），并给出 ETag —— 内容没变就让客户端走 304 只收一个头。
  const SNAPSHOT_TTL_MS = 2000
  let cached = null
  let inflight = null

  async function snapshotCached() {
    const now = Date.now()
    if (cached !== null && now - cached.at < SNAPSHOT_TTL_MS) return cached
    if (inflight !== null) return inflight
    inflight = (async () => {
      const payload = await snapshot()
      const json = JSON.stringify(payload)
      // 回给客户端的内容仍然带 generatedAt（页面要用它算时长），
      // 但 ETag 不能受它影响 —— 见 etagOf 的注释。
      cached = { at: Date.now(), json, etag: etagOf(payload) }
      return cached
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

// ===== H. HTTP 响应工具与交付文件出口 =====
  function send(res, status, type, body, extra) {
    try {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
        'x-content-type-options': 'nosniff',
        ...(extra || {}),
      })
      res.end(body)
    } catch {
      try { res.end('') } catch { /* 响应已断开 */ }
    }
  }

  if (webServer !== undefined) {
    /** 审批决定很小（一个 id + 一个词），8KB 上限足够，也不需要流式。 */
    const readApprovalBody = (req, limit = 8 * 1024) => new Promise((resolveBody, rejectBody) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          rejectBody(new Error('请求体过大'))
          try { req.destroy() } catch { /* 已断开 */ }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
      req.on('error', rejectBody)
    })

    // ── 交付文件只读出口 ────────────────────────────────────────────────────
    //
    // 两个用途：手机页里**直接看到**模型产出的图（而不是"下载了一个文件"），
    // 以及看到 PDF 这类交付物的名字 / 大小 / 类型。两条来源：
    //   ?id=<attachmentId>  宿主 attachments 服务里的对象，字节由它校验完整性；
    //   ?path=<绝对路径>    白名单根目录下的文件，符号链接与 `..` 都会被拒。
    // ?info=1 只回元数据 —— 文件卡片先拿它填名字与大小，不下整份字节。
    //
    // 只读、不接受请求体、不列目录。白名单根默认只有宿主附件库与交付 outbox，
    // 可用 DSH_TASKWATCH_ROOTS 覆盖（`;` 分隔）。
    //
    // v1.8.1（经用户 2026-10-29 授权）：带 `sessionId` 时走**会话引用白名单** ——
    // 只放行该会话消息正文里出现过的绝对路径，单个文件 ≤ 50 MB。旧调用不带
    // sessionId，行为一个字都没变，仍只认上面那两个根。
    const fileRoots = rootsFrom(process.env.DSH_TASKWATCH_ROOTS, homedir())

    // 白名单按 sessionId 缓存：每次请求都重扫全部消息文本的话，长会话就是每张图
    // 都做一遍全量正则。缓存键里带「消息条数 + 最后一条消息时间」，只要会话长了一条
    // 或来了新消息就整体重建 —— 不做增量，增量最容易在切会话 / 子代理时错位。
    const sessionRefCache = new Map()
    const SESSION_REF_CACHE_MAX = 64
    function sessionRefWhitelist(sessionId) {
      const got = readSessionMessages(ctx.get('sessions'), sessionId, Infinity)
      if (!got.live) return { paths: new Set(), error: got.error || 'session-not-live' }
      let lastAt = 0
      for (const m of got.messages) if (m.at > lastAt) lastAt = m.at
      const signature = got.total + '|' + lastAt
      const hit = sessionRefCache.get(sessionId)
      if (hit !== undefined && hit.signature === signature) return { paths: hit.paths, error: null }
      const paths = buildSessionWhitelist(got.messages)
      if (sessionRefCache.size >= SESSION_REF_CACHE_MAX) {
        sessionRefCache.delete(sessionRefCache.keys().next().value)
      }
      sessionRefCache.set(sessionId, { signature, paths })
      return { paths, error: null }
    }
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/file',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const fail = (error, status, extra) => send(
          res,
          status,
          'application/json; charset=utf-8',
          JSON.stringify({ error, ...(extra || {}) }),
        )
        const wantInfo = url.searchParams.get('info') === '1'
        const id = (url.searchParams.get('id') || '').trim()
        const sessionId = (url.searchParams.get('sessionId') || '').trim()

        if (id) {
          const store = ctx.get('attachments')
          if (!store) { fail('host-without-attachments', 501); return }
          const label = (url.searchParams.get('name') || '').replace(/["\\\r\n]/g, '_')

          if (url.searchParams.get('kind') === 'file') {
            try {
              const chunks = []
              let total = 0
              for await (const chunk of store.readFileStream({ attachmentId: id })) {
                total += chunk.length
                if (total > MAX_BYTES) { fail('too-large', 413, { bytes: total }); return }
                chunks.push(Buffer.from(chunk))
              }
              const body = Buffer.concat(chunks)
              if (wantInfo) {
                send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
                  name: label || id, bytes: body.length, mime: 'application/octet-stream', kind: 'file',
                }))
                return
              }
              send(res, 200, 'application/octet-stream', body, {
                'cache-control': 'private, max-age=300',
                'content-disposition': dispositionFor('application/octet-stream', label || id),
              })
            } catch (e) {
              fail('attachment-read-failed', 404, { detail: why(e) })
            }
            return
          }

          try {
            const got = await store.readImage({ attachmentId: id })
            const ref = got.ref || {}
            if (wantInfo) {
              send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
                name: ref.name || id,
                bytes: got.data.length,
                mime: ref.mediaType || 'image/png',
                kind: 'image',
                width: ref.width,
                height: ref.height,
              }))
              return
            }
            send(res, 200, ref.mediaType || 'image/png', Buffer.from(got.data), {
              'cache-control': 'private, max-age=300',
              'content-disposition': dispositionFor(ref.mediaType || 'image/png', ref.name || id),
            })
          } catch (e) {
            fail('attachment-read-failed', 404, { detail: why(e) })
          }
          return
        }

        // 新分支：带 sessionId 的路径请求走「本会话引用过的绝对路径」。
        // 不带 sessionId 的旧调用完全不变（见下面 resolveTarget 那段）。
        if (sessionId) {
          const pathParam = url.searchParams.get('path') || ''
          const ref = sessionRefWhitelist(sessionId)
          const hit = resolveSessionTarget(pathParam, ref.paths, { home: homedir(), limit: MAX_SESSION_BYTES })
          if (!hit.ok) {
            if (hit.error === 'too-large') {
              // 413 带上原路径：页面直接显示「文件超过 50 MB」，并保留可点的原路径。
              fail('too-large', 413, {
                bytes: hit.bytes,
                path: String(pathParam).slice(0, 300),
                limit: MAX_SESSION_BYTES,
              })
              return
            }
            // 未命中 / 穿越 / 符号链接逃逸 / 目录 / 类型不允许：仍按旧语义回 403。
            fail(hit.error, 403, { reason: hit.reason, ext: hit.ext })
            return
          }
          if (wantInfo) {
            send(res, 200, 'application/json; charset=utf-8', JSON.stringify(infoOf(hit)))
            return
          }
          let body
          try {
            body = readFileSync(hit.abs)
          } catch (e) {
            fail('read-failed', 500, { detail: why(e) })
            return
          }
          // 放行才写审计：拒绝不写（避免噪声）。路径截断到 200 字符。
          writeAudit({
            at: new Date().toISOString(),
            session: sessionId,
            path: hit.abs.slice(0, SESSION_PATH_MAX),
            size: hit.bytes,
            via: 'session-ref',
          })
          send(res, 200, hit.mime, body, {
            'cache-control': 'private, max-age=300',
            'content-disposition': dispositionFor(hit.mime, hit.name),
          })
          return
        }

        const hit = resolveTarget(url.searchParams.get('path') || '', fileRoots, homedir())
        if (!hit.ok) {
          fail(hit.error, hit.error === 'too-large' ? 413 : 403, { bytes: hit.bytes, ext: hit.ext })
          return
        }
        if (wantInfo) {
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify(infoOf(hit)))
          return
        }
        let body
        try {
          body = readFileSync(hit.abs)
        } catch (e) {
          fail('read-failed', 500, { detail: why(e) })
          return
        }
        send(res, 200, hit.mime, body, {
          // 令牌保护的私有内容：让手机侧短暂缓存，别每次滚动都重下一遍。
          'cache-control': 'private, max-age=300',
          'content-disposition': dispositionFor(hit.mime, hit.name),
        })
      },
    }), 'in-hand: file route')

// ===== I. 状态与决策页面契约 =====
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/data',
      handler: async (req, res) => {
        // 只有手机页会带 view=phone；桌面侧边栏（lib/client.js）打的是同一个
        // /taskwatch/data 但不带这个参数，故意不算「手机在线」。
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          if (url.searchParams.get('view') === 'phone') markPhoneSeen()
        } catch { /* URL 不合法就只当作没心跳 */ }
        let entry
        try {
          entry = await snapshotCached()
        } catch (e) {
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ error: why(e) }))
          return
        }
        // 内容没变就回 304：手机上省下的是整份 JSON 的流量，只交换一个头。
        // 注意这里必须用 no-cache 而不是 no-store —— no-store 会让浏览器
        // 根本不保存响应，也就永远不会带 If-None-Match 回来。
        const inm = req.headers ? req.headers['if-none-match'] : undefined
        if (typeof inm === 'string' && inm === entry.etag) {
          send(res, 304, 'application/json; charset=utf-8', '', {
            etag: entry.etag,
            'cache-control': 'no-cache',
          })
          return
        }
        send(res, 200, 'application/json; charset=utf-8', entry.json, {
          etag: entry.etag,
          'cache-control': 'no-cache',
        })
      },
    }), 'in-hand: data route')

    // 当前可决定的审批清单。只读、只暴露内存里的活动 decision，不写任何状态。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/decisions',
      handler: (req, res) => {
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
          ok: true,
          approveFromPhone: approvalConfig.approveFromPhone,
          timeoutMs: approvalConfig.timeoutMs,
          decisions: approvalGate.list(),
        }))
      },
    }), 'in-hand: decisions route')

    // 手机页可见时挂一条 SSE；它同时是「手机在线」的最强信号。页面隐藏时
    // stopPolling() 会关掉它，于是审批立刻退回桌面。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/approvals/stream',
      handler: (req, res) => {
        try {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
            connection: 'keep-alive',
            'x-robots-tag': 'noindex, nofollow',
          })
          if (typeof res.flushHeaders === 'function') res.flushHeaders()
          res.write(': connected\n\n')
        } catch {
          try { res.end('') } catch { /* 已断开 */ }
          return
        }
        approvalStreams.add(res)
        markPhoneSeen()
        const heartbeat = setInterval(() => {
          try { res.write(': ping\n\n') } catch { /* 连接已断，close 事件会收尾 */ }
        }, 20 * 1000)
        if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref()
        const done = () => {
          clearInterval(heartbeat)
          approvalStreams.delete(res)
        }
        req.on('close', done)
        res.on('close', done)
        res.on('error', done)
      },
    }), 'in-hand: approvals stream route')

    // 手机端的唯一写入口：一次性放行或拒绝。只认 allow / reject，故意没有
    // always-allow —— 那等于把一次性放行升级成永久写权限。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/approve',
      handler: async (req, res) => {
        const fail = (status, code, error) => send(
          res,
          status,
          'application/json; charset=utf-8',
          JSON.stringify({ ok: false, code, error }),
        )
        if (req.method !== 'POST') {
          send(res, 405, 'application/json; charset=utf-8', JSON.stringify({
            ok: false, code: 'method-not-allowed', error: '只接受 POST',
          }), { allow: 'POST' })
          return
        }
        if (isCrossSite(req)) {
          fail(403, 'cross-site', '跨站请求被拒绝')
          return
        }
        const type = String((req.headers && req.headers['content-type']) || '').split(';', 1)[0].trim().toLowerCase()
        if (type !== 'application/json') {
          fail(400, 'bad-request', '需要 application/json 请求体')
          return
        }
        let body
        try {
          body = JSON.parse(await readApprovalBody(req))
        } catch (e) {
          fail(400, 'bad-request', '请求体不是合法 JSON：' + why(e))
          return
        }
        const id = asText(body && body.id)
        const decision = asText(body && body.decision)
        if (!id || (decision !== 'allow' && decision !== 'reject')) {
          fail(400, 'bad-request', '需要 {id, decision: "allow" | "reject"}')
          return
        }
        const result = approvalGate.decide(id, decision)
        send(res, result.status, 'application/json; charset=utf-8', JSON.stringify(result.body))
      },
    }), 'in-hand: approve route')

    // 手机端回答选项式提问（v1.8.3）。与 /taskwatch/approve 同一套写路由门禁：
    // POST + application/json + 同源。它只做一件事 —— 把一次已认领的
    // user-questions/request resolve 成 { answers }；不改会话内容、不执行命令。
    //
    // 校验尽量在**快**失败：field 直接指向 answers[i].selected 这种位置，
    // 页面能把提示落到具体哪一题，而不是笼统的"参数不对"。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/answer',
      handler: async (req, res) => {
        const fail = (status, code, error, extra) => send(
          res,
          status,
          'application/json; charset=utf-8',
          JSON.stringify({ ok: false, code, error, ...(extra || {}) }),
        )
        if (req.method !== 'POST') {
          send(res, 405, 'application/json; charset=utf-8', JSON.stringify({
            ok: false, code: 'method-not-allowed', error: '只接受 POST',
          }), { allow: 'POST' })
          return
        }
        if (isCrossSite(req)) {
          fail(403, 'cross-site', '跨站请求被拒绝')
          return
        }
        const type = String((req.headers && req.headers['content-type']) || '').split(';', 1)[0].trim().toLowerCase()
        if (type !== 'application/json') {
          fail(400, 'bad-request', '需要 application/json 请求体')
          return
        }
        let body
        try {
          // 回答体比审批大：多题 + 每条最多 2000 字自定义回答，64 KB 足够。
          body = JSON.parse(await readApprovalBody(req, 64 * 1024))
        } catch (e) {
          fail(400, 'bad-request', '请求体不是合法 JSON：' + why(e))
          return
        }
        const id = asText(body && body.id)
        if (!id) {
          fail(400, 'bad-request', '缺少 id', { field: 'id' })
          return
        }
        if (!Array.isArray(body && body.answers)) {
          fail(400, 'bad-request', '需要 {id, answers:[{id, selected}]}', { field: 'answers' })
          return
        }
        const result = questionGate.answer(id, body.answers)
        send(res, result.status, 'application/json; charset=utf-8', JSON.stringify(result.body))
      },
    }), 'in-hand: answer route')

    // 某个会话的最近对话（只读）。
    //
    // 为什么可能读不到：ctx.sessions 是内存存储，get(id) 只对活着的会话有效。
    // 已落盘但未加载进内存的会话这里拿不到 —— 这种情况显式报错，绝不假装"没有消息"，
    // 否则会让人以为那个会话真的没说话，而它只是没被加载。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/session',
      handler: async (req, res) => {
        const out = { id: '', live: false, total: 0, messages: [], error: null }
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const id = url.searchParams.get('id') || ''
          const raw = Number(url.searchParams.get('limit'))
          const limit = Math.min(60, Math.max(1, isFinite(raw) && raw > 0 ? Math.floor(raw) : 20))
          out.id = id
          const got = readSessionMessages(ctx.get('sessions'), id, limit)
          out.live = got.live
          out.error = got.error
          out.total = got.total
          // 输出格式仍按老契约截断到 4000 字；白名单那边用的是完整文本。
          out.messages = got.messages.map((m) => Object.assign({}, m, {
            text: m.text.length > 4000 ? m.text.slice(0, 4000) + '\n…（已截断）' : m.text,
          }))
        } catch (e) {
          out.error = why(e)
        }
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(out))
      },
    }), 'in-hand: session route')

// ===== J. 对话（远程控制） =====
    // ---- 对话（远程控制）----------------------------------------------------
    //
    // 为什么存在：只读状态板能告诉你「卡住了」，但你人不在电脑前就做不了任何事。
    // 这一组路由把 DSH **自己的**会话运行时接到手机上 —— 发消息、流式收回复、停止、
    // 列/建会话、切模型 —— 全部转调 sessionController。插件不碰 LLM、不碰流式协议，
    // 所以上游怎么演进，这里跟着就有。
    //
    // 安全边界（重要）：这些路由自己不鉴权，只监听回环。对外**唯一**入口是中继，
    // 由它承担 TLS + basic auth + 应用层令牌三层。所以：
    //   新增一条路由 = 新增一份对外能力。想收回哪个能力，把对应注册删掉即可。
    // 它们是**写**入口：prompt 等于在宿主上驱动 agent（默认 danger-full-access），
    // 与只读路由不是一个量级，改动前请先想清楚。
    // sessionController 在**启动阶段之后**才发布，apply 期间 ctx.get 拿到的是
    // undefined（和当初 webServer 那个静默 404 是同一类陷阱，已实测踩过一次）。
    // 所以这里**不缓存服务实例**：每次请求再取一次。代价是一次 map 查找，换来的是
    // "路由永远注册得上" —— 缺服务时得到的是明确的错误 JSON，而不是一个费解的 404。
    let chatWarned = false
    const chatOf = () => {
      const svc = ctx.get('sessionController')
      if (svc === undefined) {
        if (!chatWarned) {
          chatWarned = true
          console.error('dsh-in-hand: 没有 sessionController 服务，对话接口会返回错误（只读页面不受影响）')
        }
        throw new Error('这个部署没有 sessionController 服务，对话功能不可用')
      }
      return svc
    }
    {
      const json = (res, status, obj) =>
        send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj))

      // 读请求体，带硬上限：一个超大 body 不该把宿主内存吃掉。
      const readRaw = (req, limit) => new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (c) => {
          size += c.length
          if (size > limit) {
            reject(new Error('请求体过大'))
            try { req.destroy() } catch { /* 已断开 */ }
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })

      const readBytes = async (req, limit, signal, measure) => {
        const chunks = []
        for await (const chunk of limitedChunks(req, limit, signal, measure)) chunks.push(chunk)
        return Buffer.concat(chunks)
      }

      const limitedChunks = async function* (req, limit, signal, measure) {
        signal.throwIfAborted()
        for await (const chunk of req) {
          signal.throwIfAborted()
          const part = Buffer.from(chunk)
          measure.bytes += part.length
          if (measure.bytes > limit) throw new Error('附件不能超过 32 MB')
          yield part
        }
        signal.throwIfAborted()
        if (req.complete === false) throw new Error('上传已中断')
      }

      const readJson = async (req) => {
        const raw = await readRaw(req, 32 * 1024)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      }

      const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
      const pruneUploads = () => {
        const cutoff = Date.now() - UPLOAD_TTL_MS
        for (const [key, value] of pendingUploads) {
          if (!value.sending && value.createdAt <= cutoff) pendingUploads.delete(key)
        }
      }
      const checkUploadRoom = (sessionId) => {
        pruneUploads()
        let count = 0
        for (const value of pendingUploads.values()) if (value.sessionId === sessionId) count++
        if (pendingUploads.size >= MAX_PENDING_UPLOADS || count >= MAX_SESSION_UPLOADS) {
          throw new Error('待发送附件过多，请先发送已有附件或稍后再试')
        }
      }
      const rememberUpload = (key, value) => {
        checkUploadRoom(value.sessionId)
        pendingUploads.set(key, value)
      }
      const requireUploadAgent = async (sessionId) => {
        const service = chatOf()
        if (typeof service.resolveAgent !== 'function') throw new Error('宿主缺少附件会话校验服务')
        const found = await service.resolveAgent(sessionId)
        if (found && found.agent) return found.agent
        // Older session-controller builds return Agent directly; current public
        // API returns { agent } or { error }.
        if (found && found.error) throw found.error
        if (found && found.session) return found
        throw new Error('会话不存在')
      }
      const requestLifetime = (req, res) => {
        const controller = new AbortController()
        const abort = () => controller.abort(new Error('请求已中断'))
        const closed = () => { if (!res.writableEnded) abort() }
        req.on('aborted', abort)
        res.on('close', closed)
        return {
          signal: controller.signal,
          dispose() { req.off('aborted', abort); res.off('close', closed) },
        }
      }
      const requirePost = (req, res, type) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: '只接受 POST' })
          return false
        }
        if (String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== type) {
          json(res, 415, { error: '请求必须使用 ' + type })
          return false
        }
        return true
      }

      // 新路由的错误统一带机器可读的 code，并给出可分辨的状态码：
      //   400 参数不合法 / 404 会话不存在 / 409 队列不可用或已变化 /
      //   501 这个宿主缺服务 / 502 宿主拒绝或抛错。
      const failJson = (res, status, code, message, extra) =>
        json(res, status, { error: message, code, ...(extra || {}) })

      // ---- 消息队列 ---------------------------------------------------------
      //
      // 队列就是宿主 Agent.inbox 里还没被领取的输入，DSH 自己分成两份：
      //   nextTurn：等下一轮执行的排队消息（手机上显示为「队列」，顺序可调）；
      //   nextStep：等本回合下一个 step 边界插入的 steering 消息（已经是插队，
      //             不再参与排序）。
      // 读与重排都直接走 dsh-agent 文档化的 Agent.inbox 接口；投递仍走
      // sessionController.prompt({mode})，和 /taskwatch/chat/send 完全同一条路。
      //
      // 为什么重排不用 sessionController.updateQueue：它的 action 只有
      // edit / remove / steer 三种，**没有换位置**。Inbox 的 splice 是宿主公开的
      // 结构化接口（dsh-agent README「持久 inbox」一节），重排就是把同一批 Message
      // 按新顺序原地重新 splice 一次 —— 不伪造消息、不改内容、不额外唤醒。
      const agentsOf = () => {
        const svc = ctx.get('agents')
        return svc !== undefined && typeof svc.get === 'function' ? svc : undefined
      }
      const liveAgentOf = (sessionId) => {
        const svc = agentsOf()
        if (svc === undefined) return undefined
        try { return svc.get(sessionId) } catch { return undefined }
      }
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      // interrupt 用例必须等 agent 真正离开 running 再 steer：cancel 的 abort 还没
      // 收敛时，ReactLoopAgent.send() 的 wakingAfterAbort 会把 steer 改投到
      // next-turn **末尾**，插队就悄悄失效了。宁可 409 也不假装成功。
      const waitIdle = async (agent, timeoutMs) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (agent.status !== 'running') return true
          await sleep(50)
        }
        return agent.status !== 'running'
      }
      // 区分「会话不存在」（404）和「会话存在但当前没有 live agent，队列不可读」
      // （409）。返回 false 表示确证不存在，null 表示没法确认（按不可用处理）。
      const sessionExists = async (sessionId) => {
        const store = ctx.get('sessions')
        if (store !== undefined && typeof store.get === 'function') {
          try { if (store.get(sessionId) !== undefined) return true } catch { /* 继续找 */ }
        }
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined && typeof persistence.stat === 'function') {
          try { if (await persistence.stat(sessionId)) return true } catch { /* 继续找 */ }
        }
        try {
          const value = await chatOf().list({}, ctl().signal)
          return !!(value && Array.isArray(value.items)
            && value.items.some((s) => String(s.sessionId) === sessionId))
        } catch {
          return null
        }
      }
      const queueText = (message) => {
        const text = blocksText(message && message.content)
        return text.length > 2000 ? text.slice(0, 2000) + '…（已截断）' : text
      }
      const queueItemOf = (message, index) => {
        const content = message && Array.isArray(message.content) ? message.content : []
        return {
          id: String(message && message.id ? message.id : ''),
          index,
          text: queueText(message),
          images: content.filter((b) => b && b.type === 'image').length,
          files: content.filter((b) => b && b.type === 'file').length,
          source: asText(message && message.source ? message.source.kind : ''),
        }
      }
      const MAX_QUEUE_ITEMS = 200
      const queueViewOf = (agent) => {
        const turn = Array.isArray(agent.inbox.nextTurn) ? agent.inbox.nextTurn : []
        const step = Array.isArray(agent.inbox.nextStep) ? agent.inbox.nextStep : []
        return {
          running: agent.status === 'running',
          items: turn.slice(0, MAX_QUEUE_ITEMS).map(queueItemOf),
          steering: step.slice(0, MAX_QUEUE_ITEMS).map(queueItemOf),
          counts: { queued: turn.length, steering: step.length },
          truncated: turn.length > MAX_QUEUE_ITEMS || step.length > MAX_QUEUE_ITEMS,
        }
      }

      // 原始二进制上传：文件由 fileUploads 按 Session 暂存，图片由 attachments
      // 先做图像准入再用一次性 token 交给后续 prompt。请求体硬上限沿用交付文件
      // 的 32 MiB 边界，名称只作为显示名传给宿主，绝不解释为路径。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/upload',
        handler: async (req, res) => {
          if (!requirePost(req, res, 'application/octet-stream')) return
          if (Number(req.headers['content-length']) > MAX_BYTES) {
            json(res, 413, { error: '附件不能超过 32 MB' })
            return
          }
          const lifetime = requestLifetime(req, res)
          let active = false
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const sessionId = asText(url.searchParams.get('sessionId')).trim()
            const kind = asText(url.searchParams.get('kind')).trim().toLowerCase()
            const name = asText(url.searchParams.get('name')).trim().slice(0, 200)
            const mime = asText(url.searchParams.get('mime')).trim().toLowerCase()
            if (!sessionId) throw new Error('缺少 sessionId')
            if (kind !== 'image' && kind !== 'file') throw new Error('上传类型无效')
            if (activeUploads >= 8) throw new Error('正在上传的附件过多，请稍后重试')
            activeUploads++; active = true
            checkUploadRoom(sessionId)
            await requireUploadAgent(sessionId)
            lifetime.signal.throwIfAborted()
            const measure = { bytes: 0 }
            if (kind === 'image') {
              if (!IMAGE_TYPES.has(mime)) throw new Error('只支持 PNG、JPEG、WEBP、GIF 图片')
              const store = ctx.get('attachments')
              if (!store || typeof store.saveImage !== 'function') throw new Error('宿主没有图片附件服务')
              const ref = await store.saveImage({ data: await readBytes(req, MAX_BYTES, lifetime.signal, measure), mediaType: mime, ...(name ? { name } : {}) })
              lifetime.signal.throwIfAborted()
              if (!ref || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_BYTES) throw new Error('图片处理后超过 32 MB 或附件信息无效')
              const token = randomUUID()
              rememberUpload('image:' + token, { sessionId, kind, ref, bytes: Math.max(measure.bytes, ref.bytes), createdAt: Date.now() })
              json(res, 200, { ok: true, upload: {
                kind: 'image', token, name: ref.name || name || '图片', bytes: ref.bytes,
                mime: ref.mediaType, width: ref.width, height: ref.height,
              } })
              return
            }
            const uploads = ctx.get('fileUploads')
            if (!uploads || typeof uploads.uploadStream !== 'function') throw new Error('宿主没有文件上传服务')
            const value = await uploads.uploadStream({
              sessionId,
              data: limitedChunks(req, MAX_BYTES, lifetime.signal, measure),
              signal: lifetime.signal,
              ...(name ? { name } : {}),
            })
            lifetime.signal.throwIfAborted()
            if (!value || !asText(value.receiptId) || !value.file || value.file.bytes !== measure.bytes) throw new Error('宿主返回了无效的文件上传信息')
            rememberUpload('file:' + value.receiptId, { sessionId, kind, ref: value.file, bytes: measure.bytes, createdAt: Date.now() })
            json(res, 200, { ok: true, upload: {
              kind: 'file', receiptId: String(value.receiptId),
              name: value.file && value.file.name ? value.file.name : name || '文件',
              bytes: value.file && value.file.bytes ? value.file.bytes : 0,
            } })
          } catch (e) {
            if (!res.destroyed && !res.writableEnded) json(res, 200, { error: why(e) })
          } finally {
            if (active) activeUploads--
            lifetime.dispose()
          }
        },
      }), 'in-hand: chat upload route')

      const ctl = () => new AbortController()

      // 会话列表。标题只对**活着的**会话可得（sessionTitle 需要一个 Session 对象），
      // 冷会话退化成 cwd 目录名或短 id —— 不假装有标题，也不为此去逐个加载会话。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/sessions',
        handler: async (req, res) => {
          try {
            const signal = ctl().signal
            const value = await chatOf().list({}, signal)
            const store = ctx.get('sessions')
            const titles = ctx.get('sessionTitle')
            const rows = []
            for (const s of (value && value.items) || []) {
              const id = String(s.sessionId)
              // 子代理会话不出现在手机上：它们是宿主内部的干活会话，不需要人进去说话，
              // 而且没有父地址连日志都读不了（分页会报 "require their durable parent
              // address"）。列表里混进来只会让"该点哪个"变得更难。
              const origin = asText(s.origin)
              if (origin === 'subagent') continue
              const live = store !== undefined ? store.get(id) : undefined
              let title = ''
              if (live !== undefined && titles !== undefined) {
                const snap = titles.get(live)
                if (snap && snap.title) title = String(snap.title)
              }
              const cwd = asText(s.cwd)
              rows.push({
                id,
                title,
                fallback: title ? '' : (cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : id.slice(0, 8)),
                running: !!s.running,
                blank: !!s.blank,
                updatedAt: asNum(s.updatedAt),
                cwd,
                origin,
                depth: asNum(s.delegationDepth),
              })
            }
            json(res, 200, { sessions: rows })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat sessions route')

      // ── 手机能选的工作区 ──────────────────────────────────────────────────
      //
      // 这是"把宿主的哪块磁盘交给公网客户端"这件事的一部分，所以设计上只有一条：
      // **清单由服务端给，/chat/create 只采纳清单里逐字命中的那一条。**
      // 客户端可以发任意字符串，但发不进清单里的目录 —— 原来"刻意不接受客户端传 cwd"
      // 的取舍没有被放弃，只是从"完全不能选"变成"只能在服务端列出的里面选"。
      //
      // 三个来源：① 现有会话的 cwd（你最近在哪儿干活，天然是你认过的目录）
      //          ② 环境变量 DSH_TASKWATCH_WORKSPACES（`;` 分隔，覆盖固定候选）
      //          ③ 固定候选默认 D:\Projects —— 本机约定，装到别处请用环境变量改。
      // 不存在的目录不进清单（statSync 判过），iOS 上少一个点进去报错的入口。
      const wsEnv = asText(process.env.DSH_TASKWATCH_WORKSPACES).trim() || 'D:\\Projects'
      const workspaceList = async () => {
        const seen = new Set()
        const rows = []
        const add = (p, why) => {
          const raw = asText(p).trim().replace(/[\\/]+$/, '')
          if (!raw) return
          const key = raw.toLowerCase()
          if (seen.has(key)) return
          seen.add(key)
          try {
            if (!statSync(raw).isDirectory()) return
          } catch {
            return
          }
          rows.push({ path: raw, name: raw.split(/[\\/]/).pop() || raw, why })
        }
        try {
          const value = await chatOf().list({}, ctl().signal)
          for (const s of (value && value.items) || []) {
            if (asText(s.origin) === 'subagent') continue
            add(s.cwd, 'recent')
          }
        } catch {
          // 会话列不出来就只给固定候选 —— 不为一个下拉框把接口整个搞失败。
        }
        for (const p of wsEnv.split(';')) add(p, 'pinned')
        return rows
      }

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/workspaces',
        handler: async (req, res) => {
          try {
            json(res, 200, { workspaces: await workspaceList() })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: workspaces route')

      // 新建会话。可以带 `workspace`（绝对路径），但必须命中上面那份清单。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/create',
        handler: async (req, res) => {
          try {
            const body = await readJson(req)
            const request = {}
            if (asText(body.agentPreset)) request.agentPreset = asText(body.agentPreset)
            let used = ''
            const want = asText(body.workspace).trim().replace(/[\\/]+$/, '')
            if (want) {
              const hit = (await workspaceList()).find((w) => w.path.toLowerCase() === want.toLowerCase())
              if (!hit) throw new Error('这个工作区不在服务端的候选清单里')
              request.cwd = hit.path
              used = hit.path
            }
            const value = await chatOf().create(request)
            json(res, 200, { ok: true, sessionId: String(value.sessionId), agentPreset: asText(value.agentPreset), workspace: used })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat create route')

      // 发消息。requestId 由宿主生成：客户端不该能决定请求身份。
      //
      // now:true 的语义（宿主原生能力，不模拟）：
      //   - 不打断：走 mode:'steer'。消息不进 nextTurn 队列，而是进 nextStep
      //     （steering lane），在本回合**下一个 step 边界**被领取 —— 排在本轮所有
      //     nextTurn 排队消息之前；若已有更早的 steering 消息，它们仍按先来后到
      //     排在前面（同一 lane 不改序）。会话空闲时 steer 会直接唤醒 agent，
      //     立刻起一轮。正在执行的工具调用或模型请求不会被中止。
      //   - 要硬打断：再带 interrupt:true。先 cancel({keepInbox:true})（队列保留），
      //     等 agent 真正 idle（最多 2 秒）再 steer；新消息进入新回合的 steering
      //     lane，先于保留的 nextTurn 队列。cancel 前就存在的 steering 消息仍会
      //     按原顺序先跑。没停下来就 409，消息不发出、队列不动。
      //   兼容旧的 mode:'steer' 写法：它等价于 now:true 但不会 cancel。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/send',
        handler: async (req, res) => {
          if (!requirePost(req, res, 'application/json')) return
          const lifetime = requestLifetime(req, res)
          const locked = []
          let nowRequested = false
          try {
            const body = await readJson(req)
            const sessionId = asText(body.sessionId)
            const text = asText(body.text)
            const wantNow = body.now === true
            const wantInterrupt = wantNow && body.interrupt === true
            if (!sessionId) throw new Error('缺少 sessionId')
            if (body.attachments !== undefined && !Array.isArray(body.attachments)) throw new Error('附件格式无效')
            const uploads = body.attachments || []
            if (uploads.length > 4) throw new Error('一次最多添加 4 个附件')
            if (!text.trim() && !uploads.length) throw new Error('消息不能为空')
            pruneUploads()
            let totalBytes = 0
            const seen = new Set()
            // 先原子校验/锁定整批元数据，再做异步读盘，失败时解锁而不消费。
            for (const item of uploads) {
              if (!item || typeof item !== 'object') throw new Error('附件格式无效')
              const kind = asText(item.kind)
              if (kind !== 'image' && kind !== 'file') throw new Error('附件类型无效')
              const key = kind + ':' + asText(kind === 'image' ? item.token : item.receiptId)
              const record = pendingUploads.get(key)
              if (!record || record.sessionId !== sessionId || record.kind !== kind) throw new Error('附件已失效或不属于当前会话，请重新上传')
              if (seen.has(key)) throw new Error('请勿重复添加同一个附件')
              if (record.sending) throw new Error('附件正在发送，请勿重复提交')
              seen.add(key)
              totalBytes += record.bytes
              if (totalBytes > MAX_BYTES) throw new Error('每条消息的附件总大小不能超过 32 MB')
              record.sending = true
              locked.push({ key, record, item })
            }
            const content = []
            if (text.trim()) content.push({ type: 'text', text })
            const agent = uploads.length ? await requireUploadAgent(sessionId) : null
            lifetime.signal.throwIfAborted()
            for (const { record, item } of locked) {
              if (record.kind === 'file') {
                const receiptId = asText(item.receiptId)
                const service = ctx.get('fileUploads')
                if (!service || typeof service.resolve !== 'function') throw new Error('宿主没有文件上传服务')
                const ref = service.resolve(agent, receiptId)
                if (!ref || ref.attachmentId !== record.ref.attachmentId || ref.bytes !== record.bytes) throw new Error('文件上传已失效，请重新上传')
                content.push({ type: 'file', receiptId })
                continue
              }
              if (record.kind === 'image') {
                const store = ctx.get('attachments')
                if (!store || typeof store.readImage !== 'function') throw new Error('宿主没有图片附件服务')
                const stored = await store.readImage(record.ref, lifetime.signal)
                lifetime.signal.throwIfAborted()
                content.push({
                  type: 'image', mediaType: stored.ref.mediaType,
                  data: Buffer.from(stored.data).toString('base64'),
                  ...(stored.ref.name ? { name: stored.ref.name } : {}),
                })
                continue
              }
            }
            // interrupt 只对正在跑的回合适用；空闲会话没有可打断的工作，
            // 直接 steer 就会立刻起一轮，不必也无从 cancel。
            if (wantInterrupt) {
              const active = liveAgentOf(sessionId)
              if (active !== undefined && active.status === 'running') {
                const service = chatOf()
                if (typeof service.cancel !== 'function') {
                  failJson(res, 501, 'host-unsupported', '宿主不支持取消当前回合，无法立即发送')
                  return
                }
                try {
                  await service.cancel({ sessionId })
                } catch (e) {
                  failJson(res, 502, 'host-rejected', '打断当前回合失败：' + why(e))
                  return
                }
                if (!(await waitIdle(active, 2000))) {
                  failJson(res, 409, 'interrupt-timeout', '当前回合没能在 2 秒内停下，消息未发送')
                  return
                }
              }
            }
            nowRequested = wantNow
            const request = {
              requestId: randomUUID(),
              sessionId,
              mode: (wantNow || body.mode === 'steer') ? 'steer' : 'queue',
              content,
            }
            if (asText(body.timeZone)) request.clientTimeZone = asText(body.timeZone)
            const value = await chatOf().prompt(request, lifetime.signal)
            if (!value || value.accepted !== true) throw new Error('宿主未接收消息，请重试')
            for (const { key, record } of locked) if (pendingUploads.get(key) === record) pendingUploads.delete(key)
            if (!res.destroyed && !res.writableEnded) json(res, 200, { ok: true, accepted: true })
          } catch (e) {
            if (!res.destroyed && !res.writableEnded) {
              // 老客户端只认 200 + {error}，保持原契约；带 now 的新语义失败用 502，
              // 让调用方能和「参数不对」（仍是 200 + 文本）分开。
              if (nowRequested) failJson(res, 502, 'host-rejected', '立即发送失败：' + why(e))
              else json(res, 200, { error: why(e) })
            }
          } finally {
            for (const { record } of locked) record.sending = false
            lifetime.dispose()
          }
        },
      }), 'in-hand: chat send route')

      // 停止当前轮。只中止这一轮，入队里还没跑的消息保留（服务端语义如此）。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/cancel',
        handler: async (req, res) => {
          try {
            const body = await readJson(req)
            const sessionId = asText(body.sessionId)
            if (!sessionId) throw new Error('缺少 sessionId')
            const value = await chatOf().cancel({ sessionId })
            json(res, 200, { ok: true, accepted: !!(value && value.accepted) })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat cancel route')

      // 查询一个会话的消息队列。只回纯标量（id / 文本 / 附件计数 / 来源），
      // 绝不把 live 的 Message 对象或图片字节带出去。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/queue',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.setHeader('allow', 'GET')
            failJson(res, 405, 'method-not-allowed', '只接受 GET')
            return
          }
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const sessionId = asText(url.searchParams.get('sessionId')).trim()
            if (!sessionId) { failJson(res, 400, 'bad-request', '缺少 sessionId'); return }
            if (agentsOf() === undefined) {
              failJson(res, 501, 'host-unsupported', '宿主没有 agents 服务，消息队列不可用')
              return
            }
            const agent = liveAgentOf(sessionId)
            if (agent === undefined) {
              const exists = await sessionExists(sessionId)
              if (exists === false) { failJson(res, 404, 'session-not-found', '会话不存在'); return }
              failJson(res, 409, 'queue-unavailable', '会话当前没有活动的 agent，消息队列不可用')
              return
            }
            json(res, 200, { ok: true, sessionId, ...queueViewOf(agent) })
          } catch (e) {
            failJson(res, 502, 'host-rejected', '读取消息队列失败：' + why(e))
          }
        },
      }), 'in-hand: chat queue route')

      // 重排 nextTurn（下一轮队列）。ids 必须是当前队列的**完整** id 列表：
      // 少了、多了、重复或包含 steering 消息都会 409 并要求客户端刷新。
      // 这是有意的 —— 只按客户端看到的快照整体替换，避免「把已经被领走的消息
      // 又插回去」这类不可见的数据错乱。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/queue/reorder',
        handler: async (req, res) => {
          if (!requirePost(req, res, 'application/json')) return
          try {
            const body = await readJson(req)
            const sessionId = asText(body.sessionId).trim()
            if (!sessionId) { failJson(res, 400, 'bad-request', '缺少 sessionId'); return }
            if (!Array.isArray(body.ids)) {
              failJson(res, 400, 'bad-request', 'ids 必须是消息 id 数组')
              return
            }
            const ids = body.ids.map((id) => asText(id))
            if (!ids.length || ids.some((id) => !id)) {
              failJson(res, 400, 'bad-request', 'ids 必须是非空的消息 id 数组')
              return
            }
            if (new Set(ids).size !== ids.length) {
              failJson(res, 400, 'bad-request', 'ids 里有重复的消息')
              return
            }
            if (agentsOf() === undefined) {
              failJson(res, 501, 'host-unsupported', '宿主没有 agents 服务，消息队列不可用')
              return
            }
            const agent = liveAgentOf(sessionId)
            if (agent === undefined) {
              const exists = await sessionExists(sessionId)
              if (exists === false) { failJson(res, 404, 'session-not-found', '会话不存在'); return }
              failJson(res, 409, 'queue-unavailable', '会话当前没有活动的 agent，消息队列不可用')
              return
            }
            // 从这里到 splice 全部同步：中间不能 await，否则读到的队列和写回的队列
            // 可能不是同一份（消息被领取后，旧对象会被重新插回去）。
            let current
            try {
              current = Array.from(agent.inbox.nextTurn)
            } catch (e) {
              failJson(res, 409, 'queue-unavailable', '这个会话的队列状态读不到：' + why(e))
              return
            }
            const currentIds = current.map((m) => String(m && m.id))
            // 只重排普通用户提示词。目标轮次 / 子代理续跑 / 提问回复这类消息在
            // 宿主里有各自的 discarded 副作用（重排会产生一次 discard + insert），
            // 不去碰它们；手机上这些行的 source 会显示出来，由客户端禁用排序。
            const foreign = current.find((m) => !(m && m.source && m.source.kind === 'user'))
            if (foreign) {
              failJson(res, 409, 'queue-unavailable', '队列里有非用户消息（目标轮次/子代理/提问回复），暂不支持重排')
              return
            }
            const sameSet = currentIds.length === ids.length
              && ids.every((id) => currentIds.indexOf(id) >= 0)
            if (!sameSet) {
              failJson(res, 409, 'queue-changed', '队列已经变化（有消息被领取或新增），请刷新后重试', { current: currentIds })
              return
            }
            const changed = ids.some((id, i) => id !== currentIds[i])
            if (changed) {
              const byId = new Map(current.map((m) => [String(m.id), m]))
              const ordered = ids.map((id) => byId.get(id))
              try {
                agent.inbox.splice('next-turn', 0, current.length, ordered)
              } catch (e) {
                failJson(res, 502, 'host-rejected', '宿主拒绝重排：' + why(e))
                return
              }
            }
            json(res, 200, {
              ok: true, sessionId, changed, ids: ids.slice(), ...queueViewOf(agent),
            })
          } catch (e) {
            failJson(res, 502, 'host-rejected', '重排失败：' + why(e))
          }
        },
      }), 'in-hand: chat queue reorder route')

      // 会话日志的流式跟随（SSE）。
      //
      // follow() 返回的本来就是**为传输设计的 wire 帧**（SessionWireEvent.data 是
      // JsonValue），所以这里可以安全地逐帧 JSON.stringify —— 不需要、也不应该去
      // 触碰活对象。帧分三类：snapshot（开场快照）/ event（消息、工具调用）/ 
      // assistant-stream（逐字增量）。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/stream',
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const sessionId = url.searchParams.get('sessionId') || ''
          if (!sessionId) { json(res, 400, { error: '缺少 sessionId' }); return }
          // 手机页可见时会保持这条会话 SSE；它也是「手机在线」的旁证。
          markPhoneSeen()
          const raw = Number(url.searchParams.get('maxMessages'))
          const maxMessages = Math.min(200, Math.max(10, isFinite(raw) && raw > 0 ? Math.floor(raw) : 60))

          const c = ctl()
          let closed = false
          res.on('close', () => { closed = true; c.abort() })

          try {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              // nginx 默认会缓冲响应，缓冲了流式就废了；这个头让它别缓冲。
              'x-accel-buffering': 'no',
            })
            res.write(': taskwatch stream\n\n')
            const frames = await chatOf().follow({
              address: { kind: 'session', sessionId },
              maxMessages,
              assistantStream: true,
            }, c.signal)
            for await (const frame of frames) {
              if (closed) break
              res.write('data: ' + JSON.stringify(frame) + '\n\n')
            }
          } catch (e) {
            if (!closed) {
              try {
                res.write('data: ' + JSON.stringify({ type: 'taskwatch-error', message: why(e) }) + '\n\n')
              } catch { /* 已断开 */ }
            }
          } finally {
            try { res.end() } catch { /* 已断开 */ }
          }
        },
      }), 'in-hand: chat stream route')

      // 会话用量：把「轮 / 步 / token/s / 缓存命中 / token 消耗 / 上下文占用」一次交给手机。
      // 优先读取 sessionController.projections() 的官方持久投影：它不需要激活会话，
      // 冷会话也能显示完整数字。旧宿主没有投影时，再退回 live 事件和 tokenMeter，
      // 但不会把估算值冒充成精确的 token 消耗。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/usage',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const sessionId = url.searchParams.get('sessionId') || ''
            if (!sessionId) throw new Error('缺少 sessionId')
            const chat = chatOf()
            const store = ctx.get('sessions')
            const live = store !== undefined ? store.get(sessionId) : undefined
            let baseline = null
            if (typeof chat.projections === 'function') {
              try { baseline = await chat.projections({ sessionId }, ctl().signal) } catch { baseline = null }
            }
            if (live === undefined && !baseline) { json(res, 200, { live: false }); return }
            const out = { live: true, turns: 0, steps: 0, toolCalls: 0 }
            const values = baseline && baseline.values && typeof baseline.values === 'object' ? baseline.values : {}
            const sessionStats = values.sessionStats
            const tokenUsage = values.tokenUsage
            const contextPressure = values.contextPressure
            const contextBreakdown = values.contextBreakdown
            let hasSessionStats = false
            let hasTokenUsage = false

            if (sessionStats && typeof sessionStats === 'object') {
              hasSessionStats = true
              out.turns = asNum(sessionStats.turns)
              out.steps = asNum(sessionStats.steps)
              out.llmMs = asNum(sessionStats.llmMs)
              out.toolMs = asNum(sessionStats.toolMs)
              out.ttftMs = asNum(sessionStats.ttftMs)
              out.ttftSteps = asNum(sessionStats.ttftSteps)
              out.decodeMs = asNum(sessionStats.decodeMs)
              out.decodeTokens = asNum(sessionStats.decodeTokens)
              if (out.decodeMs > 0 && out.decodeTokens >= 0) {
                out.tokensPerSecond = out.decodeTokens * 1000 / out.decodeMs
              }
            }

            if (tokenUsage && typeof tokenUsage === 'object') {
              hasTokenUsage = true
              out.uncachedInputTokens = asNum(tokenUsage.uncachedInputTokens)
              out.outputTokens = asNum(tokenUsage.outputTokens)
              out.cacheReadTokens = asNum(tokenUsage.cacheReadTokens)
              out.cacheWriteTokens = asNum(tokenUsage.cacheWriteTokens)
            }

            if (contextPressure && typeof contextPressure === 'object') {
              const projected = typeof contextPressure.projectedTokens === 'number' && isFinite(contextPressure.projectedTokens)
                ? contextPressure.projectedTokens : null
              const pressure = typeof contextPressure.pressureTokens === 'number' && isFinite(contextPressure.pressureTokens)
                ? contextPressure.pressureTokens : null
              if (projected !== null || pressure !== null) {
                out.contextTokens = projected === null ? pressure : projected
              }
              out.contextWindow = asNum(contextPressure.contextWindow)
            }
            if (contextBreakdown && typeof contextBreakdown === 'object') {
              out.contextBreakdown = {
                systemTokens: asNum(contextBreakdown.systemTokens),
                toolsTokens: asNum(contextBreakdown.toolsTokens),
                messageTokens: asNum(contextBreakdown.messageTokens),
              }
            }

            // 这几个字段是前端详情与指标条共用的规范化口径。
            if (hasTokenUsage) {
              out.tokenConsumption = out.uncachedInputTokens + out.outputTokens +
                out.cacheReadTokens + out.cacheWriteTokens
              const promptTokens = out.uncachedInputTokens + out.cacheReadTokens + out.cacheWriteTokens
              if (promptTokens > 0) out.cacheHitPercent = 100 * out.cacheReadTokens / promptTokens
            }

            try {
              const events = typeof live.ownEvents === 'function' ? live.ownEvents() : []
              for (const e of events) {
                if (!e || !e.type) continue
                if (!hasSessionStats && e.type === 'turn/start') {
                  const n = asNum(e.data && e.data.turn)
                  if (n > out.turns) out.turns = n
                } else if (!hasSessionStats && e.type === 'step/start') out.steps += 1
                else if (e.type === 'tool/call') out.toolCalls += 1
              }
            } catch (e) { out.eventsError = why(e) }

            const meter = ctx.get('tokenMeter')
            if (meter !== undefined && typeof meter.measure === 'function') {
              try {
                const m = meter.measure(live)
                if (!hasTokenUsage) out.totalTokens = asNum(m.totalTokens)
                out.surfaceTokens = asNum(m.surfaceTokens)
                const base = m.baseline
                if (!hasTokenUsage && base && base.kind === 'usage' && base.usage) {
                  out.inputTokens = asNum(base.usage.inputTokens)
                  out.outputTokens = asNum(base.usage.outputTokens)
                  out.cacheReadTokens = asNum(base.usage.cacheReadTokens)
                  out.cacheWriteTokens = asNum(base.usage.cacheWriteTokens)
                  out.reasoningTokens = asNum(base.usage.reasoningTokens)
                  out.tokenConsumption = out.inputTokens + out.outputTokens + out.cacheReadTokens + out.cacheWriteTokens
                  const promptTokens = out.inputTokens + out.cacheReadTokens + out.cacheWriteTokens
                  if (promptTokens > 0) out.cacheHitPercent = 100 * out.cacheReadTokens / promptTokens
                }
              } catch (e) { out.meterError = why(e) }
            } else {
              out.noTokenMeter = true
            }

            if (typeof out.contextTokens !== 'number' && out.surfaceTokens) out.contextTokens = out.surfaceTokens
            if (!out.tokensPerSecond && out.decodeMs > 0 && out.outputTokens >= 0) {
              out.tokensPerSecond = out.outputTokens * 1000 / out.decodeMs
            }
            if (out.contextWindow > 0 && typeof out.contextTokens === 'number') {
              out.contextPercent = Math.min(100, 100 * out.contextTokens / out.contextWindow)
            }

            try {
              const rc = typeof live.requestContext === 'function' ? live.requestContext() : undefined
              if (rc) {
                out.provider = asText(rc.provider)
                out.model = asText(rc.model)
                if (!out.contextWindow) out.contextWindow = asNum(rc.contextWindow)
              }
            } catch (e) { /* 上下文窗口拿不到就不带，页面自然不显示百分比 */ }

            if (out.contextWindow > 0 && typeof out.contextTokens === 'number') {
              out.contextPercent = Math.min(100, 100 * out.contextTokens / out.contextWindow)
            }

            json(res, 200, out)
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat usage route')

      // 往更早翻历史。follow 的开场快照只给最近 maxMessages 条，
      // 再往前要按 beforeSeq 分页取。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/page',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const sessionId = url.searchParams.get('sessionId') || ''
            if (!sessionId) throw new Error('缺少 sessionId')
            const before = Number(url.searchParams.get('beforeSeq'))
            const through = Number(url.searchParams.get('throughSeq'))
            if (!isFinite(before) || before <= 0) throw new Error('缺少有效的 beforeSeq')
            const rawMax = Number(url.searchParams.get('maxMessages'))
            const request = {
              address: { kind: 'session', sessionId },
              throughSeq: isFinite(through) && through > 0 ? Math.floor(through) : Math.floor(before),
              beforeSeq: Math.floor(before),
              maxMessages: Math.min(200, Math.max(5, isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 40)),
            }
            const value = await chatOf().page(request, ctl().signal)
            json(res, 200, {
              records: value && value.records ? value.records : [],
              hasMore: !!(value && value.hasMore),
            })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat page route')

      // 冷会话的标题（批量）。
      //
      // 为什么需要它：SessionSummary 里**根本没有 title 字段**（只有 cwd），
      // 所以会话列表上 60 条全会显示成同一个目录名 —— 实测就是这个效果，
      // 列表完全没法用。真正的标题在事件日志的 session/title 帧里（靠近开头）。
      //
      // 分页语义是实测出来的（2026-09-22）：
      //   · throughSeq 不能超过该会话的 cursor，否则报 "through seq N is past cursor M"
      //     —— 而 M 正是需要的值，所以能一步重试；
      //   · beforeSeq 是**排他上界**，窗口是 [beforeSeq-maxMessages, beforeSeq)。
      // 于是先按 40 探一次（足够覆盖标题所在的开头），撞上 cursor 错误就用错误里
      // 给出的真实 cursor 重试。
      const findTitle = (value) => {
        for (const r of (value && value.records) || []) {
          const ev = r && r.event
          if (ev && ev.type === 'session/title' && ev.data && ev.data.title) return String(ev.data.title)
        }
        return ''
      }

      const pageTitle = async (sid, seq) => {
        const value = await chatOf().page({
          address: { kind: 'session', sessionId: sid },
          throughSeq: seq,
          beforeSeq: seq,
          maxMessages: 40,
        }, ctl().signal)
        return findTitle(value)
      }

      const probeTitle = async (sid) => {
        try {
          return await pageTitle(sid, 40)
        } catch (e) {
          const m = /past cursor (\d+)/.exec(why(e))
          if (!m) return ''
          try {
            return await pageTitle(sid, Number(m[1]))
          } catch {
            return ''
          }
        }
      }

      // 每个会话要 1~2 次持久化读（实测约 0.5s/次），8 个串行就是 7.5 秒 ——
      // 手机上打开列表等这么久不可接受。限并发 5，配合下面的缓存，
      // 只有第一次打开会花一两秒。
      const TITLE_TTL_MS = 10 * 60 * 1000
      const titleCache = new Map()

      const readTitle = async (sid) => {
        const hit = titleCache.get(sid)
        if (hit !== undefined && Date.now() - hit.at < TITLE_TTL_MS) return hit.title
        const title = await probeTitle(sid)
        // 空结果**不缓存**：会话刚建、标题还没生成时，缓存空值会让它十分钟都空着。
        if (title) titleCache.set(sid, { at: Date.now(), title })
        return title
      }

      const titlesFor = async (ids, limit) => {
        const out = {}
        let next = 0
        const worker = async () => {
          while (next < ids.length) {
            const id = ids[next++]
            const title = await readTitle(id)
            if (title) out[id] = title
          }
        }
        await Promise.all(new Array(Math.min(limit, ids.length)).fill(0).map(worker))
        return out
      }

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/titles',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const ids = (url.searchParams.get('ids') || '')
              .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20)
            json(res, 200, { titles: await titlesFor(ids, 5) })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat titles route')

      // 可选模型目录（含每个 provider 的分组与默认项）。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/models',
        handler: async (req, res) => {
          try {
            const value = await chatOf().modelCatalog()
            const groups = []
            for (const g of (value && value.groups) || []) {
              const models = []
              for (const m of (g.models || [])) {
                models.push({
                  id: asText(m.id),
                  name: asText(m.name) || asText(m.id),
                  reasoning: m.reasoning
                    ? {
                        defaultEffort: asText(m.reasoning.defaultEffort),
                        efforts: (m.reasoning.efforts || []).map((e) => ({ id: asText(e.id), name: asText(e.name) || asText(e.id) })),
                      }
                    : null,
                })
              }
              groups.push({ id: asText(g.id), name: asText(g.name) || asText(g.id), models })
            }
            const d = (value && value.default) || {}
            json(res, 200, {
              default: { provider: asText(d.provider), model: asText(d.model) },
              groups,
            })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat models route')

      // 切换某个会话使用的模型。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/model',
        handler: async (req, res) => {
          try {
            const body = await readJson(req)
            const sessionId = asText(body.sessionId)
            const provider = asText(body.provider)
            const model = asText(body.model)
            if (!sessionId) throw new Error('缺少 sessionId')
            if (!provider || !model) throw new Error('缺少 provider / model')
            const value = await chatOf().selectModel({ sessionId, provider, model })
            const sel = (value && value.selected) || {}
            json(res, 200, { ok: true, selected: { provider: asText(sel.provider), model: asText(sel.model) } })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat model route')
    }

// ===== K. 双入口（entries / ticket） =====
    // ---- 双入口（远端 / 局域网）--------------------------------------------
    //
    // 与 taskwatch-relay 的 /taskwatch/entries、/taskwatch/ticket 同一套语义：
    // 入口清单说明"现在有哪几条路"，ticket 给一张 60 秒、一次性、用后即焚的通行证。
    // 差别只有一个：宿主自己不做鉴权，所以兑换后的 Set-Cookie 只是与中继同形的
    // "换路已完成"标记，不承担授权（授权仍由中继那层负责）。
    //
    // 2026-10-21（v1.7.1）：这两条原先**只有中继实现**，宿主没有 —— 页面从宿主加载时
    // 点「去远端」拿到 405/404，拿不到 url 又每 12 秒重试一次，就是"点了就一直报错"。
    // 公网地址只从配置来：插件配置项 publicUrl，其次环境变量（与 DSH_TASKWATCH_ROOTS
    // 同一习惯）。没有配置就只报局域网入口 —— 代码里绝不写死任何域名。
    const rawPublicUrl = asText(settings.publicUrl) || asText(process.env.DSH_TASKWATCH_PUBLIC_URL)
    const publicUrl = normalizePublicUrl(rawPublicUrl)
    // 设备账本的 via 只认「请求从哪条入口进来」：tw-route cookie 优先，
    // 其次看 Host 是否就是配置的公网入口。这里只保存 origin，不写日志。
    devicePublicUrl = publicUrl
    // 局域网入口可以指到别处（通常是有令牌门的中继）。没配就沿用自动探测内网 IP。
    const rawLanUrl = asText(settings.lanUrl) || asText(process.env.DSH_TASKWATCH_LAN_URL)
    const lanUrl = normalizeLanUrl(rawLanUrl)
    // 配了却归一化成空，以前是**静默**回落 —— 这正是"lanUrl 配了不生效"最难查的地方。
    // 只写键名与预期形态，绝不回显值（URL 里可能带凭据）。
    if (rawPublicUrl && !publicUrl) {
      console.error('dsh-in-hand: publicUrl 已配置但无效，按未配置处理'
        + '（需要纯 origin，例如 https://dsh.example.com，不能带路径）')
    }
    if (rawLanUrl && !lanUrl) {
      console.error('dsh-in-hand: lanUrl 已配置但无效，按未配置处理'
        + '（需要 origin，例如 http://192.168.1.5:3099；只允许带 /taskwatch 后缀）')
    }
    // 票据 v2：密钥解析顺序在 lib/ticket.js 里与中继保持一致；文件权限也在那里收紧。
    // **按需初始化**（第一次签发/兑换时才解析）—— 只读监控、不换路的会话不该在启动时
    // 就去碰用户主目录，测试里也能避免无意写入真实 ~/.dsh。
    // 注意日志只写来源与路径，绝不打印密钥本身。
    let ticketGate = null
    function tickets() {
      if (ticketGate) return ticketGate
      const resolved = loadTicketSecret()
      if (resolved.source === 'generated') {
        console.log('dsh-in-hand: 已生成跨进程票据密钥 ' + resolved.file
          + '（权限：' + resolved.permission + '）')
      } else if (resolved.source === 'memory') {
        console.error('dsh-in-hand: 票据密钥无法写入 ' + resolved.file
          + '，只能在本进程内使用（跨进程互认不可用）')
      }
      ticketGate = createTicketGate({
        secret: resolved.secret,
        // 宿主自己只兑现"局域网直连"的票：公网中继签的 aud=remote 票在这里一律 401，
        // 反过来中继也只收 remote —— 这就是跨入口重放的修法。
        aud: TICKET_AUD_LAN,
        // 老格式随机票的向后兼容仍然走这个进程内 Map。
        store: createTicketStore(),
        // 只写原因，不写票面：重放尝试需要留痕，但不能把凭据抄进日志。
        log: (line) => console.warn(line),
      })
      return ticketGate
    }

    // ── 中继 v3 能力探测（v1.8.6，兼容升级顺序的关键）──────────────────────
    //
    // 用户装新插件时中继大概率还是旧代码，而旧中继会把 v3 当未知格式拒掉 —— 那等于
    // "一升级就断网"。所以插件**默认签 v2**，只有中继亲口声明支持 v3 才签 v3：
    //   GET <中继>/taskwatch/lan.json 的响应里 ticketVersions 含 3（免鉴权、无凭据）；
    //   探测失败 / 字段缺失 / 版本号不认识 / 超时 1.5 秒 → 回退 v2。
    // 正向结果缓存 10 分钟，负向只缓存 60 秒 —— 中继升级后一分钟内自动用上 v3。
    const V3_PROBE_OK_MS = 10 * 60 * 1000
    const V3_PROBE_NEG_MS = 60 * 1000
    const relayV3Cache = new Map()
    async function relayTicketVersion(origin) {
      const base = normalizePublicUrl(origin)
      // 没有可探测的 origin（配置缺失/非法）：按最保守的 v2 走。
      if (!base) return TICKET_V2_SUNSET_AT > Date.now() ? 2 : TICKET_VERSION
      const at = Date.now()
      const hit = relayV3Cache.get(base)
      if (hit && at - hit.at < (hit.v3 ? V3_PROBE_OK_MS : V3_PROBE_NEG_MS)) return hit.v3 ? 3 : 2
      let v3 = false
      try {
        const response = await fetch(base + '/taskwatch/lan.json', {
          signal: AbortSignal.timeout(1500),
          headers: { accept: 'application/json' },
          redirect: 'error',
        })
        if (response.ok) {
          const body = await response.json()
          const list = Array.isArray(body && body.ticketVersions) ? body.ticketVersions : []
          v3 = list.some((v) => Number(v) === TICKET_VERSION)
        }
      } catch { v3 = false }
      relayV3Cache.set(base, { at, v3 })
      if (!v3 && at >= TICKET_V2_SUNSET_AT) {
        // 过渡期结束后 v2 已经没人认了，回退 v2 等于永远兑换失败 —— 那时只能押 v3。
        return TICKET_VERSION
      }
      return v3 ? 3 : 2
    }

    /** 受众 = **谁兑现这张票**，不是入口叫什么。
     *
     *  宿主与中继跑在同一台机器上（甚至同一个 IP），唯一稳定的区分是端口：端口是我们
     *  自己的服务、主机又是本机地址之一 → 宿主自己兑现（lan）；否则按公网中继（remote）。
     *  只按 IP 判会把 `http://127.0.0.1:3099`（本机的中继）误判成 lan，那正好是跨入口
     *  重放要防的方向。 */
    function audienceForUrl(url, req) {
      let parsed
      try { parsed = new URL(url) } catch { return TICKET_AUD_REMOTE }
      const host = hostOnly(parsed.host)
      if (!host) return TICKET_AUD_REMOTE
      const here = requestPort(req) || '80'
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
      if (port !== here) return TICKET_AUD_REMOTE
      const own = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
      for (const a of lanAddresses()) own.add(a.ip)
      const reqHost = requestHost(req)
      if (reqHost) own.add(reqHost)
      return own.has(host) ? TICKET_AUD_LAN : TICKET_AUD_REMOTE
    }
    const routeJson = (res, status, obj) =>
      send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj))

    /** 入口清单。current 用布尔标在每条上（新契约）；同时保留中继的
     *  remote / lan / current 字段，好让同一份 page.html 在两种外壳下都能读。 */
    function entryList(req) {
      const host = requestHost(req)
      const port = requestPort(req)
      const remoteHost = publicUrl ? hostOnly(new URL(publicUrl).host) : ''
      const isRemote = Boolean(remoteHost) && host === remoteHost
      const entries = []
      let lanUrls = []
      if (publicUrl) {
        entries.push({
          kind: 'remote',
          label: '远端（公网）',
          url: publicUrl + '/taskwatch',
          current: isRemote,
        })
      }
      if (lanUrl) {
        // 配了 lanUrl 就不再探测内网 IP：那通常是中继的局域网入口，比自动探测更准，
        // 也更可能是"有鉴权"的那一条（插件自己的路由没有令牌门）。
        lanUrls = [lanUrl + '/taskwatch']
        entries.push({
          kind: 'lan',
          label: '局域网 · 中继',
          url: lanUrls[0],
          current: !isRemote,
        })
      } else {
        const lan = lanAddresses()
        lanUrls = lan.map((a) => 'http://' + a.ip + (port ? ':' + port : '') + '/taskwatch')
        const lanCurrent = lan.findIndex((a) => a.ip === host)
        lanUrls.forEach((url, i) => {
          // 本机回环访问时没有哪条局域网地址"等于"当前地址，但它们连的是同一个服务，
          // 所以把第一条标成当前 —— 只影响胶囊文案，不影响任何跳转。
          const current = !isRemote && (lanCurrent >= 0 ? i === lanCurrent : i === 0)
          entries.push({ kind: 'lan', label: '局域网 · ' + lan[i].ip, url, current })
        })
      }
      return { entries, remote: publicUrl, lan: lanUrls, current: isRemote ? 'remote' : 'lan' }
    }

    // ticket 的请求体上限比对话接口还小：这里只该有一个 {"to":"remote"}。
    function readTicketBody(req) {
      return new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > 1024) {
            reject(new Error('请求体过大'))
            try { req.destroy() } catch { /* 已断开 */ }
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            const parsed = raw ? JSON.parse(raw) : {}
            resolve(parsed && typeof parsed === 'object' ? parsed : {})
          } catch (e) { reject(e) }
        })
        req.on('error', reject)
      })
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/entries',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('allow', 'GET, HEAD')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 GET' })
          return
        }
        const view = entryList(req)
        routeJson(res, 200, {
          ok: true,
          entries: view.entries,
          // 中继那套字段（页面旧逻辑仍读它们；新逻辑读 entries）
          remote: view.remote,
          lan: view.lan,
          current: view.current,
        })
      },
    }), 'in-hand: entries route')

    // 换路票据：写路由，沿用中继写路由的门禁 —— POST + application/json + 同源。
    // 宿主不校验令牌（和中继的分工），但绝不能让任意网页用表单 POST 触发一次跳转。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/ticket',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 POST' })
          return
        }
        if (isCrossSite(req)) {
          routeJson(res, 403, { ok: false, code: 'cross-site', error: '禁止跨站触发换路' })
          return
        }
        const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
        if (type !== 'application/json') {
          routeJson(res, 415, { ok: false, code: 'unsupported-media-type', error: '请求必须使用 application/json' })
          return
        }
        let want = 'lan'
        try {
          const body = await readTicketBody(req)
          if (asText(body.to) === 'remote') want = 'remote'
        } catch {
          routeJson(res, 400, { ok: false, code: 'bad-request', error: '请求体不合法' })
          return
        }
        if (want === 'remote') {
          if (!publicUrl) {
            routeJson(res, 409, {
              ok: false,
              code: 'no-public-entry',
              error: '还没有配置公网入口（插件配置项 publicUrl），这里只能走局域网',
            })
            return
          }
          const target = publicUrl + '/taskwatch'
          const aud = audienceForUrl(target, req)
          // 兑现方是公网中继时先问它认不认 v3；兑现方是我们自己就直接 v3。
          const version = aud === TICKET_AUD_REMOTE ? await relayTicketVersion(publicUrl) : TICKET_VERSION
          const ticket = tickets().mint({ aud, version })
          routeJson(res, 200, {
            ok: true,
            to: 'remote',
            url: target + '?t=' + ticket,
            expiresInMs: TICKET_TTL_MS,
            ticketVersion: version,
          })
          return
        }
        if (lanUrl) {
          // 指到中继的局域网入口：受众按"谁会兑现"算（中继 → remote，宿主自己 → lan），
          // 票据版本同样跟随中继的能力声明 —— 配了 lanUrl 的用户升级后也不会断。
          const target = lanUrl + '/taskwatch'
          const aud = audienceForUrl(target, req)
          const version = aud === TICKET_AUD_REMOTE ? await relayTicketVersion(lanUrl) : TICKET_VERSION
          routeJson(res, 200, {
            ok: true,
            to: 'lan',
            address: hostOnly(new URL(lanUrl).host),
            url: target + '?t=' + tickets().mint({ aud, version }),
            expiresInMs: TICKET_TTL_MS,
            ticketVersion: version,
          })
          return
        }
        const lan = lanAddresses()
        if (!lan.length) {
          routeJson(res, 409, {
            ok: false,
            code: 'no-lan-entry',
            error: '没有局域网地址（网卡没连上 Wi-Fi？）',
          })
          return
        }
        // 和中继一样优先挑与请求方同网段的那条，否则第一条。
        const peer = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
        const net = (ip) => ip.split('.').slice(0, 3).join('.')
        const pick = lan.find((a) => net(a.ip) === net(peer)) || lan[0]
        const port = requestPort(req)
        const ticket = tickets().mint({ aud: TICKET_AUD_LAN, version: TICKET_VERSION })
        routeJson(res, 200, {
          ok: true,
          to: 'lan',
          address: pick.ip,
          iface: pick.iface,
          url: 'http://' + pick.ip + (port ? ':' + port : '') + '/taskwatch?t=' + ticket,
          expiresInMs: TICKET_TTL_MS,
        })
      },
    }), 'in-hand: ticket route')

// ===== L. 设备列表与撤销 =====
    // ── 设备列表与撤销（v1.8.7，P4）────────────────────────────────────────
    //
    // 列表只回「够用一行」的字段：摘要名、最近活跃、入口、配对次数、是否已撤销，
    // 以及 current 标记。设备 id 是 SHA-256 前 12 位摘要 —— 真正能冒充设备的
    // cookie 值（UUID）绝不出现在 JSON / 页面 / 审计里。
    function deviceView(d, currentId) {
      return {
        id: d.id,
        name: d.ua,
        firstSeen: d.firstSeen,
        lastSeen: d.lastSeen,
        via: d.via,
        sessions: d.sessions,
        revoked: d.revoked,
        current: d.id === currentId,
      }
    }

    function readDeviceBody(req, limit = 2048) {
      return new Promise((resolveBody, rejectBody) => {
        let size = 0
        const chunks = []
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > limit) {
            rejectBody(new Error('请求体过大'))
            try { req.destroy() } catch { /* 已断开 */ }
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            const parsed = raw ? JSON.parse(raw) : {}
            resolveBody(parsed && typeof parsed === 'object' ? parsed : {})
          } catch (e) { rejectBody(e) }
        })
        req.on('error', rejectBody)
      })
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/devices',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('allow', 'GET, HEAD')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 GET' })
          return
        }
        const me = req.taskwatchDevice || {}
        const devices = deviceLedger.list().map((d) => deviceView(d, me.digest))
        routeJson(res, 200, {
          ok: true,
          capacity: DEVICE_LEDGER_MAX,
          idleDays: Math.round(DEVICE_IDLE_TTL_MS / 86400000),
          current: me.digest || '',
          devices,
        })
      },
    }), 'in-hand: devices route')

    // 撤销一台设备：标 revoked + 清空它的配对记录。响应仍然是 200（包括撤销自己），
    // 因为「撤销成功」本身是结果；下一次请求才 401 —— 验收里正是按这个顺序断言的。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/devices/revoke',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 POST' })
          return
        }
        if (isCrossSite(req)) {
          routeJson(res, 403, { ok: false, code: 'cross-site', error: '禁止跨站撤销设备' })
          return
        }
        const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
        if (type !== 'application/json') {
          routeJson(res, 415, { ok: false, code: 'unsupported-media-type', error: '请求必须使用 application/json' })
          return
        }
        let body
        try { body = await readDeviceBody(req) } catch {
          routeJson(res, 400, { ok: false, code: 'bad-request', error: '请求体不合法' })
          return
        }
        const ref = asText(body.deviceId)
        if (!ref) {
          routeJson(res, 400, { ok: false, code: 'bad-request', error: '需要 {deviceId}' })
          return
        }
        const me = req.taskwatchDevice || {}
        const hit = deviceLedger.revoke(ref)
        if (!hit) {
          routeJson(res, 404, { ok: false, code: 'unknown-device', error: '这台设备不在列表里（可能已清理）' })
          return
        }
        const self = Boolean(me.digest) && hit.digest === me.digest
        // 审计只写摘要、入口与是否自撤销 —— 不写 IP、不写 UA、不写 cookie。
        writeAudit({
          at: new Date().toISOString(),
          kind: 'device-revoke',
          deviceId: hit.digest,
          via: me.via || 'lan',
          self,
        })
        routeJson(res, 200, {
          ok: true,
          self,
          revoked: hit.digest,
          sessions: hit.sessions,
        })
      },
    }), 'in-hand: device revoke route')

// ===== M. 页面外壳与静态资源 =====
    // 页面外壳。带 ?t= 时先兑换票据：命中 → 302 到 /taskwatch 并种一张换路标记 cookie
    // （与中继同形）；未知/过期 → 401，和中继在换路凭据无效时的选择保持一致。
    // v1.8.6：受众必须是 lan（宿主自己才是兑现方），校验与记账在 ticket.js 里一次完成；
    // 老格式随机串仍走 Map（用后即焚）。401 的文案不回显原因，原因只进日志。
    // v1.8.7：先过设备闸门。被撤销 → 401 + 独立说明页；?pair=1 清掉 HttpOnly
    // cookie 后 302 回 /taskwatch（重新配对 = 下一次请求换一张新身份）。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch',
      handler: (req, res) => {
        const url = (() => { try { return new URL(req.url || '/', 'http://127.0.0.1') } catch { return null } })()
        const gate = ensureDevice(req, res)
        if (!gate.ok) {
          if (url && url.searchParams.get('pair') === '1') {
            addCookie(res, deviceCookie('', 0))
            try {
              res.writeHead(302, { location: '/taskwatch', 'cache-control': 'no-store' })
              res.end()
            } catch { /* 已断开 */ }
            return
          }
          send(res, 401, 'text/html; charset=utf-8', revokedPageHtml())
          return
        }
        markPhoneSeen()
        const ticket = (url && url.searchParams.get('t')) || ''
        if (ticket) {
          const result = tickets().redeemDetailed(ticket)
          if (!result.ok) {
            // 受众不匹配 = "给公网中继签的票拿来宿主兑换"，正式跨入口重放的入口点。
            // 只记原因与受众，绝不把票面写进日志。
            if (result.reason === 'audience') {
              console.warn('dsh-in-hand: ticket audience mismatch (expect lan, got ' + (result.aud || '?') + ')')
            }
            send(res, 401, 'text/plain; charset=utf-8', '换路凭据无效或已过期，请再点一次切换。\n')
            return
          }
          // 票据兑换记录绑定到 deviceId（只记时间/入口，不记票面）。
          deviceLedger.bind(gate.id, { via: gate.via, kind: 'ticket' })
          try {
            addCookie(res, 'tw-route=remote; Path=/taskwatch; HttpOnly; SameSite=Lax; Max-Age=2592000')
            res.writeHead(302, { location: '/taskwatch', 'cache-control': 'no-store' })
            res.end()
          } catch { /* 已断开 */ }
          return
        }
        send(res, 200, 'text/html; charset=utf-8', readPage())
      },
    }), 'in-hand: page route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/manifest.webmanifest',
      handler: (req, res) => send(res, 200, 'application/manifest+json; charset=utf-8', readManifest(), {
        // manifest 很小，且改了就希望手机立刻拿到；不要让它被缓存成旧版本。
        'cache-control': 'no-cache',
      }),
    }), 'in-hand: manifest route')

    // 脚本位于 /taskwatch/sw.js，故 scope '/taskwatch' 无需 Service-Worker-Allowed 头即可生效。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/sw.js',
      handler: (req, res) => send(res, 200, 'text/javascript; charset=utf-8', readSw(), {
        'service-worker-allowed': '/taskwatch',
      }),
    }), 'in-hand: service worker route')

    for (const [path, asset] of ICONS) {
      let body
      try {
        body = readFileSync(asset.file)
      } catch (e) {
        console.error('dsh-in-hand: 读不到图标 ' + asset.file + ' —— ' + why(e))
        continue
      }
      const content = body
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => send(res, 200, asset.type, content, {
          // 图标文件名固定、内容极少变；长缓存省掉每次打开页面的往返。
          'cache-control': 'public, max-age=31536000, immutable',
        }),
      }), 'in-hand: icon route ' + path)
    }
    // ── 离屏通知设置（v1.8.15，N 段）────────────────────────────────────────
    //
    // 五条路由，全部由上面的设备闸门包住（不在 DEVICE_OPEN_PATHS 里），所以只有
    // 配过对的手机能改这张表。两条安全闸在这里的位置很具体：
    //   · 进来的地址只在 add 里出现一次，store 校验后写文件，**不写进任何响应**；
    //   · 出去的只有 list() 的 masked 视图，连错误文案都是固定串。
    // test 是唯一一条会主动发请求的路由，目标地址仍然来自本机文件、由用户自己粘贴。
    async function readNotifyBody(req, res) {
      if (isCrossSite(req)) {
        routeJson(res, 403, { ok: false, code: 'cross-site', error: '禁止跨站修改通知设置' })
        return null
      }
      const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
      if (type !== 'application/json') {
        routeJson(res, 415, { ok: false, code: 'unsupported-media-type', error: '请求必须使用 application/json' })
        return null
      }
      try {
        return await readDeviceBody(req, 8 * 1024)
      } catch {
        routeJson(res, 400, { ok: false, code: 'bad-request', error: '请求体不合法' })
        return null
      }
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/notify',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('allow', 'GET, HEAD')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 GET' })
          return
        }
        const channels = notifyStore.list()
        routeJson(res, 200, {
          ok: true,
          enabled: notifyConfig.enabled,
          anyEnabled: notifyConfig.enabled && channels.some((c) => c.enabled),
          channels,
          limits: {
            maxChannels: NOTIFY_MAX_CHANNELS,
            timeoutMs: NOTIFY_TIMEOUT_MS,
            attempts: NOTIFY_RETRY_DELAYS.length + 1,
            reasonMax: NOTIFY_REASON_MAX,
          },
          preview: NOTIFY_PREVIEW,
        })
      },
    }), 'in-hand: notify route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/notify/add',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 POST' })
          return
        }
        const body = await readNotifyBody(req, res)
        if (!body) return
        const got = notifyStore.add({ type: body.type, key: body.key, url: body.url, format: body.format })
        if (!got.ok) {
          // 失败文案来自 validateNotifyUrl / store，全是固定串，不含用户输入。
          routeJson(res, 400, { ok: false, code: 'bad-request', error: got.error })
          return
        }
        // 新通道要能立刻接上"已经在等"的那批，而不是等下一次待办出现。
        notifier.refresh()
        routeJson(res, 200, { ok: true, existed: got.existed, channel: got.channel, channels: notifyStore.list() })
      },
    }), 'in-hand: notify add route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/notify/toggle',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 POST' })
          return
        }
        const body = await readNotifyBody(req, res)
        if (!body) return
        if (typeof body.enabled !== 'boolean') {
          routeJson(res, 400, { ok: false, code: 'bad-request', error: '需要 {id, enabled: true|false}' })
          return
        }
        const got = notifyStore.setEnabled(body.id, body.enabled)
        if (!got.ok) {
          routeJson(res, 404, { ok: false, code: 'unknown-channel', error: got.error })
          return
        }
        // 打开时重新武装（可能已经有东西在等），关闭时只 poke，不重发。
        if (got.channel.enabled) notifier.refresh()
        else notifier.poke()
        routeJson(res, 200, { ok: true, channel: got.channel, channels: notifyStore.list() })
      },
    }), 'in-hand: notify toggle route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/notify/remove',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 POST' })
          return
        }
        const body = await readNotifyBody(req, res)
        if (!body) return
        const got = notifyStore.remove(body.id)
        if (!got.ok) {
          routeJson(res, 404, { ok: false, code: 'unknown-channel', error: got.error })
          return
        }
        notifier.poke()
        routeJson(res, 200, { ok: true, channels: notifyStore.list() })
      },
    }), 'in-hand: notify remove route')

    // 「发一条测试消息」：走真实发送（同一套 payload / 超时 / 退避），所以它证明的是
    // 整条链路，而不只是"地址存下来了"。失败也是 200 + ok:false —— 这是一次结果汇报，
    // 不是服务器错误；页面按 ok / status / error 显示，错误文案里没有地址。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/notify/test',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 POST' })
          return
        }
        const body = await readNotifyBody(req, res)
        if (!body) return
        const channel = notifyStore.channelForSend(body.id)
        if (!channel) {
          routeJson(res, 404, { ok: false, code: 'unknown-channel', error: '没有这个通道（可能已被删除）' })
          return
        }
        const started = Date.now()
        let result
        try {
          result = await sendNotify(channel, '【测试】' + NOTIFY_TITLE + '：通知已接通，收到这条说明设置生效。')
        } catch {
          result = { ok: false, status: 0, error: '发送失败' }
        }
        if (!result || result.ok !== true) {
          try {
            writeAudit({
              at: new Date().toISOString(),
              kind: 'notify',
              outcome: 'failed',
              error: 'notify failed',
              status: Number(result && result.status) || 0,
            })
          } catch { /* 审计失败不影响结果汇报 */ }
        }
        routeJson(res, 200, {
          ok: Boolean(result && result.ok),
          status: Number(result && result.status) || 0,
          attempts: Number(result && result.attempts) || 1,
          error: result && result.ok ? '' : String((result && result.error) || '发送失败'),
          tookMs: Date.now() - started,
        })
      },
    }), 'in-hand: notify test route')

    // ── 系统通知设置（v1.8.17）──────────────────────────────────────────────
    //
    // 四条路由，全部由上面的设备闸门包住（不在 DEVICE_OPEN_PATHS 里），所以只有
    // 配过对的手机能读 / 改订阅。三条安全闸与 notify 同一套：
    //   · 进来的 endpoint / keys 只在 subscribe 里出现一次，校验后写文件，
    //     **不写进任何响应**；
    //   · 出去的只有 maskPushEndpoint() 的掩码视图；
    //   · 没有任何订阅时，发送模块完全静默。
    // 设备绑定用的是 req.taskwatchDevice.digest（twd cookie 派生的 12 位摘要），
    // 不是 cookie 原值 —— 所以这份文件和审计日志一样，投屏 / 贴出来都不含凭据。
    const pushDeviceId = (req) => asText(req && req.taskwatchDevice && req.taskwatchDevice.digest)

    function pushStateBody(deviceId) {
      const counts = pushStore.countsFor(deviceId)
      return {
        ok: true,
        // 页面 pushManager.subscribe() 的 applicationServerKey。第一次进这一页会
        // 顺手生成一对 VAPID 密钥（仅当前用户可读）—— 那是"首次需要"，不是每次
        // 都生成：之后这里只是读文件。
        vapid: vapidStore.publicKey(),
        devices: counts.devices,
        total: counts.total,
        mine: counts.mine,
        limits: { total: PUSH_MAX_TOTAL, perDevice: PUSH_MAX_PER_DEVICE, endpointMax: PUSH_ENDPOINT_MAX },
        subscriptions: pushStore.list(deviceId),
      }
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/push/state',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('allow', 'GET, HEAD')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 GET' })
          return
        }
        routeJson(res, 200, pushStateBody(pushDeviceId(req)))
      },
    }), 'in-hand: push state route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/push/subscribe',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 POST' })
          return
        }
        const body = await readNotifyBody(req, res)
        if (!body) return
        const deviceId = pushDeviceId(req)
        if (!deviceId) {
          routeJson(res, 400, { ok: false, code: 'bad-request', error: '缺少设备身份，请重新配对' })
          return
        }
        const got = pushStore.add({
          deviceId,
          endpoint: body.endpoint,
          keys: body.keys,
          origin: body.origin,
          ua: req.headers && req.headers['user-agent'],
        })
        if (!got.ok) {
          routeJson(res, 400, { ok: false, code: 'bad-request', error: got.error })
          return
        }
        // 新订阅要能立刻接上「已经在等」的那批，而不是等下一件待办出现。
        try { notifier.refresh() } catch { /* 通知失败不影响这次订阅 */ }
        const counts = pushStore.countsFor(deviceId)
        routeJson(res, 200, {
          ok: true,
          existed: got.existed,
          id: got.id,
          masked: got.masked,
          devices: counts.devices,
          total: counts.total,
          mine: counts.mine,
        })
      },
    }), 'in-hand: push subscribe route')

    // 「关闭此设备」：body 里给 id 就只删那一条，不给就删这台设备的全部订阅。
    // 页面上两个按钮走同一条路（列表里的单条关闭 / 整台关闭），少一条路由。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/push/unsubscribe',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 POST' })
          return
        }
        const body = await readNotifyBody(req, res)
        if (!body) return
        const deviceId = pushDeviceId(req)
        if (!deviceId) {
          routeJson(res, 400, { ok: false, code: 'bad-request', error: '缺少设备身份，请重新配对' })
          return
        }
        const id = asText(body.id)
        if (id) {
          const got = pushStore.remove(id, deviceId)
          if (!got.ok) {
            routeJson(res, 404, { ok: false, code: 'unknown-subscription', error: got.error })
            return
          }
          const counts = pushStore.countsFor(deviceId)
          routeJson(res, 200, { ok: true, removed: 1, devices: counts.devices, total: counts.total })
          return
        }
        const got = pushStore.removeAllFor(deviceId)
        if (!got.ok) {
          routeJson(res, 500, { ok: false, code: 'save-failed', error: got.error })
          return
        }
        const counts = pushStore.countsFor(deviceId)
        routeJson(res, 200, {
          ok: true, removed: got.removed, devices: counts.devices, total: counts.total,
        })
      },
    }), 'in-hand: push unsubscribe route')

    // 「发一条测试通知」：走真实加密 + 真实 VAPID 签名，所以它证明的是整条链路，
    // 而不是"订阅存下来了"。只发给**这台设备**的订阅；一台都没有时回 200 + ok:false
    // （这是一次结果汇报，不是服务器错误）。结果里只有掩码 id 与状态码。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/push/test',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          routeJson(res, 405, { ok: false, code: 'method-not-allowed', error: '只接受 POST' })
          return
        }
        const body = await readNotifyBody(req, res)
        if (!body) return
        const deviceId = pushDeviceId(req)
        const targets = pushStore.targets().filter((t) => t.deviceId === deviceId)
        if (!targets.length) {
          routeJson(res, 200, {
            ok: false, sent: 0, failed: 0, results: [],
            error: '这台设备还没有开启系统通知',
          })
          return
        }
        const started = Date.now()
        let sent = 0
        let failed = 0
        const results = []
        for (const target of targets) {
          let result
          try {
            result = await sendPush(target, buildPushTestMessage({ origin: target.origin }))
          } catch {
            result = { ok: false, status: 0 }
          }
          const ok = Boolean(result && result.ok)
          if (ok) {
            sent++
            try { pushStore.markOk(target.id) } catch { /* 时间戳写不进去不影响结果 */ }
          } else {
            failed++
            const status = Number(result && result.status) || 0
            if (PUSH_GONE_STATUS.indexOf(status) >= 0) {
              try { pushStore.drop(target.id) } catch { /* 下次发送还会再收到 410 */ }
            }
            try {
              writeAudit({
                at: new Date().toISOString(),
                kind: 'push',
                outcome: 'failed',
                error: 'push failed',
                status,
              })
            } catch { /* 审计失败不影响结果汇报 */ }
          }
          results.push({
            id: target.id,
            masked: maskPushEndpoint(target.endpoint),
            ok,
            status: Number(result && result.status) || 0,
            error: ok ? '' : String((result && result.error) || '发送失败'),
          })
        }
        routeJson(res, 200, {
          ok: failed === 0 && sent > 0,
          sent,
          failed,
          results,
          tookMs: Date.now() - started,
        })
      },
    }), 'in-hand: push test route')

  } else {
    console.error('dsh-in-hand: 没有 webServer 服务，HTTP 路由与页面均未注册')
  }
}

// ===== N. 离屏通知（飞书机器人 / Server酱 / 通用 webhook）=====
//
// 这是整个插件**唯一主动往外发**的东西，也是唯一会把用户凭据（webhook 地址与
// Server酱 SendKey 本身就是凭据：拿到它就能往那个群 / 那个微信发消息）带出进程的
// 东西。所以这一段的形状不是按"能不能发出去"设计的，而是按三道闸设计的：
//
//  闸 1（只由用户粘贴）：地址 / SendKey 只从手机设置页的 POST 进来，落到
//    ~/.dsh/taskwatch-notify.json；插件配置里的 notify.channels 会被**显式忽略**
//    并 warn —— 配置会进仓库、进 issue、进截图，而手机粘贴不会。
//  闸 2（只出掩码）：list / 路由响应 / 页面 / 日志里只有 maskNotifyUrl() /
//    maskNotifyKey() 的结果，形如 `https://open.feishu.cn/…/000…（已保存）` 或
//    `SCT…abcd`；完整地址与 SendKey 只存在于 store 内存与发请求那一刻。错误文案
//    是固定中文串，绝不拼接底层异常（fetch 的报错里带 URL 原文，那是这条闸最
//    容易漏的地方）。
//  闸 3（静默）：没有任何启用通道时 createNotifier().poke() 在读完两个 Map 之后
//    立刻返回 —— 不建定时器、不发请求、不写一行日志。
//
// 正文口径也在这里收口（buildNotifyText）：工具名 + reason 前 30 字；多条只列
// 前 3 条再补「还有 N 件」。不拼命令全文、不拼对话正文、不拼 cwd —— 宿主手上有
// 的比这多得多，正因为如此，得由**这一个函数**决定发出去的到底是什么。
export const NOTIFY_FILE_NAME = 'taskwatch-notify.json'
export const NOTIFY_CHANNEL_TYPES = Object.freeze(['feishu', 'serverchan', 'webhook'])
export const NOTIFY_FORMATS = Object.freeze(['json', 'form'])
export const NOTIFY_MAX_CHANNELS = 8
export const NOTIFY_URL_MAX = 1024
export const NOTIFY_TIMEOUT_MS = 8 * 1000
export const NOTIFY_RETRY_DELAYS = Object.freeze([1000, 3000])
export const NOTIFY_REASON_MAX = 30
export const NOTIFY_TEXT_MAX = 600
export const NOTIFY_DEBOUNCE_MS = 1200
export const NOTIFY_TITLE = '掌上 DSH · 有事等你'
/** Server酱 的固定入口；SendKey 由用户粘贴，**不存完整 URL**。 */
export const NOTIFY_SERVERCHAN_BASE = 'https://sctapi.ftqq.com'
export const NOTIFY_SENDKEY_MIN = 10
export const NOTIFY_SENDKEY_MAX = 64
/** 微信通知标题会截断，超过这个长度就自己截并补「…」（总长 ≤32）。 */
export const NOTIFY_SERVERCHAN_TITLE_MAX = 32
/** 设置页拿它做「会收到什么」的示例，和 buildNotifyText 的格式是同一份口径。 */
export const NOTIFY_PREVIEW = '1 件事等你：pwsh · 删除 build/cache 下的…'

/** 配置声明的可读形态。**故意没有 url**：地址只能由用户在手机上粘贴，见闸 1。 */
export const NOTIFY_CONFIG_SCHEMA = Object.freeze({
  enabled: { type: 'boolean', default: true, description: '通知总开关；false 时通知模块完全不工作' },
  debounceMs: {
    type: 'integer',
    default: NOTIFY_DEBOUNCE_MS,
    minimum: 200,
    maximum: 10000,
    description: '合并窗口：这段时间内出现的多件事只推一条',
  },
})

/** 把插件配置收敛成 { enabled, debounceMs }。
 *  配了 channels 也不接受：那条路绕过了「地址只由手机粘贴」的闸，而且地址一旦
 *  进了配置就会随仓库/截图/issue 外流。所以这里不是忽略，是**明确 warn 后丢弃**。 */
export function resolveNotifyConfig(config, warn = () => {}) {
  const src = config && typeof config === 'object' ? config : {}
  const enabled = src.enabled !== false
  let debounceMs = NOTIFY_DEBOUNCE_MS
  const raw = src.debounceMs
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(n)) {
      debounceMs = Math.round(n)
      if (debounceMs < 200) { debounceMs = 200; warn('notify.debounceMs 小于 200，已按 200 处理') }
      else if (debounceMs > 10000) { debounceMs = 10000; warn('notify.debounceMs 大于 10000，已按 10000 处理') }
    } else {
      warn('notify.debounceMs 不是数字，已按默认值 ' + NOTIFY_DEBOUNCE_MS + ' 处理')
    }
  }
  if (src.channels !== undefined && src.channels !== null) {
    warn('notify.channels 已被忽略：webhook 地址只能从手机设置页粘贴，存到 ~/.dsh/'
      + NOTIFY_FILE_NAME + '，插件配置不接收地址')
  }
  return { enabled, debounceMs }
}

/** 掩码：只留协议 + 主机 + 路径最后一段的前 3 个字符。
 *  这不是"看起来安全"的装饰 —— 路由响应与页面渲染只认这个函数的输出，
 *  所以它在测试里是可断言的（响应文本里不许出现完整地址）。 */
export function maskNotifyUrl(raw) {
  let u
  try { u = new URL(String(raw == null ? '' : raw).trim()) } catch { return '（已保存）' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '（已保存）'
  const segs = u.pathname.split('/').filter(Boolean)
  const tail = segs.length ? segs[segs.length - 1] : ''
  const shown = tail ? tail.slice(0, 3) + (tail.length > 3 ? '…' : '') : ''
  return u.protocol + '//' + u.host + (shown ? '/…/' + shown : '/…') + '（已保存）'
}

/** SendKey 的掩码：保留首 3 + 末 4，形如 `SCT…abcd`。
 *  和 maskNotifyUrl 一样，它是路由响应与页面**唯一**能拿到的形态，所以可以在
 *  测试里直接断言「响应文本里不出现完整 SendKey」。 */
export function maskNotifyKey(raw) {
  const key = String(raw == null ? '' : raw).trim()
  if (!key) return '（已保存）'
  if (key.length < 8) return key.slice(0, 3) + '…'
  return key.slice(0, 3) + '…' + key.slice(-4)
}

/** SendKey 校验：字母数字与 `-` `_`，10–64 位。
 *  **不按 32 位固定长度**写死 —— 那是对面实现的细节，改一次校验就全废；也不要求
 *  必须 `SCT` 开头，前缀只是现状，不是协议。失败文案固定，不回显用户输入。 */
export function validateSendKey(raw) {
  const key = String(raw == null ? '' : raw).trim()
  if (!key) return { ok: false, error: '请粘贴 SendKey（sct.ftqq.com 里复制的那一串）' }
  if (key.length < NOTIFY_SENDKEY_MIN || key.length > NOTIFY_SENDKEY_MAX) {
    return {
      ok: false,
      error: 'SendKey 长度应在 ' + NOTIFY_SENDKEY_MIN + '–' + NOTIFY_SENDKEY_MAX + ' 位之间',
    }
  }
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    return { ok: false, error: 'SendKey 只能包含字母、数字、- 和 _' }
  }
  return { ok: true, key }
}

/** SendKey → 请求地址。只在发送那一刻拼，**不落盘**：文件里只有 key。
 *  base 可注入，唯一用途是让测试打本地假服务器，默认值永远是官方域名。 */
export function serverchanEndpoint(key, base = NOTIFY_SERVERCHAN_BASE) {
  const root = String(base || NOTIFY_SERVERCHAN_BASE).replace(/\/+$/, '')
  return root + '/' + encodeURIComponent(String(key == null ? '' : key).trim()) + '.send'
}

/** 内网 http 白名单。只认点分四段的 IPv4 —— `10.evil.com` 这种"以 10. 开头"的
 *  公网域名必须被拒，按字符串前缀判断会被它绕过去。 */
function isPrivateHttpHost(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || ''))
  if (!m) return false
  const [a, b, c, d] = m.slice(1).map(Number)
  if ([a, b, c, d].some((n) => n > 255)) return false
  if (a === 127) return true
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** 地址校验：只放行 https；http 仅限本机 / 内网（自测用）。
 *  失败文案固定，不把用户输入拼回去 —— 那等于在错误提示里回显一遍地址。 */
export function validateNotifyUrl(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return { ok: false, error: '请粘贴 webhook 地址' }
  if (text.length > NOTIFY_URL_MAX) {
    return { ok: false, error: '地址过长（上限 ' + NOTIFY_URL_MAX + ' 字符）' }
  }
  let u
  try { u = new URL(text) } catch { return { ok: false, error: '这不是一个合法地址（要带 https://）' } }
  if (u.username || u.password) return { ok: false, error: '地址里不能带用户名或密码' }
  if (u.hash) u.hash = ''
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: '只支持 https://（自测才允许本机 / 内网的 http://）' }
  }
  if (u.protocol === 'http:' && !isPrivateHttpHost(u.hostname)) {
    return {
      ok: false,
      error: 'http:// 只允许本机或内网地址（127.0.0.1 / 10.x / 192.168.x / 172.16–31.x），公网请用 https://',
    }
  }
  return { ok: true, url: u.toString() }
}

/** 一件待办的「一行摘要」。审批用工具名 + reason，提问用「提问」+ 标题。
 *  两个来源都**只取宿主已经准备给手机看的那一列**，不碰命令、不碰消息正文。 */
function notifyBrief(item) {
  if (item && item.kind === 'question') {
    return '提问 · ' + clipNotifyText(asText(item.title), NOTIFY_REASON_MAX)
  }
  const name = asText(item && item.title) || '(tool)'
  const reason = clipNotifyText(asText(item && item.detail), NOTIFY_REASON_MAX)
  return name + (reason ? ' · ' + reason : '')
}

/** 折叠空白、去掉控制字符、按字符数截断并补省略号。 */
export function clipNotifyText(raw, max = NOTIFY_REASON_MAX) {
  const flat = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return ''
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/** 正文口径（纯函数，测试直接钉住）：
 *    1 件事等你：pwsh · 删除 build/cache 下的…
 *    3 件事等你：
 *    · pwsh · 删除 build/cache 下的过期产物
 *    · 提问 · 发布窗口
 *    · pwsh · 在仓库根目录执行 npm publish…
 *    还有 2 件
 *  已 settle 的条目不算「等你」，和 /taskwatch/data 的口径一致。 */
export function buildNotifyText(pending) {
  const list = Array.isArray(pending) ? pending.filter((p) => p && !p.settled) : []
  if (!list.length) return ''
  const head = list.length + ' 件事等你'
  if (list.length === 1) return (head + '：' + notifyBrief(list[0])).slice(0, NOTIFY_TEXT_MAX)
  const shown = list.slice(0, 3)
  const lines = [head + '：']
  for (const item of shown) lines.push('· ' + notifyBrief(item))
  if (list.length > shown.length) lines.push('还有 ' + (list.length - shown.length) + ' 件')
  const text = lines.join('\n')
  return text.length > NOTIFY_TEXT_MAX ? text.slice(0, NOTIFY_TEXT_MAX) + '…' : text
}

/** Server酱 的标题：取正文首行冒号前那段（单条就是 `1 件事等你`，多条就是
 *  `3 件事等你`，测试消息就是 `【测试】掌上 DSH · 有事等你`）。
 *  微信通知栏会截断标题，所以这里先自己截到 32 字并以「…」收尾，**不交给对方**。 */
export function notifyServerchanTitle(text) {
  const first = String(text == null ? '' : text).split(/\r?\n/, 1)[0] || ''
  const head = first.split('：', 1)[0].split(':', 1)[0].trim()
  const title = head || NOTIFY_TITLE
  if (title.length <= NOTIFY_SERVERCHAN_TITLE_MAX) return title
  return title.slice(0, NOTIFY_SERVERCHAN_TITLE_MAX - 1) + '…'
}

/** 每种通道的请求体：
 *    feishu  → { msg_type:'text', content:{ text } }（飞书自定义机器人的协议）
 *    serverchan → application/x-www-form-urlencoded 的 title + desp，**只有这两个字段**
 *    webhook + json → { title, content }
 *    webhook + form → application/x-www-form-urlencoded 的 title + desp（历史形态）
 *  `format` 只对 webhook 有意义，feishu / serverchan 永远走各自的协议。 */
export function buildNotifyPayload(channel, text) {
  const body = String(text == null ? '' : text)
  if (channel && channel.type === 'serverchan') {
    const params = new URLSearchParams()
    params.set('title', notifyServerchanTitle(body))
    params.set('desp', body)
    return {
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      body: params.toString(),
    }
  }
  if (channel && channel.type === 'webhook') {
    if (channel.format === 'form') {
      const params = new URLSearchParams()
      params.set('title', NOTIFY_TITLE)
      params.set('desp', body)
      return {
        contentType: 'application/x-www-form-urlencoded; charset=utf-8',
        body: params.toString(),
      }
    }
    return {
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ title: NOTIFY_TITLE, content: body }),
    }
  }
  return {
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ msg_type: 'text', content: { text: body } }),
  }
}

/** 固定的失败文案。**绝不**拼接 e.message：undici 的 TypeError 里带完整请求地址，
 *  拼一次就等于把闸 2 拆了。超时文案按实际 timeoutMs 算，不是写死 8。 */
function notifyFailure(e, timeoutMs) {
  const name = e && e.name ? String(e.name) : ''
  const message = String((e && e.message) || '')
  if (name === 'TimeoutError' || name === 'AbortError' || /abort|timeout/i.test(message)) {
    return '超时（' + Math.round(timeoutMs / 1000) + ' 秒）'
  }
  return '网络不通或地址不可达'
}

export function createNotifySender({
  fetchImpl = globalThis.fetch,
  timeoutMs = NOTIFY_TIMEOUT_MS,
  retryDelays = NOTIFY_RETRY_DELAYS,
  serverchanBase = NOTIFY_SERVERCHAN_BASE,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('这个 Node 没有 fetch，通知发不出去')
  }
  const gaps = Array.isArray(retryDelays) ? retryDelays.filter((n) => Number.isFinite(n) && n >= 0) : []
  async function attempt(channel, text) {
    const payload = buildNotifyPayload(channel, text)
    // serverchan 的地址永远由 key 现拼（文件里没有 URL）；其余通道用存下来的地址。
    const target = channel && channel.type === 'serverchan'
      ? (channel.key ? serverchanEndpoint(channel.key, serverchanBase) : '')
      : (channel && channel.url)
    if (!target) return { ok: false, status: 0, error: '没有可用的地址或 SendKey' }
    const controller = new AbortController()
    const timer = setTimeout(() => { try { controller.abort() } catch { /* 已结束 */ } }, Math.max(1, timeoutMs))
    if (timer && typeof timer.unref === 'function') timer.unref()
    try {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'content-type': payload.contentType, 'user-agent': 'dsh-in-hand-notify' },
        body: payload.body,
        signal: controller.signal,
        redirect: 'follow',
      })
      const status = response && typeof response.status === 'number' ? response.status : 0
      // 回执不读、不记：对方返回什么与我们无关，而回执文本有可能把地址带回来。
      try { if (response && response.body && typeof response.body.cancel === 'function') await response.body.cancel() } catch { /* 已关闭 */ }
      if (status >= 200 && status < 300) return { ok: true, status, error: '' }
      return { ok: false, status, error: status ? 'HTTP ' + status : '发送失败' }
    } catch (e) {
      return { ok: false, status: 0, error: notifyFailure(e, timeoutMs) }
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    timeoutMs,
    /** 最多 1 + gaps.length 次（默认 3 次），间隔 1s / 3s。失败不抛错：
     *  通知发不出去绝不能反过来影响审批链。 */
    async send(channel, text) {
      let last = { ok: false, status: 0, error: '发送失败' }
      for (let i = 0; i <= gaps.length; i++) {
        if (i > 0) await sleep(gaps[i - 1])
        last = await attempt(channel, text)
        if (last.ok) return { ...last, attempts: i + 1 }
      }
      return { ...last, attempts: gaps.length + 1 }
    },
  }
}

/** 通知配置的落点，与审计日志同一套目录习惯（DSH_HOME 优先，否则 ~/.dsh）。 */
export function notifyConfigPath(env = process.env, home = homedir()) {
  const raw = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const root = raw ? resolve(raw) : join(home, '.dsh')
  return join(root, NOTIFY_FILE_NAME)
}

/** 本机文件存储。三条不变量：
 *    1. 对外只出 masked 视图，raw url 只有 channelForSend() 拿得到；
 *    2. 写盘一次就收紧一次权限（POSIX 0600 / Windows icacls 去继承），失败只 warn；
 *    3. 文件不存在 = 从没配过 = 静默，不产生任何日志。
 *  读坏了（手改 JSON 少个引号）也只 warn 一次，并按未配置处理 —— 通知坏了不能
 *  把插件加载拖垮。 */
export function createNotifyStore({
  file,
  fs = { readFileSync, writeFileSync, mkdirSync, chmodSync },
  platform = process.platform,
  env = process.env,
  run = spawnSync,
  logger = console,
  newId = randomUUID,
} = {}) {
  let state = null
  let warned = false
  let tightenCalls = 0
  const warnOnce = (msg) => {
    if (warned) return
    warned = true
    try { if (logger && typeof logger.error === 'function') logger.error('dsh-in-hand: ' + msg) } catch { /* 日志失败不影响主链路 */ }
  }
  const isKeyType = (c) => c.type === 'serverchan'
  const view = (c) => {
    const out = {
      id: c.id,
      type: c.type,
      enabled: c.enabled,
      // serverchan 只有 SendKey，掩码是 `SCT…abcd`；其余通道走地址掩码。
      masked: isKeyType(c) ? maskNotifyKey(c.key) : maskNotifyUrl(c.url),
    }
    if (!isKeyType(c)) out.format = c.format
    return out
  }

  function parse(raw) {
    const out = []
    const list = Array.isArray(raw && raw.channels) ? raw.channels : []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const type = NOTIFY_CHANNEL_TYPES.includes(item.type) ? item.type : ''
      if (!type) continue
      if (type === 'serverchan') {
        // 只认 key：手改配置时塞进来的 url 一律忽略，免得把整条 URL 当 key 存下。
        const checked = validateSendKey(item.key)
        if (!checked.ok) continue
        out.push({
          id: asText(item.id) || newId(),
          type,
          key: checked.key,
          enabled: item.enabled !== false,
        })
      } else {
        const checked = validateNotifyUrl(item.url)
        // 手改坏的条目直接丢：留着它只会在发送时把整条链路打崩，且没有任何提示价值。
        if (!checked.ok) continue
        out.push({
          id: asText(item.id) || newId(),
          type,
          format: type === 'webhook' && item.format === 'form' ? 'form' : 'json',
          url: checked.url,
          enabled: item.enabled !== false,
        })
      }
      if (out.length >= NOTIFY_MAX_CHANNELS) break
    }
    return out
  }

  function load() {
    if (state) return state
    let channels = []
    try {
      channels = parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (e) {
      // ENOENT 是「还没配过」，属于正常路径：一声不响。
      if (!e || e.code !== 'ENOENT') warnOnce('通知配置读不出来（' + NOTIFY_FILE_NAME + '），按未配置处理')
    }
    state = { channels }
    return state
  }

  function tighten() {
    tightenCalls++
    try {
      if (platform === 'win32') {
        const user = String((env && (env.USERNAME || env.USER)) || '').trim()
        if (!user) return 'unknown-user'
        // Windows 没有 0600：去掉继承、只给当前用户，是这里能做到的最强 best-effort。
        const result = run('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], {
          windowsHide: true,
          timeout: 5000,
        })
        return result && result.status === 0 ? 'user-only' : 'best-effort-failed'
      }
      fs.chmodSync(file, 0o600)
      return 'user-only'
    } catch {
      return 'best-effort-failed'
    }
  }

  function persist(next) {
    const payload = {
      version: 1,
      // 落盘形状：serverchan **只有 key**（永不写完整 URL），其余通道沿用 url。
      channels: next.channels.map((c) => (isKeyType(c)
        ? { id: c.id, type: c.type, key: c.key, enabled: c.enabled }
        : { id: c.id, type: c.type, format: c.format, url: c.url, enabled: c.enabled })),
    }
    try {
      fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
      const permission = tighten()
      if (permission === 'unknown-user' || permission === 'best-effort-failed') {
        warnOnce('通知配置权限收紧失败（best-effort），文件仍只建议本机使用：' + NOTIFY_FILE_NAME)
      }
      state = next
      return true
    } catch (e) {
      warnOnce('通知配置写不进去（' + NOTIFY_FILE_NAME + '）：' + why(e))
      return false
    }
  }

  return {
    file,
    load,
    /** 页面能看到的唯一形态：masked，没有 url 字段。 */
    list() {
      return load().channels.map(view)
    },
    /** 发送用的内部形态（含 raw url）。只在宿主侧调用，绝不进任何响应。 */
    enabledChannels() {
      return load().channels.filter((c) => c.enabled).map((c) => ({ ...c }))
    },
    channelForSend(id) {
      const key = asText(id)
      const hit = load().channels.find((c) => c.id === key)
      return hit ? { ...hit } : null
    },
    add(input) {
      const type = asText(input && input.type)
      if (!NOTIFY_CHANNEL_TYPES.includes(type)) {
        return { ok: false, error: '类型只能是飞书（feishu）、Server酱（serverchan）或通用（webhook）' }
      }
      const next = { channels: load().channels.map((c) => ({ ...c })) }
      let channel
      let dup
      if (type === 'serverchan') {
        // SendKey 是唯一输入；input.url 就算带了也不看（不存 URL）。
        const checked = validateSendKey(input && input.key)
        if (!checked.ok) return { ok: false, error: checked.error }
        dup = next.channels.find((c) => isKeyType(c) && c.key === checked.key)
        channel = { id: newId(), type, key: checked.key, enabled: true }
      } else {
        const checked = validateNotifyUrl(input && input.url)
        if (!checked.ok) return { ok: false, error: checked.error }
        dup = next.channels.find((c) => !isKeyType(c) && c.url === checked.url)
        channel = {
          id: newId(),
          type,
          format: type === 'webhook' && input.format === 'form' ? 'form' : 'json',
          url: checked.url,
          enabled: true,
        }
      }
      if (dup) {
        if (!dup.enabled) { dup.enabled = true; persist(next) }
        return { ok: true, existed: true, channel: view(dup) }
      }
      if (next.channels.length >= NOTIFY_MAX_CHANNELS) {
        return { ok: false, error: '最多 ' + NOTIFY_MAX_CHANNELS + ' 个通道，先删掉一个' }
      }
      next.channels.push(channel)
      if (!persist(next)) return { ok: false, error: '保存失败（检查 ' + NOTIFY_FILE_NAME + ' 的权限）' }
      return { ok: true, existed: false, channel: view(channel) }
    },
    setEnabled(id, enabled) {
      const key = asText(id)
      const next = { channels: load().channels.map((c) => ({ ...c })) }
      const hit = next.channels.find((c) => c.id === key)
      if (!hit) return { ok: false, error: '没有这个通道（可能已被删除）' }
      const want = enabled !== false
      if (hit.enabled === want) return { ok: true, channel: view(hit) }
      hit.enabled = want
      if (!persist(next)) return { ok: false, error: '保存失败（检查 ' + NOTIFY_FILE_NAME + ' 的权限）' }
      return { ok: true, channel: view(hit) }
    },
    remove(id) {
      const key = asText(id)
      const next = { channels: load().channels.filter((c) => c.id !== key) }
      if (next.channels.length === load().channels.length) return { ok: false, error: '没有这个通道（可能已被删除）' }
      if (!persist(next)) return { ok: false, error: '保存失败（检查 ' + NOTIFY_FILE_NAME + ' 的权限）' }
      return { ok: true }
    },
    permission() {
      return platform === 'win32' ? 'icacls:user-only(best-effort)' : 'mode:600'
    },
    stats() {
      return { tightenCalls, permission: this.permission() }
    },
  }
}

/** 触发与去重合并。
 *
 *  时机：approvals / questions 两个 Map 里**任何一次**进出都 poke 一次；真正的
 *  发送推迟到合并窗口（默认 1.2 秒）之后。
 *  去重：窗口内多件 → 一条「N 件事等你」；**只要还有东西在等，就不再推第二条**。
 *  这一点是需求里最容易被写成 bug 的地方：每来一件就推一条，手机在半小时的
 *  审批里会被打十几次；而按"集合签名"去重又会退化成"新来一件就再推一次"。
 *  这里取最简单的语义 —— 从「空」到「非空」推一次，回到空之后才重新武装。
 *  所以它既不会漏掉新出现的一批（那时已清空），也不会在持续等待时重复打扰。
 *  失败只写一行 `notify failed` 审计（不含 URL、不含通道名）。 */
export function createNotifier({
  pending = () => [],
  store,
  send,
  audit = () => {},
  enabled = true,
  debounceMs = NOTIFY_DEBOUNCE_MS,
  now = Date.now,
  // v1.8.17：系统通知（Web Push）。形状刻意与 store/send 平行 —— 一张"往哪发"的
  // 清单 + 一个发送函数 + 一个订阅失效时的删除回调。不传就完全等价于 v1.8.16。
  pushTargets = null,
  sendPush = null,
  onPushGone = () => {},
} = {}) {
  let timer = null
  let armed = true
  let disposed = false
  let lastResult = null

  const clear = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }
  function waitList() {
    try {
      const list = pending()
      return Array.isArray(list) ? list.filter((item) => item && !item.settled) : []
    } catch (e) {
      // 观测失败绝不影响审批链；这里连日志都不写，免得每件待办刷一行。
      return []
    }
  }
  /** 当前能发的系统通知订阅。读文件失败按"没有"处理：推送不能把审批链拖垮。 */
  function pushList() {
    if (typeof sendPush !== 'function' || typeof pushTargets !== 'function') return []
    try {
      const list = pushTargets()
      return Array.isArray(list) ? list.filter((item) => item && item.endpoint) : []
    } catch {
      return []
    }
  }
  function remember(result) {
    lastResult = {
      at: now(),
      ok: result.ok === true,
      status: Number(result.status) || 0,
      attempts: Number(result.attempts) || 1,
    }
    return lastResult
  }
  /** 一条推送。失败只写一行 `push failed`（status 里已经有 404/410 与 5xx 的区别，
   *  审计里不出现 endpoint —— 那串东西本身就是"能往这台设备推"的凭据）。
   *  404 / 410 是订阅已失效的确定信号，顺手删掉，免得每次有事都白发一遍。 */
  async function deliverPush(target, list) {
    let result
    try {
      result = await sendPush(target, buildPushMessage({
        count: list.length,
        text: buildNotifyText(list),
        origin: target.origin || '',
      }))
    } catch {
      result = { ok: false, status: 0 }
    }
    const kept = remember(result || {})
    if (kept.ok) return kept
    if (kept.status === 404 || kept.status === 410) {
      try { onPushGone(target.id, kept.status) } catch { /* 删除失败不影响发送结果 */ }
    }
    try {
      audit({
        at: new Date(now()).toISOString(),
        kind: 'push',
        outcome: 'failed',
        error: 'push failed',
        status: kept.status,
      })
    } catch { /* 审计失败不影响发送结果 */ }
    return kept
  }

  async function flush() {
    timer = null
    if (disposed) return null
    if (!enabled) return null
    let channels = []
    try { channels = store.enabledChannels() } catch { channels = [] }
    const targets = pushList()
    const list = waitList()
    if (!list.length || (!channels.length && !targets.length)) {
      armed = true
      return null
    }
    const text = buildNotifyText(list)
    if (!text) return null
    // 先解除武装再发：发送期间来的 poke 不会排出第二条。
    armed = false
    const results = await Promise.all([
      ...channels.map(async (channel) => {
        let result
        try { result = await send(channel, text) } catch (e) { result = { ok: false, status: 0, error: 'notify failed' } }
        const kept = remember(result || {})
        if (!kept.ok) {
          try {
            audit({
              at: new Date(now()).toISOString(),
              kind: 'notify',
              outcome: 'failed',
              error: 'notify failed',
              status: kept.status,
            })
          } catch { /* 审计失败不影响发送结果 */ }
        }
        return kept
      }),
      ...targets.map((target) => deliverPush(target, list)),
    ])
    return results
  }

  return {
    /** 只排一次定时器；没有启用通道、也没有订阅时连定时器都不建（闸 3）。 */
    poke() {
      if (disposed) return
      if (!enabled) { clear(); return }
      let channels = []
      try { channels = store.enabledChannels() } catch { channels = [] }
      if (!channels.length && !pushList().length) { armed = true; clear(); return }
      if (armed && timer) { /* 窗口已开，等它自己到点 */ return }
      const list = waitList()
      if (!list.length) { armed = true; clear(); return }
      if (!armed) return
      timer = setTimeout(() => { void flush().catch(() => {}) }, Math.max(0, debounceMs))
      if (timer && typeof timer.unref === 'function') timer.unref()
    },
    flushNow() { clear(); return flush() },
    reset() { armed = true; clear() },
    dispose() { disposed = true; clear() },
    stats() { return { armed, waiting: Boolean(timer), lastResult } },
    /** 设置页改了通道之后调用：让它能立刻接上"已经在等"的那批。 */
    refresh() { armed = true; this.poke() },
  }
}

// ===== O. 系统通知（Web Push，v1.8.17）=====
//
// 这是整个插件**第二条主动往外发**的路径，但它是唯一一条**不经第三方**的：
// 浏览器把订阅交给推送服务（Chrome 的 FCM、Safari 的 APNs），真正把通知递到锁屏
// 的是系统自己。我们只做三件事：存订阅、签 VAPID、加密正文。
//
// 与 N 段（飞书 / Server酱 / webhook）共享的是「什么时候发」（createNotifier 的
// 1.2 秒合并窗口与"从空到非空只推一次"），刻意不复用的是"往哪发"：
//   · 通道是用户粘贴的地址，属于凭据 → 只存本机、只回掩码；
//   · 订阅是浏览器给的 endpoint，同样只存本机、只回掩码，但**多了设备绑定**：
//     订阅属于哪台手机由 twd cookie 派生的设备摘要决定，撤销设备后就再也收不到。
//
// 三道闸与 N 段一致，只是落点不同：
//   闸 1（只由浏览器给）：endpoint / p256dh / auth 只能来自页面里 pushManager.subscribe()
//        的结果，经 POST /taskwatch/push/subscribe 落盘。插件配置里没有任何入口。
//   闸 2（只出掩码）：state / subscribe / test 的响应里只有 maskPushEndpoint()，
//        形如 `https://fcm.googleapis.com/…/AbCdEf`；完整 endpoint 只存在于文件、
//        内存与发请求那一刻。失败文案是固定串 —— undici 的 TypeError 里带 URL。
//   闸 3（静默）：一条订阅都没有时 createNotifier().poke() 连定时器都不建。
//
// 为什么自己实现加密：RFC 8291 只有 ECDH + HKDF + AES-GCM 三步，node:crypto 全都
// 有；而 scripts/check-webpush.mjs 能拿 RFC 附录 A 的测试向量逐字节对，比"接一个
// 库、相信它"更容易证明对。多一个运行时依赖，就要在用户机器上多跟一次升级。
export const PUSH_FILE_NAME = 'taskwatch-push.json'
export const PUSH_VAPID_FILE_NAME = 'taskwatch-vapid.json'
/** 全机最多 20 条订阅。 */
export const PUSH_MAX_TOTAL = 20
/** 单台设备最多 5 条（同一台手机重装 / 换浏览器会留下旧订阅，给一点余量）。 */
export const PUSH_MAX_PER_DEVICE = 5
export const PUSH_ENDPOINT_MAX = 1024
export const PUSH_ORIGIN_MAX = 300
export const PUSH_TIMEOUT_MS = 8 * 1000
/** 推送服务用这两个码明确说"这个订阅没了"。收到就删，不重试。 */
export const PUSH_GONE_STATUS = Object.freeze([404, 410])

/** 内网 http 白名单（与 validateNotifyUrl 同一套判定；独立一份是为了不把 webpush
 *  的校验绑在通知模块上）。只认点分四段 IPv4 —— `10.evil.com` 必须被拒。 */
function isPrivatePushHost(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || ''))
  if (!m) return false
  const [a, b, c, d] = m.slice(1).map(Number)
  if ([a, b, c, d].some((n) => n > 255)) return false
  if (a === 127) return true
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** 订阅 endpoint：只放行 https；http 仅本机 / 内网（自测用）。
 *  失败文案固定，不把用户输入拼回去。 */
export function validatePushEndpoint(raw) {
  const text = asText(raw)
  if (!text) return { ok: false, error: '缺少订阅地址（endpoint）' }
  if (text.length > PUSH_ENDPOINT_MAX) {
    return { ok: false, error: '订阅地址过长（上限 ' + PUSH_ENDPOINT_MAX + ' 字符）' }
  }
  let url
  try { url = new URL(text) } catch { return { ok: false, error: '订阅地址不合法' } }
  if (url.username || url.password) return { ok: false, error: '订阅地址里不能带用户名或密码' }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: '订阅地址只支持 https://（自测才允许本机 / 内网的 http://）' }
  }
  if (url.protocol === 'http:' && !isPrivatePushHost(url.hostname)) {
    return { ok: false, error: 'http:// 只允许本机或内网地址，公网请用 https://' }
  }
  return { ok: true, endpoint: url.toString(), origin: url.origin }
}

/** 订阅密钥：p256dh 是 65 字节未压缩点，auth 是 16 字节。
 *  这两个值算错不会报错，只会安静地收不到 —— 所以在入口就把长度钉死。 */
export function validatePushKeys(keys) {
  const p256dh = asText(keys && keys.p256dh)
  const auth = asText(keys && keys.auth)
  if (!p256dh || !auth) return { ok: false, error: '缺少订阅密钥（keys.p256dh / keys.auth）' }
  const pub = unb64url(p256dh)
  const secret = unb64url(auth)
  if (pub.length !== 65 || pub[0] !== 0x04) {
    return { ok: false, error: '订阅公钥不合法（p256dh 应为 65 字节未压缩点）' }
  }
  if (secret.length !== 16) return { ok: false, error: '订阅密钥不合法（auth 应为 16 字节）' }
  return { ok: true, keys: { p256dh: b64url(pub), auth: b64url(secret) } }
}

/** 点通知要打开的地址：只留 origin（路径 / 查询 / 片段一律丢掉）。
 *  页面在哪个入口打开（公网中继 / 局域网）由它自己报，服务端不猜。 */
export function validatePushOrigin(raw) {
  const text = asText(raw)
  if (!text) return { ok: false, error: '缺少 origin' }
  if (text.length > PUSH_ORIGIN_MAX) return { ok: false, error: 'origin 过长' }
  let url
  try { url = new URL(text) } catch { return { ok: false, error: 'origin 不合法' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'origin 只支持 http(s)' }
  }
  if (url.protocol === 'http:' && !isPrivatePushHost(url.hostname)) {
    return { ok: false, error: 'http:// 的 origin 只允许本机或内网地址' }
  }
  return { ok: true, origin: url.origin }
}

/** 掩码：保留域名 + 尾部 6 字符，形如 `https://fcm.googleapis.com/…/AbCdEf`。
 *  路由响应、页面、日志只认这个输出，所以"响应里没有完整 endpoint"是可断言的。 */
export function maskPushEndpoint(raw) {
  const text = asText(raw)
  let url
  try { url = new URL(text) } catch { return '（已保存）' }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '（已保存）'
  const tail = text.replace(/\/+$/, '').slice(-6)
  return url.protocol + '//' + url.host + '/…/' + tail
}

/** 设备名只留「浏览器 · 系统」这一层：够区分是哪台手机，又不把完整 UA 存下来。 */
export function shortPushUa(raw) {
  const ua = asText(raw)
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
      : /Windows/.test(ua) ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
          : /Linux/.test(ua) ? 'Linux' : ''
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari' : ''
  const name = [browser, os].filter(Boolean).join(' · ')
  return name || '浏览器'
}

/** 订阅文件 / VAPID 密钥文件的落点（与通知配置同一套目录习惯）。 */
export function pushStorePath(env = process.env, home = homedir()) {
  const raw = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const root = raw ? resolve(raw) : join(home, '.dsh')
  return join(root, PUSH_FILE_NAME)
}

export function vapidKeyPath(env = process.env, home = homedir()) {
  const raw = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const root = raw ? resolve(raw) : join(home, '.dsh')
  return join(root, PUSH_VAPID_FILE_NAME)
}

/** 权限收紧：POSIX 0600；Windows 没有 0600，退化成"去掉继承、只授权当前用户"。
 *  与 createNotifyStore 里那段同一套做法，失败只 warn（best-effort）。 */
function tightenSecret(file, { platform, env, run, fs }) {
  try {
    if (platform === 'win32') {
      const user = String((env && (env.USERNAME || env.USER)) || '').trim()
      if (!user) return 'unknown-user'
      const result = run('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], {
        windowsHide: true,
        timeout: 5000,
      })
      return result && result.status === 0 ? 'user-only' : 'best-effort-failed'
    }
    fs.chmodSync(file, 0o600)
    return 'user-only'
  } catch {
    return 'best-effort-failed'
  }
}

/** VAPID 密钥：`~/.dsh/taskwatch-vapid.json`（仅当前用户可读）。
 *
 *  **首次需要时**才生成：页面第一次进「系统通知」问公钥、或者第一次要发推送。
 *  没开过系统通知的机器上不会有这个文件，也不会有任何密钥生成动作。
 *  文件坏了（手改 JSON）就重新生成并 warn 一次 —— 代价是旧订阅要重新开启，
 *  因为订阅在浏览器侧绑定的是**这把**公钥；静默沿用坏文件则是永远发不出去。 */
export function createVapidStore({
  file,
  fs = { readFileSync, writeFileSync, mkdirSync, chmodSync },
  platform = process.platform,
  env = process.env,
  run = spawnSync,
  logger = console,
  now = Date.now,
  generate = generateVapidKeys,
} = {}) {
  let keys = null
  let warned = false
  let tightenCalls = 0
  const warnOnce = (msg) => {
    if (warned) return
    warned = true
    try { if (logger && typeof logger.error === 'function') logger.error('dsh-in-hand: ' + msg) } catch { /* 日志失败不影响主链路 */ }
  }
  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const checked = checkVapidKeys(parsed && parsed.publicKey, parsed && parsed.privateKey)
      if (!checked.ok) {
        warnOnce('VAPID 密钥文件不可用（' + checked.error + '），已重新生成 —— 已开启的设备需要重新开启系统通知')
        return null
      }
      return { publicKey: String(parsed.publicKey), privateKey: String(parsed.privateKey) }
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        warnOnce('VAPID 密钥读不出来（' + PUSH_VAPID_FILE_NAME + '），已重新生成')
      }
      return null
    }
  }
  function persist(next) {
    tightenCalls++
    try {
      fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, JSON.stringify({
        version: 1,
        publicKey: next.publicKey,
        privateKey: next.privateKey,
        createdAt: new Date(now()).toISOString(),
      }, null, 2) + '\n', { mode: 0o600 })
      const permission = tightenSecret(file, { platform, env, run, fs })
      if (permission === 'unknown-user' || permission === 'best-effort-failed') {
        warnOnce('VAPID 密钥权限收紧失败（best-effort）：' + PUSH_VAPID_FILE_NAME)
      }
      return true
    } catch (e) {
      warnOnce('VAPID 密钥写不进去（' + PUSH_VAPID_FILE_NAME + '）：' + why(e))
      return false
    }
  }
  return {
    file,
    /** 取密钥；不存在就生成并落盘。生成失败（磁盘只读）时也返回内存里的一对：
     *  本次进程内能发，重启后订阅会失效 —— 比"直接发不出去"好一点。 */
    get() {
      if (keys) return keys
      const loaded = read()
      if (loaded) { keys = loaded; return keys }
      keys = generate()
      persist(keys)
      return keys
    },
    publicKey() { return this.get().publicKey },
    permission() { return platform === 'win32' ? 'icacls:user-only(best-effort)' : 'mode:600' },
    stats() { return { tightenCalls, permission: this.permission() } },
  }
}

/** 订阅存储：`~/.dsh/taskwatch-push.json`（仅当前用户可读）。
 *  每条 `{id, deviceId, endpoint, keys:{p256dh,auth}, origin, uaShort, createdAt, lastOkAt}`。
 *  deviceId 是设备账本里的 12 位摘要（twd cookie 派生），不是 cookie 原值。 */
export function createPushStore({
  file,
  fs = { readFileSync, writeFileSync, mkdirSync, chmodSync },
  platform = process.platform,
  env = process.env,
  run = spawnSync,
  logger = console,
  newId = randomUUID,
  now = Date.now,
  maxTotal = PUSH_MAX_TOTAL,
  maxPerDevice = PUSH_MAX_PER_DEVICE,
} = {}) {
  let state = null
  let warned = false
  let tightenCalls = 0
  const warnOnce = (msg) => {
    if (warned) return
    warned = true
    try { if (logger && typeof logger.error === 'function') logger.error('dsh-in-hand: ' + msg) } catch { /* 日志失败不影响主链路 */ }
  }
  const view = (s, deviceId) => ({
    id: s.id,
    // 只有掩码：完整 endpoint 绝不进任何响应。
    masked: maskPushEndpoint(s.endpoint),
    origin: s.origin,
    uaShort: s.uaShort,
    createdAt: s.createdAt,
    lastOkAt: s.lastOkAt,
    mine: Boolean(deviceId) && s.deviceId === deviceId,
  })

  function parse(raw) {
    const out = []
    const list = Array.isArray(raw && raw.subscriptions) ? raw.subscriptions : []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const deviceId = asText(item.deviceId)
      if (!deviceId) continue
      const endpoint = validatePushEndpoint(item.endpoint)
      if (!endpoint.ok) continue
      const keys = validatePushKeys(item.keys)
      if (!keys.ok) continue
      const origin = validatePushOrigin(item.origin)
      if (!origin.ok) continue
      out.push({
        id: asText(item.id) || newId(),
        deviceId: deviceId.slice(0, 64),
        endpoint: endpoint.endpoint,
        keys: keys.keys,
        origin: origin.origin,
        uaShort: asText(item.uaShort).slice(0, 40) || '浏览器',
        createdAt: Number(item.createdAt) || now(),
        lastOkAt: Number(item.lastOkAt) || null,
      })
      if (out.length >= maxTotal) break
    }
    return out
  }

  function load() {
    if (state) return state
    let subscriptions = []
    try {
      subscriptions = parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        warnOnce('系统通知订阅读不出来（' + PUSH_FILE_NAME + '），按没有订阅处理')
      }
    }
    state = { subscriptions }
    return state
  }

  function persist(next) {
    tightenCalls++
    try {
      fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, JSON.stringify({
        version: 1,
        subscriptions: next.subscriptions.map((s) => ({
          id: s.id,
          deviceId: s.deviceId,
          endpoint: s.endpoint,
          keys: { p256dh: s.keys.p256dh, auth: s.keys.auth },
          origin: s.origin,
          uaShort: s.uaShort,
          createdAt: s.createdAt,
          lastOkAt: s.lastOkAt,
        })),
      }, null, 2) + '\n', { mode: 0o600 })
      const permission = tightenSecret(file, { platform, env, run, fs })
      if (permission === 'unknown-user' || permission === 'best-effort-failed') {
        warnOnce('系统通知订阅权限收紧失败（best-effort）：' + PUSH_FILE_NAME)
      }
      state = next
      return true
    } catch (e) {
      warnOnce('系统通知订阅写不进去（' + PUSH_FILE_NAME + '）：' + why(e))
      return false
    }
  }

  const clone = () => ({ subscriptions: load().subscriptions.map((s) => ({ ...s, keys: { ...s.keys } })) })
  const countsOf = (list) => ({
    total: list.length,
    devices: new Set(list.map((s) => s.deviceId)).size,
  })

  return {
    file,
    load,
    /** 页面能看到的唯一形态：掩码，没有 endpoint / keys。 */
    list(deviceId = '') {
      const list = load().subscriptions
      return list.map((s) => view(s, asText(deviceId)))
    },
    /** 发送用的内部形态（含 raw endpoint 与 keys）。只在宿主侧调用。 */
    targets() {
      return load().subscriptions.map((s) => ({
        id: s.id, deviceId: s.deviceId, endpoint: s.endpoint,
        keys: { ...s.keys }, origin: s.origin,
      }))
    },
    counts() { return countsOf(load().subscriptions) },
    countsFor(deviceId) {
      const all = countsOf(load().subscriptions)
      return { ...all, mine: load().subscriptions.filter((s) => s.deviceId === asText(deviceId)).length }
    },
    add(input) {
      const deviceId = asText(input && input.deviceId).slice(0, 64)
      if (!deviceId) return { ok: false, error: '缺少设备身份，请重新配对' }
      const endpoint = validatePushEndpoint(input && input.endpoint)
      if (!endpoint.ok) return { ok: false, error: endpoint.error }
      const keys = validatePushKeys(input && input.keys)
      if (!keys.ok) return { ok: false, error: keys.error }
      const origin = validatePushOrigin(input && input.origin)
      if (!origin.ok) return { ok: false, error: origin.error }
      const next = clone()
      const dup = next.subscriptions.find((s) => s.deviceId === deviceId && s.endpoint === endpoint.endpoint)
      const uaShort = shortPushUa(input && input.ua)
      if (dup) {
        // 同一台设备重新订阅同一个 endpoint：只刷新密钥 / 名称，不新增一条。
        dup.keys = keys.keys
        dup.origin = origin.origin
        dup.uaShort = uaShort
        if (!persist(next)) return { ok: false, error: '保存失败（检查 ' + PUSH_FILE_NAME + ' 的权限）' }
        return { ok: true, existed: true, id: dup.id, masked: maskPushEndpoint(dup.endpoint) }
      }
      const mine = next.subscriptions.filter((s) => s.deviceId === deviceId)
      if (mine.length >= maxPerDevice) {
        return { ok: false, error: '这台设备最多 ' + maxPerDevice + ' 个订阅，先关掉一个' }
      }
      if (next.subscriptions.length >= maxTotal) {
        return { ok: false, error: '最多 ' + maxTotal + ' 个订阅，先关掉一台设备' }
      }
      const item = {
        id: newId(),
        deviceId,
        endpoint: endpoint.endpoint,
        keys: keys.keys,
        origin: origin.origin,
        uaShort,
        createdAt: now(),
        lastOkAt: null,
      }
      next.subscriptions.push(item)
      if (!persist(next)) return { ok: false, error: '保存失败（检查 ' + PUSH_FILE_NAME + ' 的权限）' }
      return { ok: true, existed: false, id: item.id, masked: maskPushEndpoint(item.endpoint) }
    },
    /** 只能删自己设备的订阅；id 对不上这台设备时按"没有"处理。 */
    remove(id, deviceId) {
      const key = asText(id)
      const dev = asText(deviceId)
      const next = clone()
      const before = next.subscriptions.length
      next.subscriptions = next.subscriptions.filter((s) => !(s.id === key && s.deviceId === dev))
      if (next.subscriptions.length === before) return { ok: false, error: '没有这个订阅（可能已被关闭）' }
      if (!persist(next)) return { ok: false, error: '保存失败（检查 ' + PUSH_FILE_NAME + ' 的权限）' }
      return { ok: true }
    },
    /** 关掉这台设备的全部订阅（页面上的「关闭此设备」）。 */
    removeAllFor(deviceId) {
      const dev = asText(deviceId)
      const next = clone()
      const before = next.subscriptions.length
      next.subscriptions = next.subscriptions.filter((s) => s.deviceId !== dev)
      const removed = before - next.subscriptions.length
      if (!removed) return { ok: true, removed: 0 }
      if (!persist(next)) return { ok: false, error: '保存失败（检查 ' + PUSH_FILE_NAME + ' 的权限）' }
      return { ok: true, removed }
    },
    /** 推送服务说 404 / 410：直接删，不看设备归属（订阅已经不存在了）。 */
    drop(id) {
      const key = asText(id)
      const next = clone()
      const before = next.subscriptions.length
      next.subscriptions = next.subscriptions.filter((s) => s.id !== key)
      if (next.subscriptions.length === before) return { ok: false, error: '没有这个订阅' }
      return persist(next) ? { ok: true } : { ok: false, error: '保存失败' }
    },
    markOk(id, at = now()) {
      const next = clone()
      const hit = next.subscriptions.find((s) => s.id === asText(id))
      if (!hit) return false
      hit.lastOkAt = at
      return persist(next)
    },
    permission() { return platform === 'win32' ? 'icacls:user-only(best-effort)' : 'mode:600' },
    stats() { return { tightenCalls, permission: this.permission() } },
  }
}

/** 固定的失败文案。**绝不**拼接 e.message：undici 的 TypeError 里带完整 endpoint，
 *  拼一次就等于把"只出掩码"这条闸拆了。 */
function pushFailure(e, timeoutMs) {
  const name = e && e.name ? String(e.name) : ''
  const message = String((e && e.message) || '')
  if (name === 'TimeoutError' || name === 'AbortError' || /abort|timeout/i.test(message)) {
    return '超时（' + Math.round(timeoutMs / 1000) + ' 秒）'
  }
  return '网络不通或订阅地址不可达'
}

/** 一条推送的 HTTP 形状（RFC 8030 + 8291 + 8292）：
 *    POST <endpoint>
 *    Authorization: vapid t=<jwt>,k=<公钥>
 *    TTL: 300
 *    Content-Encoding: aes128gcm
 *    Content-Type: application/octet-stream
 *  正文就是 encryptWebPush() 的输出。不重试：404/410 删订阅，其余失败留一行审计，
 *  下一件待办自然会再推一次 —— 推送不是账本，不需要"必达"。 */
export function createWebPushSender({
  fetchImpl = globalThis.fetch,
  vapid,
  timeoutMs = PUSH_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('这个 Node 没有 fetch，系统通知发不出去')
  function keysOf() {
    const keys = typeof vapid === 'function' ? vapid() : vapid
    if (!keys || !keys.publicKey || !keys.privateKey) throw new Error('没有 VAPID 密钥')
    return keys
  }
  async function send(target, message) {
    const endpoint = asText(target && target.endpoint)
    const keys = (target && target.keys) || {}
    if (!endpoint) return { ok: false, status: 0, error: '没有订阅地址' }
    let body
    let authorization
    try {
      const vapidKeys = keysOf()
      body = encryptWebPush({
        plaintext: Buffer.from(JSON.stringify(message == null ? {} : message), 'utf8'),
        uaPublicKey: keys.p256dh,
        authSecret: keys.auth,
      }).body
      authorization = vapidAuthorization({
        privateKey: vapidKeys.privateKey,
        publicKey: vapidKeys.publicKey,
        endpoint,
        now: now(),
      })
    } catch {
      return { ok: false, status: 0, error: '加密失败（订阅密钥可能已失效）' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => { try { controller.abort() } catch { /* 已结束 */ } }, Math.max(1, timeoutMs))
    if (timer && typeof timer.unref === 'function') timer.unref()
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization,
          ttl: String(VAPID_TTL),
          'content-encoding': PUSH_CONTENT_ENCODING,
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
          'user-agent': 'dsh-in-hand-webpush',
        },
        body,
        signal: controller.signal,
        // 不跟跳转：推送服务不会 302，跟了反而给了"把这条路由当代理"的口子。
        redirect: 'error',
      })
      const status = response && typeof response.status === 'number' ? response.status : 0
      try { if (response && response.body && typeof response.body.cancel === 'function') await response.body.cancel() } catch { /* 已关闭 */ }
      if (status >= 200 && status < 300) return { ok: true, status }
      return {
        ok: false,
        status,
        error: status ? 'HTTP ' + status : '发送失败',
        gone: PUSH_GONE_STATUS.indexOf(status) >= 0,
      }
    } catch (e) {
      return { ok: false, status: 0, error: pushFailure(e, timeoutMs) }
    } finally {
      clearTimeout(timer)
    }
  }
  return { timeoutMs, send }
}
