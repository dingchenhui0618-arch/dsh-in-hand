#!/usr/bin/env node
/**
 * 给「打了 tag 但没有 GitHub Release」的版本补建 Release。
 *
 *   node scripts/publish-releases.mjs                    # 默认 dry-run：只列清单，什么都不写
 *   node scripts/publish-releases.mjs --from 1.8.0 --to 1.8.13
 *   node scripts/publish-releases.mjs --from 1.8.0 --to 1.8.13 --apply --yes
 *
 * 三道防误发：
 *   1. 默认 dry-run：只读 `git tag` 与 `gh release list`，不调用任何 gh 写操作；
 *   2. 必须显式 `--apply` 才会 `gh release create`；
 *   3. `--apply` 还必须带 `--yes`，且 stdin 与 stdout 都是交互终端；缺一条就打印
 *      提示后退出（退出码 3），不创建任何 Release——防止被 CI 或别的脚本误触发。
 *
 * 幂等：已有 Release 的 tag 跳过并说明；区间 `--from/--to` 含端点，按语义化版本
 * 比较（不是字符串比较）。正文由 `scripts/release-notes.mjs` 生成到临时目录，
 * 用完即删，这里不重复它的取段逻辑。
 *
 * 每行一个 tag：create / skip(已存在) / missing(无 CHANGELOG 段落)，最后一行汇总。
 * 任一条 missing：dry-run 退出码 2；--apply 直接中止，一个 Release 都不创建。
 *
 * 环境变量（测试与自定义安装位置用，正常发版不需要）：
 *   PUBLISH_RELEASES_GH=<path>      gh 可执行文件，默认 PATH 里的 `gh`；
 *                                   指向 .cmd/.bat 时经 cmd.exe 调用（Windows shim）。
 *   PUBLISH_RELEASES_ASSUME_TTY=1   仅测试：把非终端环境当作交互终端，绕过第 3 道闸。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RELEASE_NOTES = join(HERE, 'release-notes.mjs')
const GH = process.env.PUBLISH_RELEASES_GH || 'gh'

const EXIT_MISSING = 2
const EXIT_REFUSED = 3

const USAGE = `用法: node scripts/publish-releases.mjs [--from <x.y.z>] [--to <x.y.z>] [--apply] [--yes]

  --from <v>       区间起点（含），默认仓库里最旧的 tag
  --to <v>         区间终点（含），默认仓库里最新的 tag
  --apply          真正执行 gh release create（默认只读）
  --yes            --apply 的确认开关，且必须在交互终端里运行
  --changelog <f>  读另一份 CHANGELOG（测试用），默认仓库根的 CHANGELOG.md
  -h, --help       显示这段文字`

function die(message, code = 1) {
  console.error(`publish-releases: ${message}`)
  process.exit(code)
}

// ── 参数 ───────────────────────────────────────────────────────────────────
const opts = { from: '', to: '', apply: false, yes: false, changelog: '', help: false }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const value = () => {
    const next = argv[++i]
    if (next === undefined || next.startsWith('--')) die(`${arg} 需要一个值`)
    return next
  }
  if (arg === '--from') opts.from = value().replace(/^v/, '')
  else if (arg === '--to') opts.to = value().replace(/^v/, '')
  else if (arg === '--apply') opts.apply = true
  else if (arg === '--yes') opts.yes = true
  else if (arg === '--changelog') opts.changelog = value()
  else if (arg === '--help' || arg === '-h') opts.help = true
  else die(`未知参数: ${arg}\n\n${USAGE}`)
}

if (opts.help) {
  console.log(USAGE)
  process.exit(0)
}

// ── 第 3 道闸：--apply 需要 --yes 且必须交互终端 ───────────────────────────
function interactive() {
  if (process.env.PUBLISH_RELEASES_ASSUME_TTY === '1') return true
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

if (opts.apply && !opts.yes) {
  console.error('publish-releases: 拒绝执行 —— --apply 必须同时带 --yes。没有创建任何 Release。')
  process.exit(EXIT_REFUSED)
}
if (opts.apply && !interactive()) {
  console.error(
    'publish-releases: 拒绝执行 —— --apply 必须在交互终端里运行（stdin/stdout 都不是 TTY，' +
      '像是被脚本或 CI 调起）。没有创建任何 Release。',
  )
  process.exit(EXIT_REFUSED)
}

// ── 语义化版本 ─────────────────────────────────────────────────────────────
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseSemver(text) {
  const match = SEMVER.exec(String(text).trim())
  if (!match) return null
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] || '',
  }
}

/** semver 2.0 的先后：核心数字逐段比；有预发布标识的比正式版旧。 */
function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1
  }
  if (!a.pre && !b.pre) return 0
  if (!a.pre) return 1
  if (!b.pre) return -1
  const left = a.pre.split('.')
  const right = b.pre.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1
    if (right[i] === undefined) return 1
    const ln = /^\d+$/.test(left[i])
    const rn = /^\d+$/.test(right[i])
    if (ln && rn) {
      if (Number(left[i]) !== Number(right[i])) return Number(left[i]) < Number(right[i]) ? -1 : 1
    } else if (ln !== rn) {
      return ln ? -1 : 1
    } else if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1
    }
  }
  return 0
}

