/**
 * 从 lib/page.html 生成 docs/demo.html —— 用于截图的假数据演示页。
 *
 * 为什么不直接截真实页面：真实页面里有会话标题、cwd、后台任务的命令行和对话正文，
 * 那些是使用者的私有数据，不能进公开仓库。
 *
 * 为什么用生成而不是手写：手写一份 demo 就意味着 CSS 与结构有两份副本，一定会漂移，
 * 截图会慢慢变成"一张不像现在 UI 的图"。这里直接复用真实的 lib/page.html，只把
 * 取数与启动逻辑换掉，所以只要 page.html 变了，重新跑本脚本截图就与实现一致。
 *
 * ⚠️ 2026-10-08 的真实教训：本脚本原先靠**一个字面量锚点**找 page.html 结尾的
 * `tick();`。那一轮 UI 重构把启动行换成了 async IIFE，脚本当场失效 —— 而
 * `npm run check` 覆盖不到它，于是 CI 全绿、README 却指向一个生成不出来、内容
 * 停在旧界面的演示页，整整一个版本没人发现。
 *
 * 所以现在：① 锚点改成**结构性**的（匹配启动 IIFE，而不是某一行字面量）；
 * ② 本文件导出 `buildDemo()` 与 `BOOT_ANCHOR`，由 check-bundle.mjs 断言锚点仍然
 * 命中、且 docs/demo.html 与当前 page.html 构建结果一致（时间戳归一化后比对）。
 * 只要 page.html 再动结构而这里没跟上，契约测试就会红。
 *
 * 用法：node scripts/make-demo.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * 启动块的锚点。
 *
 * page.html 结尾原本是裸的 `tick();`，2026-10-08 的重构换成了这个 async IIFE。
 * 匹配 IIFE 的整体结构（允许 await 序列变化），比匹配某一行字面量稳得多。
 */
export const BOOT_ANCHOR = /;\(async function\(\)\{[\s\S]*?\}\)\(\)\r?\n/

/** 演示用的虚构快照。字段形状必须与 /taskwatch/data 一致。 */
function demoData(now) {
  const S = (sec) => now - sec * 1000
  return {
    generatedAt: now,
    offline: false,
    errors: [],
    totals: { sessions: 4, running: 2, jobs: 5, jobsRunning: 3, subagents: 2, workflows: 1, pending: 1 },
    pending: [
      {
        title: '等待确认：删除 3 个过期缓存目录',
        detail: '即将对 build/cache 下的过期产物执行清理，需要你先确认。',
        kind: 'approval/request',
        session: 'session-demo-a',
        at: S(45),
      },
    ],
    sessions: [
      {
        id: 'session-demo-a',
        title: '重构支付模块的重试逻辑',
        running: true,
        activeJobs: 2,
        live: true,
        origin: 'root',
        depth: 0,
        preset: 'cordis',
        cwd: '~/projects/payments',
        updatedAt: S(3),
        goal: {
          phase: 'active',
          roundsStarted: 7,
          maxGoalRounds: 50,
          activation: 'armed',
          objective: '把支付回调的重试从固定间隔改成指数退避，并补齐幂等键的边界用例。',
        },
      },
      {
        id: 'session-demo-b',
        title: '整理季度报表导出',
        running: true,
        activeJobs: 1,
        live: true,
        origin: 'root',
        depth: 0,
        preset: 'cordis',
        cwd: '~/projects/reports',
        updatedAt: S(18),
        goal: { phase: 'active', roundsStarted: 3, maxGoalRounds: 20, activation: 'armed', objective: '导出去年四个季度的报表并核对口径。' },
      },
      {
        id: 'session-demo-c',
        title: '排查登录态失效问题',
        running: false,
        activeJobs: 0,
        live: true,
        origin: 'root',
        depth: 0,
        preset: 'cordis',
        cwd: '~/projects/web',
        updatedAt: S(2400),
        goal: null,
      },
      {
        id: 'session-demo-d',
        title: '更新部署文档',
        running: false,
        activeJobs: 0,
        live: false,
        origin: 'subagent',
        depth: 1,
        preset: 'cordis',
        cwd: '~/projects/docs',
        updatedAt: S(8600),
        goal: null,
      },
    ],
    jobs: [
      { id: 'job-1', label: 'pnpm test --filter payments', kind: 'pwsh', status: 'running', owner: 'session-demo-a', startedAt: S(310), finishedAt: 0 },
      { id: 'job-2', label: 'node scripts/build.mjs', kind: 'pwsh', status: 'running', owner: 'session-demo-a', startedAt: S(95), finishedAt: 0 },
      { id: 'job-3', label: 'node scripts/export-report.mjs --quarter Q3', kind: 'pwsh', status: 'running', owner: 'session-demo-b', startedAt: S(720), finishedAt: 0 },
      { id: 'job-4', label: 'git log --oneline -50', kind: 'pwsh', status: 'done', owner: 'session-demo-c', startedAt: S(3000), finishedAt: S(2998) },
      { id: 'job-5', label: 'node scripts/make-icons.mjs', kind: 'pwsh', status: 'failed', owner: 'session-demo-b', startedAt: S(5200), finishedAt: S(5195) },
    ],
    subagents: [
      { id: 'agent-demo-1', label: '核对接口字段', mode: 'subagent', activity: 'running', depth: 1, parent: 'session-demo-a' },
      { id: 'agent-demo-2', label: '翻译发布说明', mode: 'subagent', activity: 'idle', depth: 1, parent: 'session-demo-b' },
    ],
    workflows: [
      { id: 'wf-demo-1', name: '回归测试与发布检查', phase: 'verify', logs: 42, startedAt: S(1800) },
    ],
  }
}

