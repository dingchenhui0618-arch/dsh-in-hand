/**
 * 交付文件解析 —— 把「手机页要显示的图片 / PDF / 文本」映射成一个**受限的**本地读操作。
 *
 * 为什么单独成模块，而不是写进路由闭包里：
 * 白名单与目录穿越防护是这个功能真正的安全边界。放在闭包里，契约测试就只能靠读代码
 * 相信它；抽成纯函数之后，测试可以直接断言 `../../.credentials.yaml` 会被拒。
 *
 * 边界（四条，缺一条这个功能就不该上线）：
 *   1. 只服务白名单根目录之下的文件 —— 默认只有宿主附件库与交付 outbox；
 *   2. 解析后必须**再按真实路径（realpath）复查一次** —— 字符串检查挡不住根目录里的符号链接；
 *   3. 类型判定走扩展名白名单，`.svg` / `.html` / `.js` 一律拒绝 —— 它们与本页面同源，
 *      一旦内联就是可执行内容（存储型 XSS），而"看图看 PDF"根本不需要它们；
 *   4. 没有扩展名时按**文件头魔数**判类型（见 sniffMime）。
 *
 * 第 4 条是 2026-10-09 补的，起因是一次真实验收：
 * 宿主附件库是内容寻址的，模型产出的图落在 `~/.dsh/attachments/v1/objects/<hash>`，
 * **名字就是哈希、没有扩展名**。只认扩展名的话，最真实的那个场景
 * （"把刚生成的这张图发我"）会 403 退化成一段文字 —— 演示页一切正常，真机上是坏的。
 * 注意这是"按内容识别"，不是"按内容放行"：html / svg / js 没有魔数，仍然走不通。
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'

/** 可服务的类型。每条都写明用途，避免以后有人"顺手"往里加。 */
const MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.csv', 'text/plain; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.zip', 'application/zip'],
])

/** 显式拒绝：与页面同源的可执行内容。命中就报 denied-type，不做任何降级。 */
const DENIED = new Set(['.svg', '.svgz', '.html', '.htm', '.xhtml', '.js', '.mjs', '.cjs', '.css', '.xml'])

/** 单文件上限。手机流量 + 内存都要有数，超了直接 413，不偷偷截断。 */
export const MAX_BYTES = 32 * 1024 * 1024

/** 会话引用白名单的单文件上限（v1.8.1）。比 roots 的 32 MB 宽一点：PDF 常比图大，
 *  但 50 MB 仍然是「偶尔看一份交付物」的量级，不是拿手机下整段素材。 */
export const MAX_SESSION_BYTES = 50 * 1024 * 1024

/** 审计里路径最多留多少个字符。够认出是哪个文件，又不至于把整条命令行搬进日志。 */
export const SESSION_PATH_MAX = 200

/** 默认白名单：宿主附件库（用户上传 / 模型读过的图）与交付 outbox（模型产出的文件）。 */
export function defaultRoots(home) {
  const h = home || homedir()
  return [join(h, '.dsh', 'attachments'), join(h, '.dsh', 'outbox')]
}

/** `~` 展开。只认开头的 `~` / `~/` / `~\`，中间出现的 `~` 是普通字符。 */
export function expandHome(input, home) {
  const h = home || homedir()
  const p = String(input == null ? '' : input)
  if (p === '~') return h
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(h, p.slice(2))
  return p
}

/** 环境变量覆盖（`;` 分隔）。没配就回默认两条。 */
export function rootsFrom(value, home) {
  if (typeof value === 'string' && value.trim()) {
    const out = []
    for (const part of value.split(';')) {
      const p = part.trim()
      if (!p) continue
      out.push(resolve(expandHome(p, home)))
    }
    if (out.length) return out
  }
  return defaultRoots(home)
}

/** 严格包含判断：`/a/bc` 不算在 `/a/b` 之下（前缀检查最容易在这里写错）。 */
export function withinRoot(abs, root) {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root
  return abs === r || abs.startsWith(r + sep)
}

