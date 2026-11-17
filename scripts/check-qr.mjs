#!/usr/bin/env node
/**
 * 二维码模块（lib/qr.js + lib/vendor/qrcode.js）的自检。
 *
 * 要证明的不是"能生成一张码"，而是四件互不依赖的事：
 *
 *   1. 对拍：与本机的 node-qrcode（D:\Projects\bd-canvas\node_modules\qrcode）
 *      逐格比较矩阵，证明 vendored 的编码器没有被改坏、版本与分组选择正确；
 *   2. 金标准：两个用例的矩阵压成十六进制写进 fixtures/qr-golden.json，
 *      这条不依赖 node-qrcode，CI 上也能跑，防止以后换库/改几何时矩阵悄悄变了；
 *   3. 结构：定位图形、时序图形、固定暗模块、整数像素几何、静区、确定性，
 *      以及 SVG 的白色静区与"黑格全部画到且只画一次"；
 *   4. 错误路径：非 ASCII / 空串 / 超长 / 非法 ecl / size、margin 越界都必须拒绝。
 *
 * 关于对拍的一个事实：qrcode-generator 用的是**旧版 lost-point 启发式**挑掩码
 * （LEVEL1 按 3×3 邻域逐格计分、LEVEL3 不要求模式两侧各 4 个亮模块），
 * node-qrcode 用的是 ISO 18004 的规范算法，所以两者**自动选出的掩码**在部分输入上不同。
 * 两者产出的都是合法二维码（掩码只是 8 种等价变换之一），因此对拍的做法是：
 * 先比自动掩码下的矩阵；不同则固定到我们选中的版本，逐一试 node-qrcode 的 8 种掩码，
 * 必须**恰好有一种**逐格相同。这样既验证了编码/纠错/格式位/掩码应用，又不会把
 * "掩码偏好不同"误判成 bug。输出里会标出哪些用例连自动掩码都相同。
 *
 * 用法：
 *   node scripts/check-qr.mjs                 # 正常自检
 *   node scripts/check-qr.mjs --write-golden  # 重新生成金标准（本机有 node-qrcode 时先核对再写）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { qrMatrix, qrSvg } from '../lib/qr.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_PATH = join(HERE, 'fixtures', 'qr-golden.json')
// 可用 QRCHECK_NODE_QRCODE 指向别的安装来验证 SKIP 分支（CI 上本来就没有这个包）。
const NODE_QRCODE_PATH = process.env.QRCHECK_NODE_QRCODE || 'D:/Projects/bd-canvas/node_modules/qrcode'
const WRITE_GOLDEN = process.argv.includes('--write-golden')

/** 宿主真实会生成的配对 URL（票据 90 字符 + 局域网 origin），125 字符。 */
const REAL_TICKET_URL = 'http://10.0.51.18:3099/taskwatch?t=v3.1793000000000.ABCDEFGHIJKLMNOPQRSTUV.remote.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}
function section(title) { console.log('\n' + title) }
function attempt(fn) {
  try { return { ok: true, value: fn() } } catch (error) { return { ok: false, error } }
}
function throwsWith(name, fn, pattern) {
  const result = attempt(fn)
  if (result.ok) { failed++; console.log('  FAIL  ' + name + ' — 没有抛错'); return }
  const message = String((result.error && result.error.message) || result.error)
  const ok = result.error instanceof Error && (!pattern || pattern.test(message))
  check(name, ok, message)
}

