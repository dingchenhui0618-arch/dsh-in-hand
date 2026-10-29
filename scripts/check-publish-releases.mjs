#!/usr/bin/env node
/**
 * Release 补档脚本（scripts/publish-releases.mjs）的契约测试。
 *
 * 五组：
 *   1. 默认 dry-run 只读：v1.8.13 是 create；已有 Release 时变 skip(已存在)；全程没有 gh 写调用
 *   2. --apply --yes（假 gh）：只对缺 Release 的 tag 调 `release create ... --verify-tag`，
 *      已存在的 tag 不出现，正文来自 release-notes
 *   3. --apply 缺 --yes / 非交互终端：退出码非 0，gh 一次都没被调用
 *   4. 区间过滤：--from/--to 含端点，且按语义化版本比较（1.8.9..1.8.11 一定含 1.8.10）
 *   5. CHANGELOG 缺段落：dry-run 退出码 2；--apply 中止且一个 Release 都没创建
 *
 * 所有 gh 调用都落到临时目录里的假 gh（.cmd + node 脚本），记录参数到文件；
 * 测试不联网、不碰真实 Release、不动仓库文件。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SCRIPT = join(HERE, 'publish-releases.mjs')

const fakeRoot = mkdtempSync(join(tmpdir(), 'publish-releases-check-'))
// v1.5.2 之前就有 Release（也只有它们有）；v1.6.0 起才有 CHANGELOG 段落，所以默认
// 全量跑时这 8 个 tag 应该被跳过，而不是报 missing。
const OLD_RELEASES = ['v1.1.0', 'v1.2.0', 'v1.2.1', 'v1.3.0', 'v1.4.0', 'v1.5.0', 'v1.5.1', 'v1.5.2']
const fakeBin = join(fakeRoot, 'bin')
const fakeGh = join(fakeBin, 'gh.cmd')
const fakeGhJs = join(fakeBin, 'fake-gh.mjs')
const logPath = join(fakeRoot, 'gh-calls.log')
mkdirSync(fakeBin, { recursive: true })

// ── 假 gh：release list 返回 FAKE_GH_EXISTING；其余（create 等）只记录参数 ──
writeFileSync(
  fakeGhJs,
  `import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const log = process.env.FAKE_GH_LOG
const entry = { args }
const at = args.indexOf('--notes-file')
if (at !== -1 && args[at + 1]) entry.notes = readFileSync(args[at + 1], 'utf8')
appendFileSync(log, JSON.stringify(entry) + '\\n')
if (args[0] === 'release' && args[1] === 'list') {
  const tags = (process.env.FAKE_GH_EXISTING || '').split(',').filter(Boolean)
  process.stdout.write(JSON.stringify(tags.map((tagName) => ({ tagName }))))
  process.exit(0)
}
const tag = args[0] === 'release' && args[1] === 'create' ? args[2] : ''
process.stdout.write('https://github.invalid/fake/releases/tag/' + tag + '\\n')
`,
  'utf8',
)
writeFileSync(fakeGh, `@echo off\r\nnode "%~dp0fake-gh.mjs" %*\r\n`, 'utf8')

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`  ${mark}  ${label}${detail && !condition ? ' -> ' + detail : ''}`)
}

function readCalls() {
  try {
    return readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function isCreate(call) {
  return call.args[0] === 'release' && call.args[1] === 'create'
}

function run(args, options = {}) {
  writeFileSync(logPath, '')
  const env = {
    ...process.env,
    PATH: fakeBin + ';' + (process.env.PATH || ''),
    PUBLISH_RELEASES_GH: fakeGh,
    FAKE_GH_LOG: logPath,
    FAKE_GH_EXISTING: (options.existing || []).join(','),
  }
  delete env.PUBLISH_RELEASES_ASSUME_TTY
  if (options.assumeTty) env.PUBLISH_RELEASES_ASSUME_TTY = '1'
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    stdio: 'pipe',
  })
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    calls: readCalls(),
  }
}

/** 计划行：`v1.8.13    create  notes=...`（从新到旧）。 */
function planLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => /^v\d+\.\d+\.\d+\s+(create|skip|missing)/.test(line))
}

function statusOf(stdout, tag) {
  const line = planLines(stdout).find((item) => item.startsWith(tag + ' ') || item.startsWith(tag + '\t'))
  if (!line) return null
  const match = /\s(create|skip|missing)\b/.exec(line)
  return match ? match[1] : null
}