/**
 * 演示图表的 data URI。
 *
 * 为什么内嵌而不是放一张 png：演示页要能在 file:// 下直接打开、**不发任何网络请求**，
 * 所以图必须是自包含的。用 SVG 而不是位图还有一个理由 —— 源文件里读得出来画的是什么，
 * 换配色不用去开编辑器。
 */
const DEMO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="340" viewBox="0 0 720 340">
<rect width="720" height="340" rx="16" fill="#e6eaf0"/>
<text x="28" y="46" font-family="system-ui,sans-serif" font-size="19" font-weight="600" fill="#2d3139">重试间隔：固定 5s → 指数退避</text>
<text x="28" y="74" font-family="system-ui,sans-serif" font-size="14" fill="#5b6270">演示数据 · 非真实图表</text>
<g fill="#2d3139">
<rect x="60" y="220" width="58" height="70" rx="6"/>
<rect x="150" y="180" width="58" height="110" rx="6" opacity=".82"/>
<rect x="240" y="140" width="58" height="150" rx="6" opacity=".66"/>
<rect x="330" y="110" width="58" height="180" rx="6" opacity=".5"/>
<rect x="420" y="96" width="58" height="194" rx="6" opacity=".34"/>
</g>
<g fill="#5b6270" font-family="system-ui,sans-serif" font-size="13">
<text x="66" y="312">2s</text><text x="156" y="312">4s</text><text x="246" y="312">8s</text>
<text x="336" y="312">16s</text><text x="426" y="312">32s</text>
</g>
</svg>`
const DEMO_CHART = 'data:image/svg+xml;base64,' + Buffer.from(DEMO_SVG, 'utf8').toString('base64')

/**
 * 演示对话。形状是页面内部的**归一化后**条目（见 page.html 的 normUser /
 * normAssistant / toolItem），不是宿主事件原文 —— 这样演示页不需要模拟事件流。
 *
 * 有意安排了三件事，好让截图能体现当前版本的能力：
 *   · 连续 4 次工具调用 → 折叠成一行「4 个步骤」（其中 1 项失败，失败永不隐藏）
 *   · 一段带标题 / 列表 / 行内代码 / 代码块的回复 → 轻量 markdown 渲染
 *   · 一条带图与 PDF 的回复 → 图直接铺在对话里、PDF 给可点卡片（v1.3.0 新增）
 */
function demoItems(now) {
  const S = (sec) => now - sec * 1000
  return [
    { kind: 'user', text: '把回调的重试从固定间隔改成指数退避，先只动这一处。' },
    { kind: 'assistant', text: '已定位到入口。当前是**固定 5 秒**、最多 3 次，退避逻辑抽在 `retryPolicy` 里。' },
    // 工具条的 status 用的是页面内部的 ok / no（见 page.html 的 markTool），
    // 不是 /taskwatch/data 里 jobs 的 running/done/failed —— 两者词表不同，别混。
    { kind: 'tool', callId: 't1', name: 'grep', hint: 'retryPolicy', status: 'ok' },
    { kind: 'tool', callId: 't2', name: 'read', hint: 'src/payments/callback.ts', status: 'ok' },
    { kind: 'tool', callId: 't3', name: 'edit', hint: 'src/payments/retry.ts', status: 'ok' },
    { kind: 'tool', callId: 't4', name: 'pwsh', hint: 'pnpm test --filter payments', status: 'no' },
    {
      kind: 'assistant',
      text: '## 改动\n\n- 基础 2 秒，上限 60 秒\n- 保留最后一次失败的原始异常\n\n```ts\nconst delay = Math.min(60000, 2000 * 2 ** attempt)\n```\n\n单测 12/12 通过，幂等键的重复投递用例也补上了。',
    },
    {
      kind: 'assistant',
      // 图走 data URI（自包含、零请求）；PDF 走 /taskwatch/file —— 演示页的 fetch
      // 打桩会给它回假元数据，所以卡片上能看到大小，但不会真的联网。
      text: '顺手画了一张退避曲线，直接在对话里看：\n\n![退避曲线](' + DEMO_CHART + ')\n\n说明也导出了：\n\n[改造说明.pdf](~/dsh/outbox/demo-report.pdf)',
    },
    { kind: 'assistant', text: '还差一件事：缓存目录的清理要你确认后才执行。' },
  ]
}

/** 演示页的启动块：接管网络 + 直接喂状态，不轮询、不联网。 */
function demoBoot(now) {
  return [
    `var DEMO=${JSON.stringify(demoData(now))};`,
    `var DEMO_ITEMS=${JSON.stringify(demoItems(now))};`,
    '// 演示页：不轮询、不联网、任何会话都能点开看同一份示例对话。',
    '// tick / ensureSession / startPolling / openStream 都是函数声明（会提升），覆盖安全。',
    'tick=async function(){};',
    'ensureSession=async function(){};',
    'startPolling=function(){};',
    'stopPolling=function(){};',
    'openStream=function(){};',
    '// fetch 也接管掉：这样页面自己的 renderList/同步接口路径仍然走原代码，',
    '// 但永远拿的是假数据，file:// 直接打开也不会发出任何真实请求。',
    'window.fetch=function(u){',
    "  var p=String(u).split('?')[0];",
    '  function reply(v){return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(v)}})}',
    "  if(p==='/taskwatch/chat/sessions')return reply({sessions:DEMO.sessions});",
    "  if(p==='/taskwatch/chat/upload')return reply({ok:true,upload:{kind:'file',receiptId:'demo-receipt',name:'演示附件.txt',bytes:1024}});",
    "  if(p==='/taskwatch/chat/send')return reply({ok:true,accepted:true});",
    "  if(p==='/taskwatch/data')return reply(DEMO);",
    // 指标行（轮次/步数/token/缓存命中/上下文）也要有假数据 —— 否则演示页
    // 和 README 截图里根本看不到这一块新 UI。数字是编的，且明确属于演示。
    "  if(p==='/taskwatch/chat/usage')return reply({live:true,turns:41,steps:1287,toolCalls:1402,totalTokens:214570,surfaceTokens:118904,inputTokens:912,cacheReadTokens:213658,cacheWriteTokens:0,reasoningTokens:0,provider:'demo',model:'deepseek-flash',contextWindow:262144});",
    // 交付文件的元数据也打桩：这样 PDF 卡片上能看见类型与大小，而演示页
    // 依然一次真实请求都不发（info 探测打的是这个桩）。
    "  if(p==='/taskwatch/file')return reply({name:'改造说明.pdf',bytes:184320,mime:'application/pdf',kind:'pdf'});",
    '  return reply({});',
    '};',
    'lastData=DEMO;',
    'syncStatus();',
    'S.chatReady=true;',
    'S.sessions=DEMO.sessions;',
    "selectSession('session-demo-a');",
    'S.items=DEMO_ITEMS;',
    'renderAll();',
    // 指标行必须显式喂一次：演示页把 tick 覆盖成空函数了，而 renderStats 平时是
    // 靠 tick -> syncStatus 触发的；boot 里那次 syncStatus 又跑在 selectSession 之前，
    // 当时还没有 sessionId。不补这一句，README 截图里就看不到轮次/步数/token 这一块。
    'USAGE={live:true,turns:41,steps:1287,toolCalls:1402,totalTokens:214570,surfaceTokens:118904,inputTokens:912,cacheReadTokens:213658,cacheWriteTokens:0,reasoningTokens:0,provider:"demo",model:"deepseek-flash",contextWindow:262144};',
    'renderStats();',
    'renderContext();',
    "setSub('演示数据 · 非真实状态');",
  ].join('\n')
}

/**
 * 严格替换：pattern 必须命中，否则抛错。
 *
 * 为什么必须这样：`String.replace` 匹配不到时会**静默返回原串**。旧版就是这样一路
 * 悄悄失效的 —— 重构把页脚换成输入框容器、去掉了 `id="meta"` 之后，那两条替换再也
 * 没生效过，而脚本仍然打印"已生成"，谁都不会发现。演示页的每一次改写要么确定做到，
 * 要么立刻报错。
 */
function mustReplace(out, re, repl, label) {
  if (!re.test(out)) throw new Error('演示页改写失败：' + label + '（page.html 的结构变了）')
  return out.replace(re, repl)
}

/** page.html -> demo.html。纯函数，供脚本与契约测试共用。 */
export function buildDemo(page, now = Date.now()) {
  let out = page
  if (!BOOT_ANCHOR.test(out)) {
    throw new Error('找不到启动块（page.html 的结构变了），请同步更新 scripts/make-demo.mjs 的 BOOT_ANCHOR')
  }
  out = out.replace(BOOT_ANCHOR, demoBoot(now) + '\n')

  // 演示页不注册 service worker（file:// 下也没意义）。
  //
  // ⚠️ 正则必须容忍空格：page.html 里写的是 `if ('serviceWorker' in navigator) {`。
  // 原版正则写成了 `if('serviceWorker'...`，匹配不上，于是演示页一直在注册真实 SW。
  out = mustReplace(
    out,
    /if\s*\(\s*'serviceWorker'\s+in\s+navigator\s*\)\s*\{[\s\S]*?\}\r?\n/,
    '/* demo: 不注册 service worker */\n',
    '剥离 service worker 注册块'
  )

  out = mustReplace(out, /<title>[^<]*<\/title>/, '<title>掌上 DSH · 演示数据</title>', '替换标题')

  // 页脚曾经是个带 id="foot" 的说明行，2026-10-08 已改成输入框容器；
  // 演示标记改由启动块里的 setSub() 写入（见 demoBoot），不要再往 DOM 里塞。
  return out
}

/** 时间戳归一化：让"构建结果是否与提交的 demo.html 一致"可以稳定比较。 */
export function normalizeDemo(html) {
  return html.replace(/\d{10,}/g, '#')
}

// 作为脚本直接运行时才写文件；被 import 时不产生副作用。
if (process.argv[1] && process.argv[1].endsWith('make-demo.mjs')) {
  const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')
  let out
  try {
    out = buildDemo(page)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
  mkdirSync(join(ROOT, 'docs'), { recursive: true })
  writeFileSync(join(ROOT, 'docs', 'demo.html'), out)
  console.log('已生成 docs/demo.html')
  console.log('  取自 lib/page.html（' + page.length + ' 字符）')
  console.log('  演示会话数 4，后台任务 5，对话 9 条（含一段 4 步工具折叠）')
  console.log('  已展开 session-demo-a 以展示详情与对话区')
}