// ── 矩阵与 SVG 的通用工具 ─────────────────────────────────────────────────
function matrixText(matrix) {
  return matrix.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join('')).join('\n')
}
function firstDiff(aText, bText) {
  const a = aText.split('\n')
  const b = bText.split('\n')
  if (a.length !== b.length) return '行数 ' + a.length + ' vs ' + b.length
  for (let y = 0; y < a.length; y++) {
    if (a[y] === b[y]) continue
    for (let x = 0; x < Math.min(a[y].length, b[y].length); x++) {
      if (a[y][x] !== b[y][x]) return '第 ' + y + ' 行第 ' + x + ' 列'
    }
    return '第 ' + y + ' 行长度不同'
  }
  return ''
}
/** 行优先、MSB 先出、每 8 个模块一字节、行尾补 0，拼成小写十六进制。 */
function packHex(matrix) {
  const perRow = Math.ceil(matrix.size / 8)
  let hex = ''
  for (let y = 0; y < matrix.size; y++) {
    for (let b = 0; b < perRow; b++) {
      let byte = 0
      for (let k = 0; k < 8; k++) {
        const x = b * 8 + k
        byte = (byte << 1) | (x < matrix.size && matrix.modules[y][x] ? 1 : 0)
      }
      hex += byte.toString(16).padStart(2, '0')
    }
  }
  return hex
}
function svgAttr(svg, name) {
  const match = new RegExp('\\b' + name + '="([^"]*)"').exec(svg)
  return match ? match[1] : ''
}
function svgPath(svg) {
  const match = /<path fill="#000000" d="([^"]*)"\/>/.exec(svg)
  if (!match) return null
  const d = match[1]
  const runs = []
  const re = /M(-?\d+) (-?\d+)h(-?\d+)v(-?\d+)h(-?\d+)z/g
  let item = null
  while ((item = re.exec(d)) !== null) {
    runs.push({ x: Number(item[1]), y: Number(item[2]), w: Number(item[3]), h: Number(item[4]) })
  }
  return { d, runs }
}
function finderShapeOk(modules, top, left) {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6
      const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4
      const expected = ring || core
      if (modules[top + dy][left + dx] !== expected) return false
    }
  }
  return true
}

// ── node-qrcode（可选）：字节模式、可固定版本与掩码 ───────────────────────
function loadNodeQrcode() {
  try {
    const require = createRequire(import.meta.url)
    const loaded = require(NODE_QRCODE_PATH)
    return loaded && typeof loaded.create === 'function' ? loaded : null
  } catch {
    return null
  }
}
const NODE_QRCODE = loadNodeQrcode()

/**
 * 用 node-qrcode 生成矩阵。强制 Byte 段：node-qrcode 默认会按内容自动分段
 * （数字/字母数字模式更省容量），那会把"版本选择"也一起换掉，和本模块不可比。
 */
function nodeMatrix(QRCode, text, ecl, { version, maskPattern } = {}) {
  const options = { errorCorrectionLevel: ecl }
  if (version) options.version = version
  if (maskPattern !== undefined) options.maskPattern = maskPattern
  const result = QRCode.create([{ data: text, mode: 'Byte' }], options)
  const size = result.modules.size
  const rows = new Array(size)
  for (let y = 0; y < size; y++) {
    let row = ''
    for (let x = 0; x < size; x++) row += result.modules.data[y * size + x] ? '1' : '0'
    rows[y] = row
  }
  return { version: result.version, size, text: rows.join('\n'), autoMask: result.maskPattern }
}

// ── 对拍用的用例（至少 5 个，覆盖短串 / 真实 / 长 / 边界）────────────────
const CASES = [
  { name: '短串 pair', text: 'pair' },
  { name: '真实票据 URL（125 字符）', text: REAL_TICKET_URL },
  {
    name: 'https 公网 URL 形状',
    text: 'https://taskwatch.example.com/pair?t=v3.1793000000000.ABCDEFGHIJKLMNOPQRSTUV.remote',
  },
  { name: '版本边界 122 字符（v7 上限）', text: 'a'.repeat(122) },
  { name: '版本边界 123 字符（跨到 v8）', text: 'a'.repeat(123) },
  {
    name: '长串 1100 字节（v27）',
    text: 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(31).slice(0, 1100),
  },
  {
    name: '最长串 1200 字节（上限）',
    text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.repeat(20).slice(0, 1200),
  },
]
const GOLDEN_CASES = [
  { name: 'real-ticket-url', text: REAL_TICKET_URL },
  { name: 'short-pair', text: 'pair' },
]

