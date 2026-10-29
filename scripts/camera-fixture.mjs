/**
 * 相机直发自检用的图片夹具（v1.8.9）。
 *
 * 不引第三方图像库：源图用真 Chrome 的 canvas 现画（3000×2000 的「报错截图」），
 * 再按需手工插入一段 EXIF APP1 把 Orientation 写成 6 —— 竖拍照片在手机里就是这个
 * 样子：**像素是横的，靠 EXIF 告诉浏览器要转 90°**。压缩实现如果忽略方向，
 * 上传出去的图就是横躺的；这组夹具就是为了把这件事变成可断言的。
 *
 * 另外提供 SOF 解析：上传体是真正的 JPEG 字节，宽高只能从它里面读，不能信页面
 * 自己报的数字。
 */

/** 在页面里画一张 3000×2000 的“报错屏”，返回 JPEG Buffer。 */
export async function makeJpeg(evalJs, opts = {}) {
  const width = opts.width || 3000
  const height = opts.height || 2000
  const code = opts.code || '0x80070005'
  const dataUrl = await evalJs(`(function () {
    var c = document.createElement('canvas')
    c.width = ${width}; c.height = ${height}
    var g = c.getContext('2d')
    var grd = g.createLinearGradient(0, 0, ${width}, ${height})
    grd.addColorStop(0, '#f3f4f6'); grd.addColorStop(1, '#dfe3ea')
    g.fillStyle = grd; g.fillRect(0, 0, ${width}, ${height})
    g.fillStyle = '#ffffff'; g.fillRect(160, 220, ${width} - 320, ${height} - 440)
    g.strokeStyle = '#c9ced6'; g.lineWidth = 6; g.strokeRect(160, 220, ${width} - 320, ${height} - 440)
    g.fillStyle = '#111827'; g.font = 'bold 150px sans-serif'
    g.fillText('Recycle Bin 无法访问', 300, 520)
    g.fillStyle = '#4b5563'; g.font = '64px sans-serif'
    g.fillText('此项目已被移动或删除。', 300, 700)
    g.fillText('是否要永久删除此文件？', 300, 800)
    g.fillStyle = '#c0392b'; g.font = 'bold 210px monospace'
    g.fillText(${JSON.stringify(code)}, 300, 1200)
    g.fillStyle = '#9ca3af'; g.font = '52px sans-serif'
    g.fillText('确定    取消', ${width} - 700, ${height} - 330)
    return c.toDataURL('image/jpeg', 0.94)
  })()`)
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
  if (!m) throw new Error('canvas 没吐出 JPEG：' + String(dataUrl).slice(0, 80))
  return Buffer.from(m[1], 'base64')
}

/**
 * 在 SOI 之后插一段 EXIF APP1，只放一个 IFD0 条目：Orientation。
 * 不依赖 EXIF 库，字节布局按 TIFF 规范手写（大端）。
 */
export function withExifOrientation(jpeg, orientation) {
  const tiff = Buffer.alloc(26) // header 8 + IFD 条目 2+12+4
  tiff.write('MM', 0, 'ascii') // 大端
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4) // IFD0 偏移
  tiff.writeUInt16BE(1, 8) // 一个条目
  tiff.writeUInt16BE(0x0112, 10) // Tag: Orientation
  tiff.writeUInt16BE(3, 12) // Type: SHORT
  tiff.writeUInt32BE(1, 14) // Count
  tiff.writeUInt16BE(orientation & 0xffff, 18)
  tiff.writeUInt32BE(0, 22) // 没有 IFD1
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff])
  const head = Buffer.alloc(4)
  head[0] = 0xff
  head[1] = 0xe1 // APP1
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), head, payload, jpeg.subarray(2)])
}

/** 从 JPEG 字节里读 SOF 的宽高（压缩后的真实输出尺寸）。 */
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i + 9 <= buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker === 0xff) { i++; continue }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    if (marker === 0xd9) return null
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), marker }
    }
    i += 2 + len
  }
  return null
}