function versionsIn(lines) {
  return lines.map((line) => /^v\d+\.\d+\.\d+/.exec(line)[0])
}

try {
  // ── 1. 默认 dry-run 只读 ────────────────────────────────────────────────
  console.log('1. dry-run（默认只读）')
  const dry = run([], { existing: OLD_RELEASES })
  check('退出码 0', dry.status === 0, dry.stderr.trim())
  check('输出含 v1.8.13', planLines(dry.stdout).some((line) => line.startsWith('v1.8.13')))
  check('v1.8.13 状态是 create', statusOf(dry.stdout, 'v1.8.13') === 'create', String(statusOf(dry.stdout, 'v1.8.13')))
  check('有汇总行', /合计 \d+ 个 tag：create \d+，skip\(已存在\) \d+，missing\(无 CHANGELOG 段落\) \d+/.test(dry.stdout))
  check('create 行都带 notes 大小与正文标题', planLines(dry.stdout)
    .filter((line) => /\screate\b/.test(line))
    .every((line) => /notes=\d+B\s+## dsh-in-hand v\d+\.\d+\.\d+/.test(line)))
  check('dry-run 没有任何 gh 写调用', dry.calls.every((call) => !isCreate(call)),
    dry.calls.filter(isCreate).map((call) => call.args.join(' ')).join(' ; '))
  check('dry-run 只发生只读 release list', dry.calls.every((call) =>
    call.args[0] === 'release' && ['list', 'view'].includes(call.args[1])),
    dry.calls.map((call) => call.args.join(' ')).join(' ; '))

  const drySkip = run([], { existing: [...OLD_RELEASES, 'v1.8.13'] })
  check('已有 Release 时 v1.8.13 变 skip', statusOf(drySkip.stdout, 'v1.8.13') === 'skip',
    String(statusOf(drySkip.stdout, 'v1.8.13')))
  check('skip 行写明已存在', /v1\.8\.13\s+skip\(已存在\)/.test(drySkip.stdout))
  check('有已存在时仍不写', drySkip.calls.every((call) => !isCreate(call)))

  // ── 2. --apply --yes 只补缺的 ───────────────────────────────────────────
  console.log('2. --apply --yes（假 gh）')
  const applied = run(['--from', '1.8.9', '--to', '1.8.11', '--apply', '--yes'], {
    existing: ['v1.8.10'],
    assumeTty: true,
  })
  check('退出码 0', applied.status === 0, applied.stderr.trim())
  const creates = applied.calls.filter(isCreate)
  check('创建了 2 个 Release', creates.length === 2, creates.map((call) => call.args[2]).join(','))
  check('只创建 v1.8.9 与 v1.8.11', creates.map((call) => call.args[2]).sort().join(',') === 'v1.8.11,v1.8.9',
    creates.map((call) => call.args[2]).join(','))
  check('已存在的 v1.8.10 没有出现在创建调用里',
    creates.every((call) => call.args[2] !== 'v1.8.10' && !call.args.includes('v1.8.10')))
  check('每条创建都带 --verify-tag', creates.every((call) => call.args.includes('--verify-tag')))
  check('标题是 dsh-in-hand <tag>', creates.every((call) => {
    const at = call.args.indexOf('--title')
    return at !== -1 && call.args[at + 1] === 'dsh-in-hand ' + call.args[2]
  }))
  check('正文来自 release-notes（标题行）', creates.every((call) =>
    (call.notes || '').startsWith('## dsh-in-hand ' + call.args[2] + '\n')))
  check('正文含 Install 行', creates.every((call) => (call.notes || '').includes('Install: `dsh plugin --profile web add dsh-in-hand`')))
  check('末尾报告创建数', /已创建 2 个 Release，失败 0 个/.test(applied.stdout))

  // ── 3. 拒绝执行的两条路径 ───────────────────────────────────────────────
  console.log('3. --apply 的防误发')
  const noYes = run(['--from', '1.8.9', '--to', '1.8.10', '--apply'], { existing: [] })
  check('没有 --yes 时退出码非 0', noYes.status !== 0 && noYes.status !== null, `status=${noYes.status}`)
  check('没有 --yes 时明确说需要 --yes', /--yes/.test(noYes.stderr))
  check('没有 --yes 时 gh 没被调用', noYes.calls.length === 0, noYes.calls.map((call) => call.args.join(' ')).join(' ; '))

  const noTty = run(['--from', '1.8.9', '--to', '1.8.10', '--apply', '--yes'], { existing: [] })
  check('非交互终端时退出码非 0', noTty.status !== 0 && noTty.status !== null, `status=${noTty.status}`)
  check('非交互终端时说明终端要求', /交互终端|TTY/.test(noTty.stderr), noTty.stderr.trim())
  check('非交互终端时 gh 没被调用', noTty.calls.length === 0, noTty.calls.map((call) => call.args.join(' ')).join(' ; '))

  // ── 4. 区间过滤（含端点、语义化比较） ───────────────────────────────────
  console.log('4. 区间过滤')
  const range = run(['--from', '1.8.10', '--to', '1.8.11'], { existing: [] })
  check('区间 1.8.10..1.8.11 退出码 0', range.status === 0, range.stderr.trim())
  check('区间内正好是这两个 tag', versionsIn(planLines(range.stdout)).join(',') === 'v1.8.11,v1.8.10',
    versionsIn(planLines(range.stdout)).join(','))
  check('不包含 v1.8.9', !planLines(range.stdout).some((line) => line.startsWith('v1.8.9')))
  check('不包含 v1.8.12', !planLines(range.stdout).some((line) => line.startsWith('v1.8.12')))

  const semverRange = run(['--from', '1.8.9', '--to', '1.8.11'], { existing: [] })
  check('语义化比较：1.8.9..1.8.11 含 1.8.10（字符串比较会漏）',
    versionsIn(planLines(semverRange.stdout)).includes('v1.8.10'),
    versionsIn(planLines(semverRange.stdout)).join(','))
  check('语义化比较：三个 tag 一个不多一个不少',
    versionsIn(planLines(semverRange.stdout)).join(',') === 'v1.8.11,v1.8.10,v1.8.9',
    versionsIn(planLines(semverRange.stdout)).join(','))

  // ── 5. CHANGELOG 缺段落 ─────────────────────────────────────────────────
  console.log('5. CHANGELOG 缺段落')
  const fixture = join(fakeRoot, 'CHANGELOG.fixture.md')
  writeFileSync(fixture, [
    '# 更新日志',
    '',
    '## v1.8.10 — 夹具：只有这一段',
    '',
    '- 这一段的正文来自夹具，不属于真实 CHANGELOG。',
    '',
    '## v1.8.9 — 区间外',
    '',
    '- 不该出现在 1.8.10..1.8.12 的计划里。',
    '',
  ].join('\n'), 'utf8')

  const missingDry = run(['--from', '1.8.10', '--to', '1.8.12', '--changelog', fixture], { existing: [] })
  check('dry-run 退出码 2', missingDry.status === 2, `status=${missingDry.status}`)
  check('v1.8.10 仍是 create', statusOf(missingDry.stdout, 'v1.8.10') === 'create')
  check('v1.8.11 标为 missing', statusOf(missingDry.stdout, 'v1.8.11') === 'missing')
  check('v1.8.12 标为 missing', statusOf(missingDry.stdout, 'v1.8.12') === 'missing')
  check('missing 行写明原因', /v1\.8\.11\s+missing\(无 CHANGELOG 段落\)/.test(missingDry.stdout))
  check('dry-run 缺段落时不写', missingDry.calls.every((call) => !isCreate(call)))

  const missingApply = run(
    ['--from', '1.8.10', '--to', '1.8.12', '--apply', '--yes', '--changelog', fixture],
    { existing: [], assumeTty: true },
  )
  check('--apply 遇 missing 退出码 2', missingApply.status === 2, `status=${missingApply.status}`)
  check('--apply 中止时明确说没有创建', /没有创建|一个 Release 都没有创建/.test(missingApply.stderr), missingApply.stderr.trim())
  check('--apply 中止时一个 Release 都没建', missingApply.calls.every((call) => !isCreate(call)),
    missingApply.calls.filter(isCreate).map((call) => call.args.join(' ')).join(' ; '))
} finally {
  rmSync(fakeRoot, { recursive: true, force: true })
}

console.log(failures === 0 ? '\npublish releases: 全部通过' : `\npublish releases: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