// ═════════════════════════════════════════════════════════════════════════
// 1. 与 node-qrcode 逐格对拍（CI 上没有这个包时整节 SKIP）
// ═════════════════════════════════════════════════════════════════════════
section('[1] 对拍 node-qrcode（字节模式，逐格）')
if (!NODE_QRCODE) {
  console.log('  SKIP  对拍：本机没有 node-qrcode（' + NODE_QRCODE_PATH + '）')
} else {
  let naturalSame = 0
  let exact = 0
  for (const item of CASES) {
    const ours = qrMatrix(item.text, { ecl: 'M' })
    const oursText = matrixText(ours)
    const natural = nodeMatrix(NODE_QRCODE, item.text, 'M')
    if (natural.size !== ours.size) {
      check(item.name + '：版本一致', false,
        '本模块 ' + ours.size + ' 模块（v' + ours.version + '） / node-qrcode ' + natural.size + ' 模块')
      continue
    }
    if (natural.text === oursText) {
      naturalSame++
      exact++
      check(item.name + '：v' + ours.version + ' / ' + ours.size + ' 模块逐格一致（自动掩码同为 ' + natural.autoMask + '）', true)
      continue
    }
    const masks = []
    for (let mask = 0; mask < 8; mask++) {
      const forced = nodeMatrix(NODE_QRCODE, item.text, 'M', { version: ours.version, maskPattern: mask })
      if (forced.size === ours.size && forced.text === oursText) masks.push(mask)
    }
    if (masks.length === 1) {
      exact++
      check(item.name + '：v' + ours.version + ' / ' + ours.size + ' 模块逐格一致（同掩码 ' + masks[0]
        + '；node-qrcode 自动选 ' + natural.autoMask + '，两家掩码评分策略不同，均为合法码）', true)
    } else {
      check(item.name + '：矩阵与 node-qrcode 至少一种掩码一致', false,
        masks.length === 0 ? '8 种掩码都不同，首个差异 ' + firstDiff(oursText, natural.text) : '多种掩码同时相同：' + masks.join(','))
    }
  }
  check('用例数 ≥ 5（当前 ' + CASES.length + '）', CASES.length >= 5)
  check('全部用例逐格一致（' + exact + '/' + CASES.length + '，其中 ' + naturalSame + ' 个连自动掩码都相同）',
    exact === CASES.length)
}

// ═════════════════════════════════════════════════════════════════════════
// 2. 金标准（不依赖 node-qrcode）
// ═════════════════════════════════════════════════════════════════════════
section('[2] 金标准矩阵（fixtures/qr-golden.json）')

function buildGolden() {
  const file = {
    module: 'lib/qr.js',
    ecl: 'M',
    packing: '行优先；每行自左向右、MSB 先出，每 8 个模块打成一字节，行尾不足 8 位补 0；多行按行序拼接后转小写十六进制',
    generatedBy: 'node scripts/check-qr.mjs --write-golden（本机有 node-qrcode 时先逐格核对再写）',
    note: '真实票据 URL 是宿主配对面板的实际输入；short-pair 是 v1 小码，覆盖最小版本。',
    cases: [],
  }
  for (const item of GOLDEN_CASES) {
    const matrix = qrMatrix(item.text, { ecl: 'M' })
    if (NODE_QRCODE) {
      const natural = nodeMatrix(NODE_QRCODE, item.text, 'M')
      let matched = natural.text === matrixText(matrix)
      for (let mask = 0; !matched && mask < 8; mask++) {
        const forced = nodeMatrix(NODE_QRCODE, item.text, 'M', { version: matrix.version, maskPattern: mask })
        if (forced.text === matrixText(matrix)) matched = true
      }
      if (!matched) throw new Error('金标准用例与 node-qrcode 不一致：' + item.name)
    }
    file.cases.push({
      name: item.name,
      text: item.text,
      version: matrix.version,
      size: matrix.size,
      hex: packHex(matrix),
    })
  }
  return file
}

