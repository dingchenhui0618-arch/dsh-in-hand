#!/usr/bin/env node
/**
 * Release note 生成器（scripts/release-notes.mjs）的契约测试。
 *
 * 五组：
 *   1. 当前版本能生成，正文含版本号与 Install 行
 *   2. 生成结果包含 CHANGELOG 该段的全部内容（逐行），且至少 3 个该段特有的关键词
 *   3. --check 版本一致退出 0；不存在的版本（--version 9.9.9）退出 1 且报错含版本号
 *   4. 带 `###` 子标题的临时样例不被截断，且下一段内容不混进来
 *   5. --out 写出的文件是 UTF-8 无 BOM、LF 行尾，内容与 stdout 一致
 *
 * 只用 node 内置模块，不联网、不改仓库文件；临时文件在结束后删掉。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SCRIPT = join(HERE, 'release-notes.mjs')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const changelog = readFileSync(CHANGELOG, 'utf8').replace(/\r\n?/g, '\n')

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`  ${mark}  ${label}${detail && !condition ? ' -> ' + detail : ''}`)
}

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

/** 与生成器同样口径：该版本标题之后到下一个 `## ` 之前。 */
function sectionOf(text, version) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}(?=[\\s—–-]|$)`).test(line))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start + 1, end).join('\n').trim()
}

const tmp = mkdtempSync(join(tmpdir(), 'release-notes-check-'))
try {
  // ── 1. 当前版本生成 ─────────────────────────────────────────────────────
  console.log('1. 生成（当前版本）')
  const generated = run([])
  check('退出码 0', generated.status === 0, generated.stderr)
  check(`标题是 ## ${pkg.name} v${pkg.version}`, generated.stdout.includes(`## ${pkg.name} v${pkg.version}`))
  check('含 Install 行', generated.stdout.includes(`Install: \`dsh plugin --profile web add ${pkg.name}\``))
  check('含 Full changelog 链接', /Full changelog: https:\/\/github\.com\/\S+\/blob\/main\/CHANGELOG\.md/.test(generated.stdout))
  check('标题后紧跟空行', generated.stdout.startsWith(`## ${pkg.name} v${pkg.version}\n\n`))

  // ── 2. 段落要点不丢 ─────────────────────────────────────────────────────
  console.log('2. 段落内容完整')
  const section = sectionOf(changelog, pkg.version)
  check('CHANGELOG 里能定位该段（测试自检）', Boolean(section))
  const lost = (section || '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => !generated.stdout.includes(line.trimEnd()))
  check(`该段 ${(section || '').split('\n').filter((l) => l.trim()).length} 行全部保留`, lost.length === 0,
    lost.slice(0, 3).map((l) => JSON.stringify(l)).join(' ; '))

  const keywords = [...new Set(Array.from((section || '').matchAll(/`([^`\n]{2,40})`/g), (m) => m[1]))]
  const hits = keywords.filter((k) => generated.stdout.includes('`' + k + '`'))
  check(`至少 3 个该段特有反引号关键词（命中 ${hits.length}/${keywords.length}）`, hits.length >= 3)

  if (pkg.version === '1.8.13') {
    for (const keyword of ['release:notes', 'scripts/release-notes.mjs', 'docs/RELEASING.md']) {
      check(`含 1.8.13 关键词 \`${keyword}\``, generated.stdout.includes(keyword))
    }
  }

  // ── 3. --check 两个失败路径与成功路径 ───────────────────────────────────
  console.log('3. --check')
  const ok = run(['--check'])
  check('版本一致时退出 0', ok.status === 0, ok.stderr)
  check('成功时说清版本', ok.stdout.includes(`v${pkg.version}`), ok.stdout.trim())

  const missing = run(['--version', '9.9.9', '--check'])
  check('不存在的版本退出 1', missing.status === 1, `status=${missing.status}`)
  check('报错信息含 9.9.9', missing.stderr.includes('9.9.9'), missing.stderr.trim())
  check('报错信息给出 CHANGELOG 路径提示', /CHANGELOG/.test(missing.stderr), missing.stderr.trim())

  const older = changelog.split('\n')
    .map((line) => /^##\s+v?(\d+\.\d+\.\d+)/.exec(line))
    .find((m) => m && m[1] !== pkg.version)
  if (older) {
    const mismatch = run(['--version', older[1], '--check'])
    check('CHANGELOG 与 package.json 版本不一致时退出 1', mismatch.status === 1, `status=${mismatch.status}`)
    check('不一致时两边版本号都点名', mismatch.stderr.includes(`v${older[1]}`) && mismatch.stderr.includes(`v${pkg.version}`),
      mismatch.stderr.trim())
  }

  // ── 4. `###` 子标题不截断 ───────────────────────────────────────────────
  console.log('4. ### 子标题样例')
  const fixture = join(tmp, 'CHANGELOG.fixture.md')
  writeFileSync(fixture, [
    '# 更新日志',
    '',
    '## v9.9.8 — 子标题样例',
    '',
    '段落开头的一句话。',
    '',
    '### 小节一',
    '',
    '这一行在 `###` 子标题下面，不能被截断。',
    '',
    '- 要点 A',
    '- 要点 B',
    '',
    '## v9.9.7 — 下一段',
    '',
    '- 这一段属于 9.9.7，不该混进 9.9.8 的正文',
    '',
  ].join('\n'), 'utf8')
  const sample = run(['--version', '9.9.8', '--changelog', fixture])
  check('临时样例生成成功', sample.status === 0, sample.stderr)
  check('保留 ### 子标题', sample.stdout.includes('### 小节一'))
  check('保留子标题下的正文', sample.stdout.includes('这一行在 `###` 子标题下面，不能被截断。'))
  check('保留子标题后的列表', sample.stdout.includes('- 要点 A') && sample.stdout.includes('- 要点 B'))
  check('不越过下一个 ## 段落', !sample.stdout.includes('不该混进') && !sample.stdout.includes('v9.9.7'))

  // ── 5. 输出文件编码与行尾 ───────────────────────────────────────────────
  console.log('5. --out 文件格式')
  const outFile = join(tmp, 'nested', 'notes.md')
  const written = run(['--out', outFile])
  check('写文件退出 0', written.status === 0, written.stderr)
  const bytes = readFileSync(outFile)
  check('前 3 字节不是 EF BB BF（无 BOM）',
    !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
    bytes.subarray(0, 3).toString('hex'))
  check('不含 CRLF', !bytes.includes(Buffer.from('\r\n')))
  check('以 LF 结尾', bytes[bytes.length - 1] === 0x0a)
  check('内容与 stdout 模式一致', bytes.toString('utf8') === generated.stdout)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nrelease notes: 全部通过' : `\nrelease notes: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
