/**
 * 读 Chrome 的 DevToolsActivePort。
 *
 * Windows runner 上，Chrome 刚写完这个文件时还可能持有写锁：文件存在，
 * 但 readFileSync 会抛 EBUSY。存在 != 可读，所以这里把「暂时读不到」
 * 归一成 null，让调用方的 waitPort 循环继续等，而不是把环境竞态当失败。
 *
 * 返回第一行端口字符串；文件为空或暂时锁着返回 null；其它错误照常抛。
 */
import { readFileSync } from 'node:fs'

export function readDevToolsPort(file) {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'ENOENT') return null
    throw e
  }
  return raw.split(/\r?\n/).filter(Boolean)[0] || null
}