if (WRITE_GOLDEN) {
  const result = attempt(buildGolden)
  if (result.ok) {
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true })
    writeFileSync(GOLDEN_PATH, JSON.stringify(result.value, null, 2) + '\n', 'utf8')
    console.log('  写入 ' + GOLDEN_PATH)
  } else {
    failed++
    console.log('  FAIL  生成金标准 — ' + (result.error && result.error.message))
  }
}

if (!existsSync(GOLDEN_PATH)) {
  check('金标准文件存在', false, GOLDEN_PATH + '（先运行 node scripts/check-qr.mjs --write-golden）')
} else {
  const result = attempt(() => JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')))
  if (!result.ok) {
    check('金标准 JSON 可解析', false, String(result.error && result.error.message))
  } else {
    const golden = result.value
    check('金标准声明 ecl=M 且含 2 个用例',
      golden.ecl === 'M' && Array.isArray(golden.cases) && golden.cases.length === 2,
      JSON.stringify({ ecl: golden.ecl, cases: golden.cases && golden.cases.length }))
    let same = 0
    for (const entry of golden.cases || []) {
      const matrix = qrMatrix(entry.text, { ecl: golden.ecl || 'M' })
      const hex = packHex(matrix)
      const ok = matrix.version === entry.version && matrix.size === entry.size && hex === entry.hex
      if (!ok) {
        check('金标准 ' + entry.name + '（v' + entry.version + ' / ' + entry.size + ' 模块）', false,
          '实际 v' + matrix.version + ' / ' + matrix.size + ' 模块，hex ' + (hex === entry.hex ? '相同' : '不同'))
      } else {
        same++
      }
    }
    check('金标准 2 个矩阵逐字节相同（' + same + '/2）', same === 2)
    const hasReal = (golden.cases || []).some((entry) => entry.text === REAL_TICKET_URL)
    check('金标准里含真实票据 URL', hasReal)
    check('金标准里存了生成方式说明', typeof golden.packing === 'string' && golden.packing.length > 10
      && typeof golden.generatedBy === 'string')
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 3. 结构断言：定位图形 / 时序 / 暗模块 / 几何 / 静区 / 确定性
// ═════════════════════════════════════════════════════════════════════════
section('[3] 结构断言')
{
  const matrix = qrMatrix('pair')
  const count = matrix.size
  check('pair 是整数版本、size = 4*version+17、模块是布尔',
    Number.isInteger(matrix.version) && matrix.version === (count - 17) / 4
      && matrix.modules.length === count && matrix.modules.every((row) => row.length === count
        && row.every((dark) => typeof dark === 'boolean')),
    JSON.stringify({ version: matrix.version, size: count }))

  check('左上定位图形是 7×7 实心回字形', finderShapeOk(matrix.modules, 0, 0))
  check('右上定位图形是 7×7 实心回字形', finderShapeOk(matrix.modules, 0, count - 7))
  check('左下定位图形是 7×7 实心回字形', finderShapeOk(matrix.modules, count - 7, 0))

  let timingOk = true
  for (let i = 8; i <= count - 9; i++) {
    if (matrix.modules[6][i] !== (i % 2 === 0)) timingOk = false
    if (matrix.modules[i][6] !== (i % 2 === 0)) timingOk = false
  }
  check('第 6 行 / 第 6 列时序图形黑白交替（v1，8..' + (count - 9) + '）', timingOk)

  const real = qrMatrix(REAL_TICKET_URL)
  check('v1 固定暗模块 [13][8] 为黑', matrix.modules[4 * matrix.version + 9][8] === true)
  check('v' + real.version + ' 固定暗模块 [' + (4 * real.version + 9) + '][8] 为黑',
    real.modules[4 * real.version + 9][8] === true)

  const text = 'https://pair.example.com/?t=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const sizeOption = 240
  const margin = 4
  const svg = qrSvg(text, { size: sizeOption, margin })
  const base = qrMatrix(text)
  const n = base.size + margin * 2
  const unit = Math.max(1, Math.floor(sizeOption / n))
  const edge = n * unit
  const width = Number(svgAttr(svg, 'width'))
  const height = Number(svgAttr(svg, 'height'))
  const viewBox = svgAttr(svg, 'viewBox')

  check('unit 是正整数', Number.isInteger(unit) && unit >= 1, 'unit=' + unit)
  check('W === (模块数+2*margin)*unit', edge === (base.size + 2 * margin) * unit,
    edge + ' vs ' + (base.size + 2 * margin) * unit)
  check('W <= size 且 size-W < n（取能放下的最大整数倍）',
    edge <= sizeOption && sizeOption - edge < n, 'W=' + edge + ', size=' + sizeOption + ', n=' + n)
  check('width/height/viewBox 都是整数且 1:1（不靠缩放）',
    width === edge && height === edge && viewBox === '0 0 ' + edge + ' ' + edge,
    JSON.stringify({ width, height, viewBox }))
  check('带 shape-rendering="crispEdges"、role="img"',
    svgAttr(svg, 'shape-rendering') === 'crispEdges' && svgAttr(svg, 'role') === 'img')
  check('默认 aria-label 是「二维码」', svgAttr(svg, 'aria-label') === '二维码', svgAttr(svg, 'aria-label'))
  check('自定义 label 写进 aria-label', svgAttr(qrSvg('pair', { label: '扫码配对' }), 'aria-label') === '扫码配对')
  const escaped = qrSvg('pair', { label: 'a"b&c<d>e\'f' })
  check('label 里的 XML 特殊字符被转义', escaped.includes('&quot;') && escaped.includes('&amp;')
    && escaped.includes('&lt;') && escaped.includes('&gt;') && escaped.includes('&apos;'))

  const path = svgPath(svg)
  check('有一条黑色 path', Boolean(path) && path.runs.length > 0)
  if (path) {
    check('path 里没有小数点坐标', !/[0-9]\.[0-9]/.test(path.d), path.d.slice(0, 80))
    const rectFirst = svg.indexOf('<rect width="' + edge + '" height="' + edge + '" fill="#ffffff"/>')
    const pathAt = svg.indexOf('<path fill="#000000"')
    // 静区必须是 SVG 自带的白底：暗色主题下面板背景是深色，靠页面底色会扫不出来。
    check('先画白底 rect、再画黑 path（静区自带白底）', rectFirst >= 0 && pathAt > rectFirst)
    let inside = true
    for (const run of path.runs) {
      if (run.h !== unit || run.w % unit !== 0 || run.x % unit !== 0 || run.y % unit !== 0) inside = false
      if (run.x < margin * unit || run.y < margin * unit) inside = false
      if (run.x + run.w > edge - margin * unit || run.y + run.h > edge - margin * unit) inside = false
    }
    check('静区：所有黑格都落在 margin 之内（四边 ' + margin + ' 模块）', inside)

    const covered = new Set()
    let duplicated = false
    for (const run of path.runs) {
      const row = run.y / unit - margin
      for (let i = 0; i < run.w / unit; i++) {
        const key = row + ':' + (run.x / unit - margin + i)
        if (covered.has(key)) duplicated = true
        covered.add(key)
      }
    }
    let darkCount = 0
    let exactCover = true
    for (let y = 0; y < base.size; y++) {
      for (let x = 0; x < base.size; x++) {
        if (base.modules[y][x]) {
          darkCount++
          if (!covered.has(y + ':' + x)) exactCover = false
        } else if (covered.has(y + ':' + x)) {
          exactCover = false
        }
      }
    }
    check('黑格全部画到且只画一次（' + darkCount + ' 格）',
      exactCover && !duplicated && covered.size === darkCount, 'covered=' + covered.size)
  }

  const a = qrMatrix(REAL_TICKET_URL)
  const b = qrMatrix(REAL_TICKET_URL)
  check('同一输入两次 qrMatrix 完全一致', matrixText(a) === matrixText(b) && a.version === b.version)
  check('同一输入两次 qrSvg 逐字节一致', qrSvg(REAL_TICKET_URL) === qrSvg(REAL_TICKET_URL))
}

// ═════════════════════════════════════════════════════════════════════════
// 4. 真实用例：宿主票据 URL 的版本、模块数、默认实际边长
// ═════════════════════════════════════════════════════════════════════════
section('[4] 真实票据 URL 用例')
{
  const matrix = qrMatrix(REAL_TICKET_URL)
  check('真实 URL 落在 v8（49 模块）', matrix.version === 8 && matrix.size === 49,
    'v' + matrix.version + ' / ' + matrix.size)
  const svg = qrSvg(REAL_TICKET_URL)
  const n = matrix.size + 8
  const unit = Math.max(1, Math.floor(240 / n))
  check('默认 size=240 时实际边长 ' + n * unit + 'px（' + n + ' × ' + unit + '）',
    Number(svgAttr(svg, 'width')) === n * unit && unit === 4, 'width=' + svgAttr(svg, 'width') + ', unit=' + unit)
  check('默认尺寸下 unit >= 2（1px/模块等于不可扫）', unit >= 2, 'unit=' + unit)
}

// ═════════════════════════════════════════════════════════════════════════
// 5. 错误路径
// ═════════════════════════════════════════════════════════════════════════
section('[5] 错误路径')
{
  throwsWith('非 ASCII 内容抛 TypeError 且消息明确', () => qrMatrix('扫码配对'), /只支持 ASCII/)
  throwsWith('非 ASCII 内容在 qrSvg 里也拒绝', () => qrSvg('café'))
  throwsWith('空串拒绝', () => qrMatrix(''))
  throwsWith('超过 1200 字节拒绝', () => qrMatrix('A'.repeat(1201)))
  throwsWith('非字符串内容拒绝', () => qrMatrix(42))
  throwsWith('非法 ecl "X" 拒绝', () => qrMatrix('ok', { ecl: 'X' }))
  throwsWith('小写 ecl "m" 拒绝（只收大写）', () => qrMatrix('ok', { ecl: 'm' }))
  throwsWith('空 ecl 拒绝', () => qrSvg('ok', { ecl: '' }))
  throwsWith('size 小于 64 拒绝', () => qrSvg('ok', { size: 63 }))
  throwsWith('size 大于 1024 拒绝', () => qrSvg('ok', { size: 1025 }))
  throwsWith('size 非整数拒绝', () => qrSvg('ok', { size: 240.5 }))
  throwsWith('size 是字符串拒绝', () => qrSvg('ok', { size: '240' }))
  throwsWith('margin 为负拒绝', () => qrSvg('ok', { margin: -1 }))
  throwsWith('margin 大于 8 拒绝', () => qrSvg('ok', { margin: 9 }))
  throwsWith('margin 非整数拒绝', () => qrSvg('ok', { margin: 1.5 }))

  const ok64 = attempt(() => qrSvg('ok', { size: 64 }))
  check('size 下界 64 合法', ok64.ok)
  const ok1024 = attempt(() => qrSvg('ok', { size: 1024 }))
  check('size 上界 1024 合法', ok1024.ok)
  const ok0 = attempt(() => qrSvg('ok', { margin: 0 }))
  check('margin 下界 0 合法（无静区也允许调用方自己加）', ok0.ok)
  const ok8 = attempt(() => qrSvg('ok', { margin: 8 }))
  check('margin 上界 8 合法', ok8.ok)
  const exact = attempt(() => qrMatrix('A'.repeat(1200)))
  check('恰好 1200 字节合法', exact.ok && exact.value.size >= 21)
  const eclVersions = {}
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    const result = attempt(() => qrMatrix(REAL_TICKET_URL, { ecl }))
    if (result.ok) eclVersions[ecl] = result.value.version
    check('ecl ' + ecl + ' 可用（真实 URL）', result.ok && result.value.size === (result.value.version * 4 + 17))
  }
  check('纠错级别越高版本越大（L ≤ M ≤ Q ≤ H）',
    eclVersions.L <= eclVersions.M && eclVersions.M <= eclVersions.Q && eclVersions.Q <= eclVersions.H,
    JSON.stringify(eclVersions))
}

console.log(`\n二维码模块：${passed} 通过 / ${failed} 失败`)
if (failed) process.exitCode = 1