// ── tag 清单 ───────────────────────────────────────────────────────────────
const tagResult = spawnSync('git', ['tag', '--list'], { cwd: ROOT, encoding: 'utf8' })
if (tagResult.status !== 0) {
  die(`git tag --list 失败: ${(tagResult.stderr || tagResult.error || '').toString().trim()}`)
}
const allTags = (tagResult.stdout || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((tag) => ({ tag, version: parseSemver(tag) }))
  .filter((item) => item.version)
  .sort((a, b) => compareSemver(b.version, a.version)) // 从新到旧

if (allTags.length === 0) die('仓库里没有语义化版本的 tag')

const newest = allTags[0]
const oldest = allTags[allTags.length - 1]
const from = parseSemver(opts.from || oldest.version.raw)
const to = parseSemver(opts.to || newest.version.raw)
if (!from) die(`--from 不像语义化版本: ${opts.from}`)
if (!to) die(`--to 不像语义化版本: ${opts.to}`)
if (compareSemver(from, to) > 0) die(`区间反了：--from ${from.raw} 比 --to ${to.raw} 新`)

const selected = allTags.filter(
  (item) => compareSemver(item.version, from) >= 0 && compareSemver(item.version, to) <= 0,
)
if (selected.length === 0) die(`v${from.raw} .. v${to.raw} 之间没有 tag`)

// ── gh 调用 ────────────────────────────────────────────────────────────────
/** tag 已校验是语义化版本；.cmd shim 只在 Windows 上有意义（也给测试的假 gh 用）。 */
function ghSpawn(args) {
  const viaShim = /\.(cmd|bat)$/i.test(GH)
  if (viaShim) {
    const quote = (text) => {
      if (/["\r\n]/.test(text)) throw new Error(`gh 参数里不允许引号或换行: ${text}`)
      return /[\s&|<>^()]/.test(text) ? `"${text}"` : text
    }
    const line = `""${GH}" ${args.map(quote).join(' ')}"`
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      stdio: 'pipe',
    })
  }
  return spawnSync(GH, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
}

// ── 已有 Release（只读） ───────────────────────────────────────────────────
const listResult = ghSpawn(['release', 'list', '--limit', '200', '--json', 'tagName'])
if (listResult.status !== 0) {
  const detail = (listResult.stderr || listResult.stdout || listResult.error || '').toString().trim()
  die(`读取现有 Release 失败（gh 不可用或未登录）: ${detail || '无输出'}`)
}
let existingTags
try {
  existingTags = new Set(
    JSON.parse(listResult.stdout || '[]')
      .map((item) => parseSemver(item.tagName)?.raw)
      .filter(Boolean),
  )
} catch (error) {
  die(`解析 gh release list 的 JSON 失败: ${error.message}`)
}

// ── 计划：逐个 tag 判断 skip / create / missing ─────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), 'publish-releases-'))
const changelogArgs = opts.changelog ? ['--changelog', resolve(process.cwd(), opts.changelog)] : []
const plan = []

function notesFor(version) {
  const outPath = join(workDir, `notes-${version}.md`)
  const result = spawnSync(
    process.execPath,
    [RELEASE_NOTES, '--version', version, '--out', outPath, ...changelogArgs],
    { cwd: ROOT, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop()
    return { ok: false, detail: detail || 'release-notes 失败' }
  }
  const bytes = statSync(outPath).size
  const first = (readFileSync(outPath, 'utf8').split(/\r?\n/).find((line) => line.trim()) || '').trim()
  return { ok: true, outPath, bytes, first }
}

let exitCode = 0
try {
  for (const item of selected) {
    if (existingTags.has(item.version.raw)) {
      plan.push({ ...item, status: 'skip' })
      continue
    }
    const notes = notesFor(item.version.raw)
    plan.push(notes.ok ? { ...item, status: 'create', notes } : { ...item, status: 'missing' })
  }

  // ── 打印计划 ─────────────────────────────────────────────────────────────
  console.log(
    `Release 补档：v${from.raw} .. v${to.raw}（${plan.length} 个 tag，从新到旧，` +
      `${opts.apply ? 'apply' : 'dry-run 只读'}）`,
  )
  for (const item of plan) {
    const head = `${item.tag.padEnd(9)}  ${item.status}`
    if (item.status === 'create') console.log(`${head}  notes=${item.notes.bytes}B  ${item.notes.first}`)
    else if (item.status === 'skip') console.log(`${head}(已存在)`)
    else console.log(`${head}(无 CHANGELOG 段落)`)
  }

  const counts = {
    create: plan.filter((item) => item.status === 'create').length,
    skip: plan.filter((item) => item.status === 'skip').length,
    missing: plan.filter((item) => item.status === 'missing').length,
  }
  console.log(
    `合计 ${plan.length} 个 tag：create ${counts.create}，skip(已存在) ${counts.skip}，` +
      `missing(无 CHANGELOG 段落) ${counts.missing}`,
  )

  if (counts.missing > 0) {
    console.error(
      opts.apply
        ? `publish-releases: ${counts.missing} 个 tag 在 CHANGELOG 里没有段落，已中止；` +
            '一个 Release 都没有创建。先补 CHANGELOG 再重跑。'
        : `publish-releases: ${counts.missing} 个 tag 在 CHANGELOG 里没有段落；` +
            'dry-run 退出码 2，补上段落之前不要 --apply。',
    )
    exitCode = EXIT_MISSING
  } else if (!opts.apply) {
    console.log('dry-run：没有调用任何写操作。确认清单后加 --apply --yes（需交互终端）再跑。')
    exitCode = 0
  } else {
    let created = 0
    const failures = []
    for (const item of plan) {
      if (item.status !== 'create') continue
      const result = ghSpawn([
        'release',
        'create',
        item.tag,
        '--title',
        `dsh-in-hand ${item.tag}`,
        '--notes-file',
        item.notes.outPath,
        '--verify-tag',
      ])
      if (result.status === 0) {
        created++
        console.log(`${item.tag.padEnd(9)}  created  ${(result.stdout || '').trim()}`)
      } else {
        const detail = (result.stderr || result.stdout || '')
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .pop()
        failures.push({ tag: item.tag, detail: detail || `退出码 ${result.status}` })
        console.log(`${item.tag.padEnd(9)}  failed   ${detail || `退出码 ${result.status}`}`)
      }
    }
    console.log(`已创建 ${created} 个 Release，失败 ${failures.length} 个。`)
    if (failures.length > 0) {
      for (const failure of failures) console.error(`publish-releases: ${failure.tag} 失败: ${failure.detail}`)
      exitCode = 1
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

process.exit(exitCode)