/** 扩展名 → 类型。返回 { ok, mime, ext } 或 { ok:false, error, ext }。 */
export function mimeFor(abs) {
  const ext = extname(String(abs)).toLowerCase()
  if (DENIED.has(ext)) return { ok: false, error: 'denied-type', ext }
  const mime = MIME.get(ext)
  if (!mime) return { ok: false, error: 'unsupported-type', ext }
  return { ok: true, mime, ext }
}

/**
 * 文件头魔数 → 类型。只给**没有扩展名**的文件用（见文件头注释第 4 条）。
 *
 * 只认有明确魔数的类型。html / svg / js / 纯文本没有魔数，所以它们在这条路上
 * 仍然被拒 —— 白名单没有被放宽，只是从"看名字"补成"看内容"。
 * 返回里带 ext，是为了给响应头一个像样的下载文件名（`<hash>` 没有扩展名，
 * 手机拿到会不知道用什么打开）。
 */
export function sniffMime(abs) {
  let head
  try {
    const fd = openSync(abs, 'r')
    try {
      const buf = Buffer.alloc(16)
      const n = readSync(fd, buf, 0, 16, 0)
      head = buf.subarray(0, n).toString('hex')
    } finally {
      closeSync(fd)
    }
  } catch {
    return { ok: false, error: 'not-found', ext: '' }
  }
  if (head.length < 12) return { ok: false, error: 'unsupported-type', ext: '' }
  if (head.startsWith('89504e47')) return { ok: true, mime: 'image/png', ext: '.png' }
  if (head.startsWith('ffd8ff')) return { ok: true, mime: 'image/jpeg', ext: '.jpg' }
  if (head.startsWith('47494638')) return { ok: true, mime: 'image/gif', ext: '.gif' }
  if (head.startsWith('25504446')) return { ok: true, mime: 'application/pdf', ext: '.pdf' }
  if (head.startsWith('504b0304')) return { ok: true, mime: 'application/zip', ext: '.zip' }
  if (head.startsWith('52494646') && head.slice(16, 24) === '57454250') return { ok: true, mime: 'image/webp', ext: '.webp' }
  if (head.slice(8, 16) === '66747970') return { ok: true, mime: 'video/mp4', ext: '.mp4' }
  return { ok: false, error: 'unsupported-type', ext: '' }
}

/** 大类：页面靠它决定"铺大图"还是"给一张卡片"。 */
export function kindOf(mime) {
  const m = String(mime || '')
  if (m.startsWith('image/')) return 'image'
  if (m === 'application/pdf') return 'pdf'
  if (m.startsWith('text/') || m === 'application/json; charset=utf-8') return 'text'
  if (m.startsWith('video/')) return 'video'
  return 'file'
}

