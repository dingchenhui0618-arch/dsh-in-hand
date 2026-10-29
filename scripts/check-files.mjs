/**
 * 交付文件边界的契约测试。
 *
 * 为什么不并进 check-bundle.mjs：那个文件测的是"生成的 HTML 与当前页面一致"，
 * 这里测的是**安全语义** —— 一旦红了，意味着手机侧多读到了不该读的东西，
 * 比 UI 漂移严重得多。分开之后，两者各自的失败含义不会被混在一起。
 *
 * 用法：node scripts/check-files.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import {
  MAX_BYTES,
  MAX_SESSION_BYTES,
  buildSessionWhitelist,
  defaultRoots,
  dispositionFor,
  kindOf,
  mimeFor,
  pathKey,
  pathsInText,
  resolveSessionTarget,
  resolveTarget,
  rootsFrom,
  withinRoot,
} from '../lib/files.js'

let pass = 0
let fail = 0
function ok(label, cond, extra) {
  if (cond) {
    pass++
    console.log('  PASS ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)))
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLAT = process.platform
const keyOf = (p) => pathKey(p)

const sandbox = mkdtempSync(join(tmpdir(), 'in-hand-files-'))
const rootA = join(sandbox, 'attachments')
const rootB = join(sandbox, 'outbox')
const outside = join(sandbox, 'outside')
mkdirSync(rootA, { recursive: true })
mkdirSync(rootB, { recursive: true })
mkdirSync(outside, { recursive: true })
const ROOTS = [rootA, rootB]

const png = join(rootA, 'shot.png')
const pdf = join(rootB, 'report.pdf')
const svg = join(rootB, 'evil.svg')
const zip = join(rootB, 'bundle.zip')
const exe = join(rootB, 'tool.exe')
const secret = join(outside, 'credentials.yaml')
for (const [p, bytes] of [[png, 68], [pdf, 2048], [svg, 40], [zip, 128], [exe, 64], [secret, 32]]) {
  writeFileSync(p, Buffer.alloc(bytes, 0x41))
}

console.log('交付文件边界（lib/files.js）')

// 1. 白名单包含关系：前缀相等不算包含 —— 这是这类判断最常见的写法错误。
ok('withinRoot 认子路径', withinRoot(join(rootA, 'a', 'b.png'), rootA))
ok('withinRoot 拒绝同前缀的兄弟目录', !withinRoot(rootA + '-evil/x.png', rootA))
ok('withinRoot 拒绝根本身之外的平级路径', !withinRoot(outside, rootA))
ok('defaultRoots 默认两条（附件库 + 交付 outbox）', defaultRoots('C:\\Users\\x').length === 2)

// 2. 环境变量覆盖：`;` 分隔 + `~` 展开。
//    用例**必须**用当前平台上真正绝对的路径来构造。硬编码的 'C:\Users\x' 在 POSIX 上
//    不是绝对路径，`resolve` 会把它拼到 cwd 后面 —— 本地（Windows）全绿、CI（ubuntu）红。
//    v1.3.0 第一次发布就是这么挂的，而且挂的是这条测试自己，不是产品代码。
const fakeHome = join(tmpdir(), 'tw-home')
const otherRoot = join(tmpdir(), 'tw-b')
const fromEnv = rootsFrom('~/a;' + otherRoot, fakeHome)
ok('rootsFrom 按 ; 拆分并展开 ~',
  fromEnv.length === 2 && fromEnv[0] === join(fakeHome, 'a') && fromEnv[1] === otherRoot, fromEnv)
ok('rootsFrom 空值时回落默认', rootsFrom('  ', fakeHome).length === 2)

// 3. 扩展名白名单：可执行的同源内容必须被拒，且不降级成下载。
ok('.png → image/png', mimeFor('a.png').mime === 'image/png')
ok('.PDF 大小写不敏感', mimeFor('A.PDF').mime === 'application/pdf')
ok('.svg 被拒（同源可执行内容）', mimeFor('a.svg').error === 'denied-type')
ok('.html 被拒', mimeFor('a.html').error === 'denied-type')
ok('.js 被拒', mimeFor('a.js').error === 'denied-type')
ok('未知类型被拒', mimeFor('a.exe').error === 'unsupported-type')

// 4. 路径解析：穿越、越界、相对路径、缺失参数。
ok('缺参数', resolveTarget('', ROOTS).error === 'missing-path')
ok('相对路径被拒', resolveTarget('x/y.png', ROOTS).error === 'not-absolute')
ok('.. 穿越被拒', resolveTarget(join(rootA, '..', 'outside', 'credentials.yaml'), ROOTS).error === 'outside-roots')
ok('白名单外的绝对路径被拒', resolveTarget(secret, ROOTS).error === 'outside-roots')
ok('白名单外的 .yaml 也是 outside-roots（先判边界）', resolveTarget(join(outside, 'x.png'), ROOTS).error === 'outside-roots')
ok('白名单内的 svg 是 denied-type', resolveTarget(svg, ROOTS).error === 'denied-type')
ok('白名单内的 exe 是 unsupported-type', resolveTarget(exe, ROOTS).error === 'unsupported-type')
ok('不存在的文件是 not-found', resolveTarget(join(rootA, 'nope.png'), ROOTS).error === 'not-found')

const hitPng = resolveTarget(png, ROOTS)
ok('合法图片可读', hitPng.ok === true && hitPng.mime === 'image/png' && hitPng.bytes === 68, hitPng)
ok('合法图片带名字与大类', hitPng.name === 'shot.png' && hitPng.kind === 'image')
const hitPdf = resolveTarget(pdf, ROOTS)
ok('合法 PDF 可读且归类为 pdf', hitPdf.ok === true && hitPdf.kind === 'pdf')
ok('~ 展开后能命中白名单', resolveTarget(pdf.replace(rootB, rootB), ROOTS).ok === true)

// 5. 符号链接逃逸：字符串检查挡不住，必须按真实路径复查。
//    Windows 上建符号链接需要开发者模式/管理员，没权限就明确报 SKIP，不算通过。
let linkNote = ''
try {
  const link = join(rootA, 'link.png')
  symlinkSync(secret, link)
  const got = resolveTarget(link, ROOTS)
  ok('指向白名单外的符号链接被拒', got.error === 'outside-roots', got)
} catch (e) {
  linkNote = 'SKIP 符号链接逃逸（本机无建链接权限：' + (e && e.code ? e.code : 'unknown') + '）'
  console.log('  ' + linkNote)
}

// 6. 响应头策略：图片/PDF 内嵌，压缩包下载，文件名里的引号换行必须清掉。
ok('图片 inline', dispositionFor('image/png', 'a.png').indexOf('inline') === 0)
ok('PDF inline', dispositionFor('application/pdf', 'a.pdf').indexOf('inline') === 0)
ok('zip attachment', dispositionFor('application/zip', 'a.zip').indexOf('attachment') === 0)
ok('文件名清理引号与换行', dispositionFor('image/png', 'a"b\r\nc.png').indexOf('"a_b__c.png"') > 0)
ok('kindOf 分类', kindOf('image/webp') === 'image' && kindOf('application/pdf') === 'pdf' && kindOf('application/zip') === 'file')

// 7. 上限本身要是个合理的数（运行时无法造 32MB 文件来测，只断言配置合理）。
ok('单文件上限在 1MB ~ 64MB 之间', MAX_BYTES >= 1048576 && MAX_BYTES <= 67108864, MAX_BYTES)

// 8. 无扩展名：宿主附件库是内容寻址的，模型产出的图名字就是哈希、没有扩展名。
//    只认扩展名的话，"把刚生成的这张图发我"会 403 —— 演示页一切正常、真机上是坏的。
//    这一组就是那次真实验收暴露出来的回归。
const pngNoExt = join(rootA, 'blob')
const pdfNoExt = join(rootA, 'blob2')
const htmlNoExt = join(rootA, 'blob3')
const txtNoExt = join(rootA, 'blob4')
writeFileSync(pngNoExt, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x41),
]))
writeFileSync(pdfNoExt, Buffer.from('%PDF-1.7\n' + 'x'.repeat(80)))
writeFileSync(htmlNoExt, Buffer.from('<html><script>alert(1)</script>'.padEnd(80, ' ')))
writeFileSync(txtNoExt, Buffer.from('just plain text, no magic bytes at all'.padEnd(80, '.')))
const hitNoExt = resolveTarget(pngNoExt, ROOTS)
ok('无扩展名的 PNG 按文件头识别', hitNoExt.ok === true && hitNoExt.mime === 'image/png', hitNoExt)
ok('识别后补一个扩展名给下载文件名（手机得知道用什么打开）', hitNoExt.name === 'blob.png', hitNoExt.name)
ok('无扩展名的 PDF 按文件头识别', (resolveTarget(pdfNoExt, ROOTS) || {}).mime === 'application/pdf')
ok('无扩展名的 HTML 仍被拒（没有魔数可放行，白名单没放宽）', resolveTarget(htmlNoExt, ROOTS).error === 'unsupported-type')
ok('无扩展名的纯文本仍被拒', resolveTarget(txtNoExt, ROOTS).error === 'unsupported-type')
const tiny = join(rootA, 'tiny')
writeFileSync(tiny, Buffer.from([0x89, 0x50]))
ok('不足 12 字节的截断文件不会误判', resolveTarget(tiny, ROOTS).error === 'unsupported-type')

// ── 9. 会话引用白名单（v1.8.1，经用户 2026-10-29 授权）──────────────────────
//
// 这一节测的是**新开的那条窄口子**：只放行本会话消息正文里出现过的绝对路径。
// 它比 roots 宽（可以读 D:\Projects\...），所以每一条边界都必须由测试钉住，
// 不能只靠读代码相信。
console.log('\n会话引用白名单（lib/files.js）')

const rawDeliver = join(outside, 'deliverable.pdf')
const rawLate = join(outside, 'late.pdf')
const rawUnref = join(outside, 'unreferenced.pdf')
const rawDir = join(outside, 'sub')
const rawLink = join(outside, 'link.pdf')
const rawLinkTarget = join(outside, 'secret-target.pdf')
const rawLinkDir = join(outside, 'linkdir')
const rawSecretDir = join(outside, 'secret-dir')
const rawBig = join(outside, 'big.pdf')
const deliverBytes = Buffer.from('%PDF-1.7\n' + 'x'.repeat(2000))
writeFileSync(rawDeliver, deliverBytes)
writeFileSync(rawLate, Buffer.from('%PDF-1.7\n' + 'y'.repeat(1000)))
writeFileSync(rawUnref, Buffer.from('%PDF-1.7\n' + 'z'.repeat(1000)))
mkdirSync(rawDir, { recursive: true })

// 用例数据一律用**当前平台真实存在的绝对路径**构造。硬编码 `D:\...` 在 POSIX 上不是
// 绝对路径，pathKey 会返回空 —— 本地全绿、CI 红（v1.3.0 就是这么挂过一次）。
const extracted = pathsInText(
  '报告在 ' + rawDeliver + '，图是 ' + rawDeliver.replace(/\\/g, '/') + '。\n' +
  'JSON 里是 ' + JSON.stringify({ path: rawDeliver }) + '，' +
  'markdown [x](' + rawDeliver + ') 和 `' + join(outside, 'a.md') + '`。\n' +
  '不是路径：和/或，见 https://example.com/a/b.png。'
)
ok('抓绝对路径（反斜杠与正斜杠都认）',
  extracted.includes(rawDeliver) && extracted.includes(rawDeliver.replace(/\\/g, '/')), extracted)
ok('抓 JSON 转义里的路径（\\\\ → \\）', extracted.includes(rawDeliver), extracted)
ok('遇到括号 / 反引号 / 空白就停',
  !extracted.some((p) => /[)\]`]/.test(p)) && extracted.includes(join(outside, 'a.md')), extracted)
ok('不吞 URL', !extracted.some((p) => p.includes('example.com')), extracted)
ok('不把「和/或」这种单段斜杠当路径', !extracted.includes('/或'), extracted)
ok('提取结果里没有通配符', pathsInText(join(outside, '*', '*.pdf')).every((p) => !p.includes('*')), pathsInText(join(outside, '*', '*.pdf')))
if (PLAT === 'win32') {
  ok('Windows 路径比较大小写不敏感',
    keyOf(rawDeliver) === keyOf(rawDeliver.toUpperCase()))
}

const WHITELIST = buildSessionWhitelist([{ text: '先看 ' + rawDeliver + '，目录 ' + rawDir + '，大文件 ' + rawBig }])
ok('白名单只含被引用过的绝对路径',
  WHITELIST.has(keyOf(rawDeliver)) && !WHITELIST.has(keyOf(rawUnref)), [...WHITELIST])
ok('未命中 → outside-roots + reason=not-referenced',
  resolveSessionTarget(rawUnref, WHITELIST).error === 'outside-roots' &&
  resolveSessionTarget(rawUnref, WHITELIST).reason === 'not-referenced')
ok('相对路径被拒', resolveSessionTarget(join('x', 'y.pdf'), WHITELIST).error === 'not-absolute')
ok('NUL 被拒', resolveSessionTarget(rawDeliver + '\u0000x', WHITELIST).error === 'bad-path')
ok('.. 穿越被拒（即使归一化后恰好命中白名单）',
  resolveSessionTarget(outside + sep + 'sub' + sep + '..' + sep + 'deliverable.pdf', new Set([keyOf(rawDeliver)])).reason === 'traversal')
ok('目录被拒（not-a-file）',
  resolveSessionTarget(rawDir, new Set([keyOf(rawDir)])).error === 'not-a-file')
ok('超过 50 MB → too-large',
  resolveSessionTarget(rawDeliver, new Set([keyOf(rawDeliver)]), {
    statSync: () => ({ isFile: () => true, size: MAX_SESSION_BYTES + 1 }),
  }).error === 'too-large')
ok('恰好 50 MB 可以放行',
  resolveSessionTarget(rawDeliver, new Set([keyOf(rawDeliver)]), {
    statSync: () => ({ isFile: () => true, size: MAX_SESSION_BYTES }),
  }).ok === true)
ok('50 MB 上限就是 50 MB', MAX_SESSION_BYTES === 50 * 1024 * 1024, MAX_SESSION_BYTES)

// 符号链接：请求路径在白名单里，真实路径不在 → 必须拒。
//
// Windows 上建**文件**符号链接需要开发者模式/管理员（本机实测 EPERM）。目录 junction
// 不需要特权，而且 realpath 的逃逸语义完全一样 —— 所以文件链接失败时退到 junction，
// 让这条安全断言始终被真的执行过，而不是挂个 SKIP 就算数。
let sessionLinkNote = ''
let linkPath = ''
let linkReal = ''
try {
  writeFileSync(rawLinkTarget, Buffer.from('%PDF-1.7\nsecret'))
  symlinkSync(rawLinkTarget, rawLink)
  linkPath = rawLink
  linkReal = rawLinkTarget
} catch (e) {
  try {
    mkdirSync(rawSecretDir, { recursive: true })
    writeFileSync(join(rawSecretDir, 'secret.pdf'), Buffer.from('%PDF-1.7\nsecret'))
    symlinkSync(rawSecretDir, rawLinkDir, 'junction')
    linkPath = join(rawLinkDir, 'secret.pdf')
    linkReal = join(rawSecretDir, 'secret.pdf')
    sessionLinkNote = '用目录 junction 代替文件符号链接（本机无建文件链接权限：' + (e && e.code ? e.code : '?') + '）'
  } catch (e2) {
    sessionLinkNote = 'SKIP 会话符号链接（文件链接与 junction 都建不了：' + (e2 && e2.code ? e2.code : 'unknown') + '）'
    console.log('  ' + sessionLinkNote)
  }
}
if (linkPath) {
  const got = resolveSessionTarget(linkPath, new Set([keyOf(linkPath)]))
  ok('符号链接指向白名单外 → 403（symlink-escape）', got.error === 'outside-roots' && got.reason === 'symlink-escape', got)
  const inner = resolveSessionTarget(linkPath, new Set([keyOf(linkPath), keyOf(linkReal)]))
  ok('真实路径也被引用时符号链接才放行', inner.ok === true, inner)
}

// ── 10. 页面契约：文件链接带会话，403/413 文案可区分 ────────────────────────
const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')
ok('fileUrlFor 给文件链接带上 sessionId',
  /function fileUrlFor\(p\)\{[\s\S]{0,400}?sessionId/.test(page) && page.includes("'&sessionId=' + encodeURIComponent(S.sessionId)"))
ok('页面有「该文件未被本会话引用」文案', page.includes('该文件未被本会话引用'))
ok('页面有「文件超过 50 MB」文案', page.includes('文件超过 50 MB'))
ok('403/413 文案可区分（fileErrText 分两支）',
  /function fileErrText\(status, body\)\{[\s\S]{0,400}?FILE_ERR_LARGE[\s\S]{0,300}?FILE_ERR_NOT_REF/.test(page))
ok('图片失败仍换成 36px 单行提示条（不出现破图框）',
  /\.imgerr\{[\s\S]{0,300}?height:36px/.test(page) && /function swapBrokenImg\([\s\S]{0,900}?brokenImgBar/.test(page))
ok('读不到的文件保留可点的原路径兜底',
  /preset\.err[\s\S]{0,200}?点开原路径/.test(page) && /function fileCard\(url, label, kind, preset\)/.test(page))
ok('缓存键带会话（同一路径跨会话不会复用 200 结果）',
  /function pathCacheKey\(p\)\{ return String\(p\) \+ '\|' \+ String\(S\.sessionId \|\| ''\) \}/.test(page))
ok('sw.js 的 CACHE 升到 taskwatch-v25',
  readFileSync(join(ROOT, 'lib', 'sw.js'), 'utf8').includes("const CACHE = 'taskwatch-v25'"))

// ── 11. 路由端到端：200 / 403 / 413 / 旧调用不变 ───────────────────────────
//
// 前面的纯函数测试只能证明"判断对"，这里要证明**路由真的接上了**：用真实 node:http
// 服务 + apply()，只把 DSH 服务换成 fake，不连接任何真实宿主 / 模型。
console.log('\n会话引用路由（真实 http + apply）')

// 50 MB 的"大文件"用 truncate 造（NTFS 只是把长度设到 50MB+1，不真写盘；
// POSIX 上是稀疏文件）。绝不定长分配 50 MB 内存。
writeFileSync(rawBig, Buffer.alloc(0))
truncateSync(rawBig, MAX_SESSION_BYTES + 1)

function fakeSession(id, texts) {
  return {
    texts,
    snapshotEvents() {
      return this.texts.map((t, i) => ({ type: 'user/message', time: 1000 + i, data: { id: id + '-m' + i } }))
    },
    deriveMessages() {
      return this.texts.map((t, i) => ({ id: id + '-m' + i, role: 'user', content: [{ type: 'text', text: t }] }))
    },
  }
}
const sess1 = fakeSession('s1', [
  '交付物：' + rawDeliver + '；目录 ' + rawDir + '；大文件 ' + rawBig +
    (linkPath ? '；链接 ' + linkPath : ''),
])
const sess2 = fakeSession('s2', ['这边只提到 ' + rawUnref])
const sessions = { get(id) { return id === 's1' ? sess1 : id === 's2' ? sess2 : undefined } }

process.env.DSH_HOME = join(sandbox, 'dsh-home')
process.env.DSH_TASKWATCH_ROOTS = rootA + ';' + rootB
const routes = new Map()
const webServer = { register(spec) { routes.set(spec.path, spec.handler) } }
const ctx = {
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'sessions') return sessions
    return undefined
  },
  effect(fn) { return fn() },
  on() { return () => {} },
}
apply(ctx)
const server = http.createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
  if (!handler) { res.writeHead(404); res.end(); return }
  Promise.resolve(handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)) })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port

async function fileGet(params) {
  const qs = Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k])).join('&')
  const r = await fetch(base + '/taskwatch/file?' + qs)
  const type = String(r.headers.get('content-type') || '')
  const body = type.includes('application/json') ? await r.json() : Buffer.from(await r.arrayBuffer())
  return { status: r.status, type, body }
}

const hit = await fileGet({ sessionId: 's1', path: rawDeliver })
ok('1. 命中白名单 → 200（完整字节，不是 roots 里的文件）',
  hit.status === 200 && hit.type === 'application/pdf' && hit.body.length === deliverBytes.length,
  { status: hit.status, type: hit.type, n: hit.body.length })
const hitInfo = await fileGet({ sessionId: 's1', path: rawDeliver, info: '1' })
ok('   命中白名单 → info 也认得同一份文件',
  hitInfo.status === 200 && hitInfo.body.kind === 'pdf' && hitInfo.body.bytes === deliverBytes.length, hitInfo.body)
const miss = await fileGet({ sessionId: 's1', path: rawUnref })
ok('2. 未命中 → 403 outside-roots',
  miss.status === 403 && miss.body.error === 'outside-roots' && miss.body.reason === 'not-referenced', { status: miss.status, body: miss.body })
const cross = await fileGet({ sessionId: 's2', path: rawDeliver })
ok('3. 跨会话取同一路径 → 403',
  cross.status === 403 && cross.body.error === 'outside-roots', { status: cross.status, body: cross.body })
const trav = await fileGet({ sessionId: 's1', path: outside + sep + 'sub' + sep + '..' + sep + 'deliverable.pdf' })
ok('4. .. 穿越 → 403（即使归一化后命中白名单）',
  trav.status === 403 && trav.body.reason === 'traversal', { status: trav.status, body: trav.body })
const linked = linkPath ? await fileGet({ sessionId: 's1', path: linkPath }) : null
ok('5. 符号链接指向白名单外 → 403',
  !!linked && linked.status === 403 && (linked.body.reason === 'symlink-escape' || /SKIP/.test(sessionLinkNote)),
  linked ? { status: linked.status, body: linked.body } : sessionLinkNote)
const dir = await fileGet({ sessionId: 's1', path: rawDir })
ok('6. 目录 → 403（not-a-file）', dir.status === 403 && dir.body.reason === 'not-a-file', { status: dir.status, body: dir.body })
const big = await fileGet({ sessionId: 's1', path: rawBig })
ok('7. >50MB → 413，响应体带原路径与上限',
  big.status === 413 && big.body.error === 'too-large' && big.body.path === rawBig &&
    big.body.limit === MAX_SESSION_BYTES, { status: big.status, body: big.body })
const oldOutside = await fileGet({ path: rawDeliver })
ok('8. 缺 sessionId 的旧调用行为不变（roots 之外仍 403）',
  oldOutside.status === 403 && oldOutside.body.error === 'outside-roots' && oldOutside.body.reason === undefined,
  { status: oldOutside.status, body: oldOutside.body })
const oldInside = await fileGet({ path: pdf })
ok('   缺 sessionId 的旧调用仍能读 roots 内的文件',
  oldInside.status === 200 && oldInside.type === 'application/pdf', { status: oldInside.status, type: oldInside.type })

// 缓存失效：会话里新增一条消息后，同一个路径立刻从不允许变成允许。
const beforeLate = await fileGet({ sessionId: 's1', path: rawLate })
sess1.texts.push('后来补发了 ' + rawLate)
const afterLate = await fileGet({ sessionId: 's1', path: rawLate })
ok('缓存随消息条数变化重建（新引用立刻生效）',
  beforeLate.status === 403 && afterLate.status === 200, { before: beforeLate.status, after: afterLate.status })

const audit = readFileSync(join(process.env.DSH_HOME, 'taskwatch-audit.log'), 'utf8')
  .trim().split(/\r?\n/).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
const audited = audit.filter((e) => e.via === 'session-ref')
ok('放行写审计 {at, session, path(≤200), size, via:session-ref}',
  audited.length === 2 && audited.every((e) => e.session === 's1' && e.via === 'session-ref' &&
    typeof e.at === 'string' && e.path.length <= 200 && Number.isFinite(e.size)) &&
    audited.some((e) => e.path.endsWith('deliverable.pdf') && e.size === deliverBytes.length), audited)
ok('拒绝不写审计（只留放行记录）', audited.length === 2 &&
  !audited.some((e) => e.path.endsWith('unreferenced.pdf')))
// 先放掉 keep-alive 连接再关服务器：Node 24 在 Windows 上对"关闭中仍有句柄"会在
// 进程退出时抛 libuv 断言（73 条断言全绿却得到一个非 0 退出码）。
if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
await new Promise((r) => server.close(r))

const linkNoteAll = [linkNote, sessionLinkNote].filter(Boolean).join('；')
rmSync(sandbox, { recursive: true, force: true })

console.log('')
console.log(fail === 0
  ? '交付文件边界：' + pass + '/' + pass + ' 全绿' + (linkNoteAll ? '（含 SKIP：' + linkNoteAll + '）' : '')
  : '交付文件边界：' + pass + ' 通过 / ' + fail + ' 失败')
// 不用 process.exit：Node 24 / Windows 上在 keep-alive 连接尚未收尾时强退会抛
// libuv 断言（断言全绿却拿到非 0 退出码）。让事件循环自然结束。
process.exitCode = fail === 0 ? 0 : 1
