/**
 * 配对面板用的二维码：把任意 ASCII 文本编码成矩阵或一段可直接内嵌的 SVG。
 *
 * 为什么用 vendored 的 qrcode-generator 而不是自己写或加依赖：
 *   - 本包承诺零运行时依赖（package.json 没有 dependencies），不能为一张码引入 30 多个传递依赖；
 *   - qrcode-generator 单文件、无 import、MIT，算法是完整 QR 规范实现（分组、RS 纠错、掩码），
 *     比手写字节模式要可靠得多；
 *   - 只把它的输出当"黑盒矩阵"用，几何与 SVG 由本文件负责，升级时整文件替换 vendor 即可。
 *
 * 为什么 SVG 坚持整数像素几何：
 *   手机上扫码时，浏览器如果按 viewBox 把非整数模块宽高缩放到 CSS 尺寸，模块边缘会落在半像素上，
 *   被抗锯齿抹成灰边，识别率明显下降。这里让每个模块恰好占 unit 个整数像素，
 *   并且 width/height 与 viewBox 尺寸完全相等（1:1，不发生任何缩放），
 *   再配 shape-rendering="crispEdges" 关掉边缘平滑，模块边界才是干净的黑白。
 *   代价是最终边长未必等于请求的 size（取能放下的最大整数倍），这一点由调用方知悉。
 */
import qrcode from './vendor/qrcode.js'

/** 单条内容上限：1200 字节（ECL M 下约版本 29，远低于版本 40 的容量，留足余量）。 */
const MAX_BYTES = 1200
/** 纠错级别白名单。M 是二维码的常规选择：约 15% 冗余，尺寸与容错平衡。 */
const ECL_LEVELS = new Set(['L', 'M', 'Q', 'H'])
/** 像素目标范围。太小扫不出，太大对面板没有意义，还会撑爆 DOM。 */
const SIZE_MIN = 64
const SIZE_MAX = 1024
/** 静区（quiet zone）上限：规范建议 4 个模块，8 个已经很宽松。 */
const MARGIN_MAX = 8

function fail(message) {
  throw new TypeError(message)
}

function assertContent(text) {
  if (typeof text !== 'string') fail('二维码内容必须是字符串')
  if (text.length === 0) fail('二维码内容不能为空')
  // qrcode-generator 的 stringToBytes 只取 charCodeAt 的低 8 位，
  // 非 ASCII 会被静默截断成另一个字节序列，扫出来是乱码，所以在这里先拦住。
  if (/[^\x00-\x7F]/.test(text)) fail('二维码内容只支持 ASCII')
  if (text.length > MAX_BYTES) fail('二维码内容超过 ' + MAX_BYTES + ' 字节')
}

function assertEcl(ecl) {
  if (!ECL_LEVELS.has(ecl)) fail('纠错级别只支持 L / M / Q / H')
}

function assertIntegerOption(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(name + ' 必须是 ' + min + '..' + max + ' 的整数')
  }
}

/**
 * 把文本编码成模块矩阵。
 *
 * 固定使用字节模式（Byte）：调用方给的是 URL 与 token，字符集不受数字/大写字母限制，
 * 数字/字母模式虽然更省容量，但对这种混合文本用不上，反而让版本选择更难预测。
 * 版本传 0 让库自己挑"能装下这段数据的最小版本"，避免版本写死导致短内容也画成大码。
 *
 * @param {string} text ASCII 文本
 * @param {{ecl?: 'L'|'M'|'Q'|'H'}} [options]
 * @returns {{version: number, size: number, modules: boolean[][]}} size 为模块数（不含静区）
 */
export function qrMatrix(text, { ecl = 'M' } = {}) {
  assertContent(text)
  assertEcl(ecl)

  const qr = qrcode(0, ecl)
  qr.addData(text, 'Byte')
  qr.make()

  const size = qr.getModuleCount()
  const modules = new Array(size)
  for (let y = 0; y < size; y += 1) {
    const row = new Array(size)
    for (let x = 0; x < size; x += 1) row[x] = qr.isDark(y, x) === true
    modules[y] = row
  }
  return { version: (size - 17) / 4, size, modules }
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;'
    if (ch === '<') return '&lt;'
    if (ch === '>') return '&gt;'
    if (ch === '"') return '&quot;'
    return '&apos;'
  })
}

/**
 * 生成一段自包含的二维码 SVG（不含 XML 声明，可直接内联进 HTML）。
 *
 * 几何：n = 模块数 + 2*margin，unit = max(1, floor(size / n))，边长 W = n * unit。
 * 也就是"在 size 像素预算内放下最大的整数像素/模块"，允许 W < size（默认 240 时实际 228），
 * 但绝不允许靠浏览器缩放补足——那正是扫不出来糊的原因。
 *
 * 输出只由入参决定：没有时间戳、没有随机 id，同样输入逐字节相同，便于缓存与快照测试。
 *
 * @param {string} text ASCII 文本
 * @param {{size?: number, margin?: number, ecl?: 'L'|'M'|'Q'|'H', label?: string}} [options]
 * @returns {string} SVG 字符串
 */
export function qrSvg(text, { size = 240, margin = 4, ecl = 'M', label = '' } = {}) {
  assertIntegerOption('size', size, SIZE_MIN, SIZE_MAX)
  assertIntegerOption('margin', margin, 0, MARGIN_MAX)

  const { size: count, modules } = qrMatrix(text, { ecl })
  const n = count + margin * 2
  const unit = Math.max(1, Math.floor(size / n))
  const edge = n * unit
  const ariaLabel = label ? String(label) : '二维码'

  // 每一行里连续的黑模块合并成一条相对路径：M x y h w v unit h -w z。
  // 全部是整数，路径数据里不出现小数点；行内合并后节点数从 size² 降到"黑段数"。
  let path = ''
  for (let y = 0; y < count; y += 1) {
    let runStart = -1
    for (let x = 0; x <= count; x += 1) {
      const dark = x < count && modules[y][x] === true
      if (dark) {
        if (runStart < 0) runStart = x
      } else if (runStart >= 0) {
        const width = (x - runStart) * unit
        path += 'M' + (margin + runStart) * unit + ' ' + (margin + y) * unit
          + 'h' + width + 'v' + unit + 'h-' + width + 'z'
        runStart = -1
      }
    }
  }

  // 先铺满白底再画黑模块：静区必须是白（或透明），否则暗色主题下扫码会因
  // "黑模块贴着深色背景"失去对比度。这里用实心白 rect，不依赖页面背景色。
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + edge + '" height="' + edge
    + '" viewBox="0 0 ' + edge + ' ' + edge + '" shape-rendering="crispEdges"'
    + ' role="img" aria-label="' + escapeXml(ariaLabel) + '">'
    + '<rect width="' + edge + '" height="' + edge + '" fill="#ffffff"/>'
    + '<path fill="#000000" d="' + path + '"/>'
    + '</svg>'
}