/** 图片 / PDF / 文本直接内嵌，其余作为附件下载。 */
export function dispositionFor(mime, name) {
  const kind = kindOf(mime)
  const safe = String(name || 'file').replace(/["\\\r\n]/g, '_')
  return (kind === 'file' ? 'attachment' : 'inline') + '; filename="' + safe + '"'
}

/**
 * 把请求里的 path 解析成一个可读的绝对路径。
 * 返回 { ok:true, abs, mime, bytes, name, kind } 或 { ok:false, error }。
 * 不抛异常 —— 拒绝理由要原样回给调用方（也回给测试）。
 *
 * 顺序是有讲究的：先判白名单边界（不碰磁盘）→ 再判类型 → 再 realpath 复查 → 最后看大小。
 * 边界判断必须发生在任何"读这个文件"的动作之前，否则越界路径会先被打开一次。
 */
export function resolveTarget(input, roots, home) {
  const h = home || homedir()
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'missing-path' }
  const raw = expandHome(input.trim(), h)
  if (!isAbsolute(raw)) return { ok: false, error: 'not-absolute' }
  const abs = resolve(raw)
  const list = (Array.isArray(roots) && roots.length ? roots : defaultRoots(h)).map((r) => resolve(expandHome(r, h)))
  if (!list.some((r) => withinRoot(abs, r))) return { ok: false, error: 'outside-roots' }

  let types = mimeFor(abs)
  let sniffed = false
  if (!types.ok && types.error === 'unsupported-type') {
    // 没有扩展名（宿主附件库内容寻址，名字就是哈希）→ 按文件头判。
    types = sniffMime(abs)
    sniffed = true
  }
  if (!types.ok) return { ok: false, error: types.error, ext: types.ext }

  let real
  try {
    real = realpathSync(abs)
  } catch {
    return { ok: false, error: 'not-found' }
  }
  // 复查真实路径：根目录里存在指向外部的符号链接时，上面的字符串检查会放行。
  if (!list.some((r) => withinRoot(real, r))) return { ok: false, error: 'outside-roots' }

  let st
  try {
    st = statSync(real)
  } catch {
    return { ok: false, error: 'not-found' }
  }
  if (!st.isFile()) return { ok: false, error: 'not-a-file' }
  if (st.size > MAX_BYTES) return { ok: false, error: 'too-large', bytes: st.size }

  const base = basename(real)
  const name = sniffed && types.ext && !base.toLowerCase().endsWith(types.ext) ? base + types.ext : base
  return { ok: true, abs: real, mime: types.mime, bytes: st.size, name, kind: kindOf(types.mime) }
}

/** 给页面文件卡片用的元数据（不读字节）。 */
export function infoOf(hit) {
  return { name: hit.name, bytes: hit.bytes, mime: hit.mime, kind: hit.kind }
}

// ── 会话引用白名单（v1.8.1，经用户 2026-10-29 授权）──────────────────────────
//
// 要解决的问题：远端（手机）看不到本机产出的 PDF / 图片。宿主文件路由过去只服务
// `~/.dsh/attachments` 与 `~/.dsh/outbox`，`D:\Projects\...` 一律 403 outside-roots。
// 用户批准的是**一条窄口子**：只放行「这个会话的消息正文里真正出现过的绝对路径」。
//
// 四条边界缺一不可，测试逐条钉住：
//   1. 只认盘符路径（`C:\...`）与以 `/` 开头的 POSIX 路径 —— 不做 `~` 展开、不做通配；
//   2. 先 `resolve` 规范化再比，Windows 下大小写不敏感；含 `..` 的请求直接拒；
//   3. `realpath` 与请求路径不一致（符号链接）时，真实路径也必须在白名单里；
//   4. realpath 之后必须是普通文件（拒目录 / 设备 / 断链），且 ≤ 50 MB。
//
// 注意：这里只做**路径级**判断，类型白名单仍走 mimeFor / sniffMime —— `.svg` /
// `.html` / `.js` 与本页同源，即使被引用过也不能内联（存储型 XSS），这条不放宽。

/**
 * 抓绝对路径的正则。
 *
 * 保守到「宁可漏、不可错」：只认盘符路径或 `/` 开头；遇到空白、引号、括号、方括号、
 * 花括号、尖括号、反引号、竖线、星号、问号与中文标点就停 —— 这些字符要么不可能出现在
 * 文件名里，要么是我们不想误吞的 markdown / 正文标点。**不做**通配、不做目录推断。
 *
 * 盘符前面不许紧挨字母：`https:` 的 `s:` 长得像盘符，不加这条会把整条 URL 抓进来。
 */
const SESSION_PATH_RE = /(?<![A-Za-z0-9_])(?:[A-Za-z]:[\\/]|\/)[^\s"'`()\[\]{}<>|*?，。；：！？、]+/g

/** 从一段文本里抓出所有像绝对路径的串（已做 JSON 转义还原与尾部标点清理）。 */
export function pathsInText(text) {
  const out = []
  if (typeof text !== 'string' || !text) return out
  SESSION_PATH_RE.lastIndex = 0
  let m
  while ((m = SESSION_PATH_RE.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 3), m.index)
    // `https://…` 里的 `/` 也像 POSIX 路径；紧跟在 `:/` 后面的一律不是本地文件。
    if (before.endsWith(':/') || m[0].indexOf('://') >= 0) continue
    let raw = m[0]
    // JSON 里路径是 `D:\\Projects\\a.pdf`；先按 JSON 的 \\ 还原成单个反斜杠。
    // 只折叠反斜杠对，不碰 \n / \t 这些转义 —— 路径里不会出现它们。
    raw = raw.replace(/\\\\/g, '\\')
    // 句子结尾的英文标点不属于文件名（`D:\a\b.pdf.` → `D:\a\b.pdf`）。
    raw = raw.replace(/[.,;:!?]+$/, '')
    if (raw.length < 4) continue
    // POSIX 至少两段：否则正文里的「和/或」会被当成 `/或`。
    if (raw.charAt(0) === '/' && !/^\/[^/]+\//.test(raw)) continue
    out.push(raw)
  }
  return out
}

/** 规范化成比较用的 key：`~` 不展开（白名单只认绝对路径）、`..` 归一、Windows 小写。 */
export function pathKey(input, home, platform = process.platform) {
  if (typeof input !== 'string') return ''
  const p = input.trim()
  if (!p || p.indexOf('\u0000') >= 0) return ''
  if (!isAbsolute(p)) return ''
  const abs = resolve(p)
  return platform === 'win32' ? abs.toLowerCase() : abs
}

/** 会话消息 → 路径集合。只读 `text`（页面里能看见的那部分），不看工具参数。 */
export function buildSessionWhitelist(messages, home, platform = process.platform) {
  const set = new Set()
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue
    for (const p of pathsInText(m.text)) {
      const key = pathKey(p, home, platform)
      if (key) set.add(key)
    }
  }
  return set
}

/**
 * 会话引用分支的路径校验。返回 `{ ok:true, abs, mime, bytes, name, kind }`
 * 或 `{ ok:false, error, reason?, bytes?, ext? }`。
 *
 * 拒绝时 `error` 保持与旧行为一致（`outside-roots`），`reason` 只说清是哪一条边界：
 * `not-referenced` / `traversal` / `symlink-escape` / `not-a-file`。页面据此决定
 * 提示文案，但对外契约仍是 403。
 */
export function resolveSessionTarget(input, allowed, opts = {}) {
  const {
    home = homedir(),
    platform = process.platform,
    limit = MAX_SESSION_BYTES,
    statSync: stat = statSync,
    realpathSync: realpath = realpathSync,
  } = opts
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'missing-path' }
  if (input.indexOf('\u0000') >= 0) return { ok: false, error: 'bad-path' }
  const text = input.trim()
  // `..` 直接在字符串层拒掉：即使归一化后恰好落回白名单，也不接受穿越写法。
  if (/(^|[\\/])\.\.([\\/]|$)/.test(text)) return { ok: false, error: 'outside-roots', reason: 'traversal' }
  const raw = expandHome(text, home)
  if (!isAbsolute(raw)) return { ok: false, error: 'not-absolute' }
  const abs = resolve(raw)
  const key = platform === 'win32' ? abs.toLowerCase() : abs
  const has = allowed && typeof allowed.has === 'function' ? (k) => allowed.has(k) : () => false
  if (!has(key)) return { ok: false, error: 'outside-roots', reason: 'not-referenced' }

  let real
  try {
    real = realpath(abs)
  } catch {
    // 断链 / 不存在：`realpath` 会抛，这里统一按 not-found（路由映射成 403）。
    return { ok: false, error: 'not-found' }
  }
  let st
  try {
    st = stat(real)
  } catch {
    return { ok: false, error: 'not-found' }
  }
  if (!st.isFile()) return { ok: false, error: 'not-a-file', reason: 'not-a-file' }
  // 符号链接：请求路径在白名单里不代表它指向的地方也在。真实路径必须自己也被引用过。
  const realKey = platform === 'win32' ? real.toLowerCase() : real
  if (realKey !== key && !has(realKey)) return { ok: false, error: 'outside-roots', reason: 'symlink-escape' }
  if (st.size > limit) return { ok: false, error: 'too-large', bytes: st.size }

  // 类型仍走原白名单（含魔数识别）；.svg / .html / .js 不放宽。
  let types = mimeFor(real)
  let sniffed = false
  if (!types.ok && types.error === 'unsupported-type') {
    types = sniffMime(real)
    sniffed = true
  }
  if (!types.ok) return { ok: false, error: types.error, ext: types.ext }

  const base = basename(real)
  const name = sniffed && types.ext && !base.toLowerCase().endsWith(types.ext) ? base + types.ext : base
  return { ok: true, abs: real, mime: types.mime, bytes: st.size, name, kind: kindOf(types.mime) }
}
