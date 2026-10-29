#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 生成 GitHub Release 正文。
 *
 *   node scripts/release-notes.mjs                    # 版本取 package.json
 *   node scripts/release-notes.mjs --version 1.8.13   # 指定版本
 *   node scripts/release-notes.mjs --out notes.md     # 写文件（UTF-8 无 BOM、LF）
 *   node scripts/release-notes.mjs --check            # 只校验，不发正文
 *
 * 取段规则：从 `## v1.8.13 — 标题` 起，到下一个 `## ` 级别标题或文件末尾。
 * `###` 子标题属于该段落，不会被截断；正文原样保留 Markdown 结构，只有首尾空行
 * 会被收掉。代码围栏里的 `## ` 不算标题。
 *
 * `--check` 做两件事：该版本的段落必须存在，且段落标题里的版本号必须等于
 * package.json 的 version。任一不满足退出码 1，并把两边的版本号写进错误信息。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const USAGE = `用法: node scripts/release-notes.mjs [--version <x.y.z>] [--out <file.md>] [--check]

  --version <v>   要生成的版本，默认取 package.json 的 version
  --out <file>    写到文件（UTF-8、无 BOM、LF）；不给则打到 stdout
  --check         校验 CHANGELOG 有该版本段落，且版本号与 package.json 一致
  --changelog <f> 读另一份 CHANGELOG（测试用），默认仓库根的 CHANGELOG.md
  -h, --help      显示这段文字`

function die(message) {
  console.error(`release-notes: ${message}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// ── 参数 ───────────────────────────────────────────────────────────────────
const opts = { version: '', out: '', check: false, changelog: '', help: false }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const value = () => {
    const next = argv[++i]
    if (next === undefined || next.startsWith('--')) die(`${arg} 需要一个值`)
    return next
  }
  if (arg === '--version' || arg === '-v') opts.version = value().replace(/^v/, '')
  else if (arg === '--out' || arg === '-o') opts.out = value()
  else if (arg === '--changelog') opts.changelog = value()
  else if (arg === '--check') opts.check = true
  else if (arg === '--help' || arg === '-h') opts.help = true
  else die(`未知参数: ${arg}\n\n${USAGE}`)
}

if (opts.help) {
  console.log(USAGE)
  process.exit(0)
}

const version = opts.version || pkg.version
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  die(`版本号不像语义化版本: ${version}`)
}

// ── 读 CHANGELOG ───────────────────────────────────────────────────────────
const changelogPath = opts.changelog ? resolve(process.cwd(), opts.changelog) : join(ROOT, 'CHANGELOG.md')
if (!existsSync(changelogPath)) die(`找不到 CHANGELOG: ${changelogPath}`)
const text = readFileSync(changelogPath, 'utf8')
  .replace(/^\uFEFF/, '')
  .replace(/\r\n?/g, '\n')

const HEADING = /^##[ \t]+(?:v)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=[ \t]|—|–|-|$)/

/** 扫出所有 `## vX.Y.Z` 标题（跳过代码围栏里的假标题）。 */
function scanHeadings(lines) {
  const headings = []
  let fence = ''
  for (let i = 0; i < lines.length; i++) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (marker) {
      const char = marker[1][0]
      if (!fence) fence = char
      else if (fence === char) fence = ''
      continue
    }
    if (fence) continue
    const match = HEADING.exec(lines[i])
    if (match) headings.push({ index: i, version: match[1], heading: lines[i] })
  }
  return headings
}

function trimBlank(lines) {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end)
}

function findSection(lines, wanted) {
  const headings = scanHeadings(lines)
  const at = headings.findIndex((h) => h.version === wanted)
  if (at === -1) return { section: null, versions: headings.map((h) => h.version) }
  const start = headings[at].index
  const end = at + 1 < headings.length ? headings[at + 1].index : lines.length
  return {
    section: { version: wanted, heading: headings[at].heading, body: trimBlank(lines.slice(start + 1, end)) },
    versions: headings.map((h) => h.version),
  }
}

const lines = text.split('\n')
const found = findSection(lines, version)

if (!found.section) {
  const known = found.versions.slice(0, 6).map((v) => `v${v}`).join(', ') || '（一个都没有）'
  die(`CHANGELOG 里没有 v${version} 的段落。现有版本: ${known}`)
}

// ── 校验模式 ───────────────────────────────────────────────────────────────
if (opts.check) {
  if (found.section.version !== pkg.version) {
    die(
      `版本不一致: CHANGELOG 段落标题是 v${found.section.version}，` +
        `package.json 是 v${pkg.version}`,
    )
  }
  console.log(`PASS  v${version}: CHANGELOG 段落存在，且版本号与 package.json 一致`)
  process.exit(0)
}

// ── 生成正文 ───────────────────────────────────────────────────────────────
function changelogUrl() {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || ''
  const base = repo.replace(/^git\+/, '').replace(/\.git$/, '')
  if (!/^https?:\/\//.test(base)) {
    die('package.json 没有可用的 repository 地址，生成不了 Full changelog 链接')
  }
  return `${base}/blob/main/CHANGELOG.md`
}

const body = found.section.body.join('\n').trimEnd()
const block = [`## ${pkg.name} v${version}`, '']
if (body) block.push(body, '')
block.push(
  '---',
  `Install: \`dsh plugin --profile web add ${pkg.name}\``,
  `Full changelog: ${changelogUrl()}`,
)
const output = block.join('\n') + '\n'

if (opts.out) {
  const outPath = resolve(process.cwd(), opts.out)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, output, 'utf8')
  console.error(`release-notes: 已写入 ${outPath}（${Buffer.byteLength(output)} 字节，UTF-8 无 BOM）`)
} else {
  process.stdout.write(output)
}
