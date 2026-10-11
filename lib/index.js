/**
 * dsh-in-hand（掌上 DSH）—— Host 半边
 *
 * 采集 DSH 运行时状态并以两个固定路径暴露：
 *   GET /taskwatch        只读移动页（自带轮询）
 *   GET /taskwatch/data   同一份数据的 JSON
 *
 * 采集面：会话（运行/空闲、最后活动、activeJobs）、后台任务 jobs、
 * 子代理树、目标轮次与阻塞、工作流阶段、等待审批/提问。
 *
 * 只读：不提供任何写操作、不接受请求体、不代理 DSH 自身的 /api。
 *
 * 静态资源（PWA）都挂在 /taskwatch/ 之下，service worker 的作用域也限定为
 * /taskwatch —— 绝不允许它有机会拦截主 GUI 的请求。
 */
import { readFileSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// 交付文件的解析与安全边界都在 files.js —— 白名单、穿越防护、类型白名单需要能被
// 测试直接调用，放在路由闭包里就证明不了。
import { MAX_BYTES, dispositionFor, infoOf, resolveTarget, rootsFrom } from './files.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const ICONS = new Map([
  ['/taskwatch/icon-192.png', { file: join(HERE, 'icons', 'icon-192.png'), type: 'image/png' }],
  ['/taskwatch/icon-512.png', { file: join(HERE, 'icons', 'icon-512.png'), type: 'image/png' }],
])

const MANIFEST = JSON.stringify({
  name: '掌上 DSH',
  short_name: '掌上 DSH',
  description: '掌上 DSH：DeepSeek Harness 的手机端——会话、实时对话、后台任务、子代理、目标轮次、工作流与待介入项',
  start_url: '/taskwatch',
  scope: '/taskwatch',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0f1115',
  theme_color: '#0f1115',
  icons: [
    { src: '/taskwatch/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/taskwatch/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/taskwatch/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
})

/** service worker 与页面外壳一样放在独立文件里，理由相同：内联副本必然漂移。
 *
 * 这里曾经内联过一份，版本停在 taskwatch-v1，而部署侧中继里那份已经升到 v3 并
 * 补上了「删除旧缓存」——同一个插件对外提供了两个行为不同的 SW，取决于请求先命中
 * 谁。所以收敛成一个来源。
 */
function readSw() {
  try {
    return readFileSync(join(HERE, 'sw.js'), 'utf8')
  } catch (e) {
    console.error('dsh-in-hand: 读不到 lib/sw.js —— ' + String((e && e.message) || e))
    return '/* lib/sw.js 缺失，本插件不提供离线外壳 */\n'
  }
}

/** 页面外壳放在独立的 lib/page.html。
 *
 * 为什么不内联在代码里：公开访问的页面由中继直接提供同一个文件（常驻插件挂载
 * 之前也一样可用）。两份内联副本必然漂移，所以只留一个来源，改一处两边同时生效。
 *
 * 为什么**每次请求都重读**而不是启动时读一次（2026-10-10 改）：
 * 中继那边本来就是按请求读盘的，所以手机刷新就生效；而插件这边原先在模块加载时
 * 读一次并缓存，结果是同一份 page.html 有两条生效时机 —— 手机立刻看到新版，
 * 本机 /taskwatch 还是旧版，并且要重启整个客户端才更新。实测：改完页面后手机上
 * 已是 112018 字符的新版，宿主内存里仍是 110001 字符的旧版。
 * 一个几十 KB 的本地文件，每次请求读一次可以忽略，换来的是"改了就生效"。
 *
 * 读不到时降级成一句提示而不是抛异常：一个缺失的静态文件不该让插件加载失败，
 * 那会连带把整个 DSH 的启动拖垮。
 */
function readPage() {
  try {
    return readFileSync(join(HERE, 'page.html'), 'utf8')
  } catch (e) {
    console.error('dsh-in-hand: 读不到 lib/page.html —— ' + String((e && e.message) || e))
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>任务监控</title></head><body style="font:15px/1.6 system-ui;padding:24px">'
      + '<h1 style="font-size:17px">页面外壳读不到</h1>'
      + '<p>lib/page.html 缺失或不可读。数据接口仍可用：<code>/taskwatch/data</code></p>'
      + '</body></html>'
  }
}

/**
 * 从 ContentBlock[] 抽出可读文本。
 *
 * 只取叶子字段，绝不把消息对象或会话日志整个带走 —— 那些是活的内部对象，
 * 序列化它们既不可靠也不安全。这里产出的是新造的纯字符串。
 */
function blocksText(blocks) {
  let out = ''
  if (!Array.isArray(blocks)) return out
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text
  }
  return out
}

/** 从 ContentBlock[] 抽出工具调用名，供一行概览用。 */
function blocksTools(blocks) {
  const names = []
  if (!Array.isArray(blocks)) return names
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'tool-call' && typeof b.name === 'string' && names.indexOf(b.name) < 0) names.push(b.name)
  }
  return names
}

// 快照的 ETag 算法单独抽成纯函数，就是为了能被直接测。
//
// 关键在于**对 generatedAt 免疫**：它是每次采集都不同的 Date.now()，直接拿整份
// JSON 做哈希的话内容哈希永远在变，304 会退化成永不命中的死代码。所以先把这个
// 字段丢掉再哈希 —— 其余字段（任务状态、标题、计数）才是「内容到底变没变」的
// 真正依据。check-bundle 里有一条单测专门钉住这条性质。
export function etagOf(payload) {
  const stable = JSON.stringify(payload, (key, value) => (key === 'generatedAt' ? undefined : value))
  return '"' + createHash('sha1').update(stable).digest('hex').slice(0, 20) + '"'
}

export const name = 'dsh-in-hand'

// webServer 是**硬依赖**，必须写进 inject，不能只靠 ctx.get() 软读。
//
// 教训（2026-09-21，v1.0.0 的实际故障）：webserver 那一行的服务是在启动阶段
// 之后才发布的，而 apply 会在组合期就被调用。此时 ctx.get('webServer') 拿到
// undefined，于是整段路由注册被静默跳过 —— 现象是 /taskwatch 一律 404，
// 但插件「装好了、也没报错」，极难排查。声明 inject 后 Cordis 会等该服务
// 就绪再调用 apply，从根上消除这个竞态。
//
// 其余服务（jobs / agents / sessions / goals / subagents / sessionTitle）
// 刻意保持软读 ctx.get()：只读监控缺哪块就少显示哪块，不该因为某个服务没装
// 就整页不可用。
export const inject = ['webServer']

const asText = (v) => (typeof v === 'string' ? v : '')
const asNum = (v) => (typeof v === 'number' && isFinite(v) ? v : 0)
const why = (e) => (e && e.message ? String(e.message) : String(e))

const ENV_ASSIGN = /^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=/i

/** 后台任务的 label 常是多行 shell 命令（含纯环境变量赋值行），折成一行可读文本。 */
function cleanLabel(raw) {
  const all = asText(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!all.length) return ''
  const kept = all.filter((line) => !ENV_ASSIGN.test(line))
  const chosen = kept.length ? kept : all
  const joined = chosen.join(' ; ').replace(/\s+/g, ' ').trim()
  return joined.length > 140 ? joined.slice(0, 137) + '\u2026' : joined
}

const isActiveJob = (status) => status === 'running' || status === 'stopping'

function safe(fn, fallback, errors, label) {
  try {
    return fn()
  } catch (e) {
    if (errors && label) errors.push(label + ': ' + why(e))
    return fallback
  }
}

export function apply(ctx) {
  const jobsSvc = ctx.get('jobs')
  const agentsSvc = ctx.get('agents')
  const sessionsSvc = ctx.get('sessions')
  const goalsSvc = ctx.get('goals')
  const subagentsSvc = ctx.get('subagents')
  const titlesSvc = ctx.get('sessionTitle')
  const webServer = ctx.get('webServer')

  // 只保留标量，绝不持有 live 的 Service / Agent / Session 对象。
  const approvals = new Map()
  const questions = new Map()
  const runningById = new Map()
  const runs = new Map()
  // 只保存本入口签发的会话内上传记录；大小来自实际字节流而非客户端声明。
  // 文件仍由宿主 receipt 授权，图片由不透明 token 授权；成功接收后才消费。
  const pendingUploads = new Map()
  const UPLOAD_TTL_MS = 30 * 60 * 1000
  const MAX_PENDING_UPLOADS = 128
  const MAX_SESSION_UPLOADS = 16
  let activeUploads = 0

  ctx.on('agent/status', (payload) => {
    try {
      const id = payload && payload.agent ? String(payload.agent.id) : ''
      if (id) runningById.set(id, payload.status === 'running')
    } catch { /* 观测失败不能影响主链路 */ }
  })

  ctx.on('api-session/status', (sessionId, isRunning) => {
    try {
      if (typeof sessionId === 'string') runningById.set(sessionId, isRunning === true)
    } catch { /* 同上 */ }
  })

  // approval/request 是 waterfall：必须把 next() 的结论原样返回，
  // 任何自身异常都要吞掉，否则会阻断正常审批链。
  ctx.on('approval/request', async (req, next) => {
    let key = ''
    try {
      const callId = req && req.callId ? String(req.callId) : ''
      key = 'approval:' + (callId || Math.random().toString(36).slice(2))
      approvals.set(key, {
        kind: 'approval',
        session: req && req.agent ? String(req.agent.id) : '',
        title: asText(req && req.toolName) || '(tool)',
        detail: asText(req && req.reason),
        at: Date.now(),
      })
    } catch { /* 记录失败就当作没记录 */ }
    try {
      return await next()
    } finally {
      if (key) approvals.delete(key)
    }
  })

  ctx.on('user-questions/request', async (request, next) => {
    let key = ''
    try {
      const items = request && Array.isArray(request.questions) ? request.questions : []
      const first = items[0] || {}
      key = 'question:' + (asText(first.id) || Math.random().toString(36).slice(2))
      questions.set(key, {
        kind: 'question',
        session: request && request.agent ? String(request.agent.id) : '',
        title: asText(first.header) || asText(first.question) || '(question)',
        detail: asText(first.question),
        at: Date.now(),
      })
    } catch { /* 同上 */ }
    try {
      return await next()
    } finally {
      if (key) questions.delete(key)
    }
  })

  ctx.on('workflow/start', (info) => {
    try {
      const id = info ? String(info.id) : ''
      if (!id) return
      const meta = info.meta || {}
      runs.set(id, {
        id,
        name: asText(meta.name),
        description: asText(meta.description),
        phase: '',
        logs: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      })
    } catch { /* 同上 */ }
  })

  ctx.on('workflow/phase', (info, title) => {
    try {
      const id = info ? String(info.id) : ''
      if (!id) return
      const known = runs.get(id)
      const meta = (info && info.meta) || {}
      runs.set(id, {
        id,
        name: known ? known.name : asText(meta.name),
        description: known ? known.description : asText(meta.description),
        phase: asText(title),
        logs: known ? known.logs : 0,
        startedAt: known ? known.startedAt : Date.now(),
        updatedAt: Date.now(),
      })
    } catch { /* 同上 */ }
  })

  ctx.on('workflow/log', (info) => {
    try {
      const id = info ? String(info.id) : ''
      const known = id ? runs.get(id) : undefined
      if (known) {
        known.logs = asNum(known.logs) + 1
        known.updatedAt = Date.now()
      }
    } catch { /* 同上 */ }
  })

  ctx.on('workflow/end', (info) => {
    try {
      const id = info ? String(info.id) : ''
      if (id) runs.delete(id)
    } catch { /* 同上 */ }
  })

  async function snapshot() {
    const now = Date.now()
    const errors = []
    const out = {
      generatedAt: now,
      totals: { sessions: 0, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
      sessions: [],
      jobs: [],
      subagents: [],
      pending: [],
      workflows: [],
      errors,
    }

    let agents = []
    if (agentsSvc) {
      const listed = safe(() => agentsSvc.list(), null, errors, 'agents.list')
      if (Array.isArray(listed)) agents = listed
    }

    // jobs.list 按属主围栏：不带 caller 只返回无主任务，
    // 所以必须逐个 agent 追问，才能看到各会话自己的后台任务。
    const activeByOwner = new Map()
    if (jobsSvc) {
      const seen = new Set()
      const addJob = (s) => {
        try {
          const id = String(s.id)
          if (seen.has(id)) return
          seen.add(id)
          if (out.jobs.length >= 120) return
          const status = asText(s.status)
          const owner = s.ownerSession ? String(s.ownerSession) : ''
          if (owner && isActiveJob(status)) activeByOwner.set(owner, (activeByOwner.get(owner) || 0) + 1)
          out.jobs.push({
            id,
            kind: asText(s.kind),
            label: cleanLabel(s.label),
            status,
            owner,
            detail: asText(s.detail),
            startedAt: asNum(s.startedAt),
            finishedAt: asNum(s.finishedAt),
          })
        } catch { /* 单条坏数据不该毁掉整次采集 */ }
      }
      const unowned = safe(() => jobsSvc.list(), null, errors, 'jobs.list')
      if (Array.isArray(unowned)) unowned.forEach(addJob)
      for (const a of agents) {
        const owned = safe(() => jobsSvc.list(a), null, null, '')
        if (Array.isArray(owned)) owned.forEach(addJob)
      }
      out.jobs.sort((x, y) => {
        const rx = isActiveJob(x.status) ? 0 : 1
        const ry = isActiveJob(y.status) ? 0 : 1
        return rx - ry || y.startedAt - x.startedAt
      })
    }

    let live = []
    if (sessionsSvc) {
      const listed = safe(() => sessionsSvc.list(), null, errors, 'sessions.list')
      if (Array.isArray(listed)) live = listed
    }

    for (const session of live) {
      try {
        const id = String(session.id)
        const header = session.header || {}
        // 最后活动时间取自日志末条事件的 time；seq 是排他上界。
        let lastActivity = asNum(header.createdAt)
        const seq = asNum(session.seq)
        if (seq > 0) {
          const ev = safe(() => session.eventAt(seq - 1), null, null, '')
          if (ev && typeof ev.time === 'number') lastActivity = ev.time
        }
        let title = ''
        if (titlesSvc) {
          const t = safe(() => titlesSvc.get(session), null, null, '')
          if (t) title = asText(t.title)
        }
        const owner = agents.find((a) => String(a.id) === id)
        let goal = null
        if (goalsSvc && owner) {
          const g = safe(() => goalsSvc.get(owner), null, null, '')
          if (g) {
            goal = {
              phase: asText(g.phase),
              activation: asText(g.activation),
              roundsStarted: asNum(g.roundsStarted),
              maxGoalRounds: asNum(g.maxGoalRounds),
              objective: asText(g.objective).slice(0, 200),
              blockedCode: g.blockedReason ? asText(g.blockedReason.code) : '',
              blockedMessage: g.blockedReason ? asText(g.blockedReason.message).slice(0, 400) : '',
            }
          }
        }
        out.sessions.push({
          id,
          title,
          running: runningById.get(id) === true,
          activeJobs: activeByOwner.get(id) || 0,
          origin: asText(header.origin),
          parent: header.parentSession ? String(header.parentSession) : '',
          depth: asNum(header.delegationDepth),
          preset: asText(header.agentPreset),
          createdAt: asNum(header.createdAt),
          lastActivity,
          live: Boolean(owner),
          goal,
        })
      } catch { /* 同上 */ }
    }
    out.sessions.sort((a, b) => b.lastActivity - a.lastActivity)

    if (subagentsSvc) {
      for (const a of agents) {
        let rootId = ''
        try { rootId = String(a.id) } catch { rootId = '' }
        if (!rootId) continue
        let list = null
        try {
          list = await subagentsSvc.listDescendants(rootId)
        } catch {
          list = null // 投影未挂载时会抛；这是可接受的缺失，不算采集错误
        }
        if (!Array.isArray(list)) continue
        for (const entry of list) {
          try {
            if (entry.kind !== 'child') continue
            out.subagents.push({
              id: String(entry.id),
              parent: entry.parentId ? String(entry.parentId) : '',
              depth: asNum(entry.depth),
              activity: asText(entry.activity),
              mode: asText(entry.mode),
              label: asText(entry.label),
            })
          } catch { /* 同上 */ }
        }
        if (out.subagents.length > 250) break
      }
      // 每个 root 的 listDescendants 已经返回整棵树，跨 root 会重复。
      const seenSub = new Set()
      out.subagents = out.subagents.filter((x) => {
        if (seenSub.has(x.id)) return false
        seenSub.add(x.id)
        return true
      })
    }

    out.pending = Array.from(approvals.values()).concat(Array.from(questions.values()))
    out.pending.sort((a, b) => a.at - b.at)
    out.workflows = Array.from(runs.values())

    out.totals.sessions = out.sessions.length
    out.totals.running = out.sessions.filter((x) => x.running).length
    out.totals.jobs = out.jobs.length
    out.totals.jobsRunning = out.jobs.filter((x) => isActiveJob(x.status)).length
    out.totals.subagents = out.subagents.length
    out.totals.workflows = out.workflows.length
    out.totals.pending = out.pending.length
    return out
  }

  // snapshot() 一次要问一圈服务：jobs.list(每个 agent 一次) + sessions.list
  // + 每个会话的 eventAt/title/goal + 每个 agent 的 listDescendants。手机页面
  // 每 3 秒轮询，桌面面板和多个标签页还会各来一份，叠加起来相当可观。
  //
  // 所以在这里收口：TTL 内共享同一份采集结果，并发请求共用同一个 Promise
  // （不是各算各的），并给出 ETag —— 内容没变就让客户端走 304 只收一个头。
  const SNAPSHOT_TTL_MS = 2000
  let cached = null
  let inflight = null

  async function snapshotCached() {
    const now = Date.now()
    if (cached !== null && now - cached.at < SNAPSHOT_TTL_MS) return cached
    if (inflight !== null) return inflight
    inflight = (async () => {
      const payload = await snapshot()
      const json = JSON.stringify(payload)
      // 回给客户端的内容仍然带 generatedAt（页面要用它算时长），
      // 但 ETag 不能受它影响 —— 见 etagOf 的注释。
      cached = { at: Date.now(), json, etag: etagOf(payload) }
      return cached
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  function send(res, status, type, body, extra) {
    try {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
        'x-content-type-options': 'nosniff',
        ...(extra || {}),
      })
      res.end(body)
    } catch {
      try { res.end('') } catch { /* 响应已断开 */ }
    }
  }

  if (webServer !== undefined) {
    // ── 交付文件只读出口 ────────────────────────────────────────────────────
    //
    // 两个用途：手机页里**直接看到**模型产出的图（而不是"下载了一个文件"），
    // 以及看到 PDF 这类交付物的名字 / 大小 / 类型。两条来源：
    //   ?id=<attachmentId>  宿主 attachments 服务里的对象，字节由它校验完整性；
    //   ?path=<绝对路径>    白名单根目录下的文件，符号链接与 `..` 都会被拒。
    // ?info=1 只回元数据 —— 文件卡片先拿它填名字与大小，不下整份字节。
    //
    // 只读、不接受请求体、不列目录。白名单根默认只有宿主附件库与交付 outbox，
    // 可用 DSH_TASKWATCH_ROOTS 覆盖（`;` 分隔）。
    const fileRoots = rootsFrom(process.env.DSH_TASKWATCH_ROOTS, homedir())
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/file',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const fail = (error, status, extra) => send(
          res,
          status,
          'application/json; charset=utf-8',
          JSON.stringify({ error, ...(extra || {}) }),
        )
        const wantInfo = url.searchParams.get('info') === '1'
        const id = (url.searchParams.get('id') || '').trim()

        if (id) {
          const store = ctx.get('attachments')
          if (!store) { fail('host-without-attachments', 501); return }
          const label = (url.searchParams.get('name') || '').replace(/["\\\r\n]/g, '_')

          if (url.searchParams.get('kind') === 'file') {
            try {
              const chunks = []
              let total = 0
              for await (const chunk of store.readFileStream({ attachmentId: id })) {
                total += chunk.length
                if (total > MAX_BYTES) { fail('too-large', 413, { bytes: total }); return }
                chunks.push(Buffer.from(chunk))
              }
              const body = Buffer.concat(chunks)
              if (wantInfo) {
                send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
                  name: label || id, bytes: body.length, mime: 'application/octet-stream', kind: 'file',
                }))
                return
              }
              send(res, 200, 'application/octet-stream', body, {
                'cache-control': 'private, max-age=300',
                'content-disposition': dispositionFor('application/octet-stream', label || id),
              })
            } catch (e) {
              fail('attachment-read-failed', 404, { detail: why(e) })
            }
            return
          }

          try {
            const got = await store.readImage({ attachmentId: id })
            const ref = got.ref || {}
            if (wantInfo) {
              send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
                name: ref.name || id,
                bytes: got.data.length,
                mime: ref.mediaType || 'image/png',
                kind: 'image',
                width: ref.width,
                height: ref.height,
              }))
              return
            }
            send(res, 200, ref.mediaType || 'image/png', Buffer.from(got.data), {
              'cache-control': 'private, max-age=300',
              'content-disposition': dispositionFor(ref.mediaType || 'image/png', ref.name || id),
            })
          } catch (e) {
            fail('attachment-read-failed', 404, { detail: why(e) })
          }
          return
        }

        const hit = resolveTarget(url.searchParams.get('path') || '', fileRoots, homedir())
        if (!hit.ok) {
          fail(hit.error, hit.error === 'too-large' ? 413 : 403, { bytes: hit.bytes, ext: hit.ext })
          return
        }
        if (wantInfo) {
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify(infoOf(hit)))
          return
        }
        let body
        try {
          body = readFileSync(hit.abs)
        } catch (e) {
          fail('read-failed', 500, { detail: why(e) })
          return
        }
        send(res, 200, hit.mime, body, {
          // 令牌保护的私有内容：让手机侧短暂缓存，别每次滚动都重下一遍。
          'cache-control': 'private, max-age=300',
          'content-disposition': dispositionFor(hit.mime, hit.name),
        })
      },
    }), 'in-hand: file route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/data',
      handler: async (req, res) => {
        let entry
        try {
          entry = await snapshotCached()
        } catch (e) {
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ error: why(e) }))
          return
        }
        // 内容没变就回 304：手机上省下的是整份 JSON 的流量，只交换一个头。
        // 注意这里必须用 no-cache 而不是 no-store —— no-store 会让浏览器
        // 根本不保存响应，也就永远不会带 If-None-Match 回来。
        const inm = req.headers ? req.headers['if-none-match'] : undefined
        if (typeof inm === 'string' && inm === entry.etag) {
          send(res, 304, 'application/json; charset=utf-8', '', {
            etag: entry.etag,
            'cache-control': 'no-cache',
          })
          return
        }
        send(res, 200, 'application/json; charset=utf-8', entry.json, {
          etag: entry.etag,
          'cache-control': 'no-cache',
        })
      },
    }), 'in-hand: data route')

    // 某个会话的最近对话（只读）。
    //
    // 为什么可能读不到：ctx.sessions 是内存存储，get(id) 只对活着的会话有效。
    // 已落盘但未加载进内存的会话这里拿不到 —— 这种情况显式报错，绝不假装"没有消息"，
    // 否则会让人以为那个会话真的没说话，而它只是没被加载。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/session',
      handler: async (req, res) => {
        const out = { id: '', live: false, total: 0, messages: [], error: null }
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const id = url.searchParams.get('id') || ''
          const raw = Number(url.searchParams.get('limit'))
          const limit = Math.min(60, Math.max(1, isFinite(raw) && raw > 0 ? Math.floor(raw) : 20))
          out.id = id
          if (!id) {
            out.error = '缺少 id 参数'
          } else {
            const store = ctx.get('sessions')
            const session = store !== undefined ? store.get(id) : undefined
            if (session === undefined) {
              out.error = '这个会话不在内存里（已落盘但未加载的会话读不到）'
            } else {
              out.live = true
              // deriveMessages() 产出的 Message 不带时间，时间从原始事件按 message id 建索引。
              const at = new Map()
              for (const ev of session.snapshotEvents()) {
                const d = ev && ev.data
                if (!d) continue
                if (ev.type === 'user/message' && d.id) at.set(String(d.id), ev.time)
                else if (ev.type === 'assistant/message' && d.message && d.message.id) at.set(String(d.message.id), ev.time)
              }
              const picked = []
              for (const m of session.deriveMessages()) {
                if (!m || m.role === 'system') continue
                const text = blocksText(m.content)
                const tools = blocksTools(m.content)
                if (!text && !tools.length) continue
                picked.push({
                  role: m.role === 'user' ? 'user' : 'assistant',
                  text: text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text,
                  tools,
                  at: at.get(String(m.id)) || 0,
                })
              }
              out.total = picked.length
              out.messages = picked.slice(-limit)
            }
          }
        } catch (e) {
          out.error = why(e)
        }
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(out))
      },
    }), 'in-hand: session route')

    // ---- 对话（远程控制）----------------------------------------------------
    //
    // 为什么存在：只读状态板能告诉你「卡住了」，但你人不在电脑前就做不了任何事。
    // 这一组路由把 DSH **自己的**会话运行时接到手机上 —— 发消息、流式收回复、停止、
    // 列/建会话、切模型 —— 全部转调 sessionController。插件不碰 LLM、不碰流式协议，
    // 所以上游怎么演进，这里跟着就有。
    //
    // 安全边界（重要）：这些路由自己不鉴权，只监听回环。对外**唯一**入口是中继，
    // 由它承担 TLS + basic auth + 应用层令牌三层。所以：
    //   新增一条路由 = 新增一份对外能力。想收回哪个能力，把对应注册删掉即可。
    // 它们是**写**入口：prompt 等于在宿主上驱动 agent（默认 danger-full-access），
    // 与只读路由不是一个量级，改动前请先想清楚。
    // sessionController 在**启动阶段之后**才发布，apply 期间 ctx.get 拿到的是
    // undefined（和当初 webServer 那个静默 404 是同一类陷阱，已实测踩过一次）。
    // 所以这里**不缓存服务实例**：每次请求再取一次。代价是一次 map 查找，换来的是
    // "路由永远注册得上" —— 缺服务时得到的是明确的错误 JSON，而不是一个费解的 404。
    let chatWarned = false
    const chatOf = () => {
      const svc = ctx.get('sessionController')
      if (svc === undefined) {
        if (!chatWarned) {
          chatWarned = true
          console.error('dsh-in-hand: 没有 sessionController 服务，对话接口会返回错误（只读页面不受影响）')
        }
        throw new Error('这个部署没有 sessionController 服务，对话功能不可用')
      }
      return svc
    }
    {
      const json = (res, status, obj) =>
        send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj))

      // 读请求体，带硬上限：一个超大 body 不该把宿主内存吃掉。
      const readRaw = (req, limit) => new Promise((resolve, reject) => {
        let size = 0
        const chunks = []
        req.on('data', (c) => {
          size += c.length
          if (size > limit) {
            reject(new Error('请求体过大'))
            try { req.destroy() } catch { /* 已断开 */ }
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })

      const readBytes = async (req, limit, signal, measure) => {
        const chunks = []
        for await (const chunk of limitedChunks(req, limit, signal, measure)) chunks.push(chunk)
        return Buffer.concat(chunks)
      }

      const limitedChunks = async function* (req, limit, signal, measure) {
        signal.throwIfAborted()
        for await (const chunk of req) {
          signal.throwIfAborted()
          const part = Buffer.from(chunk)
          measure.bytes += part.length
          if (measure.bytes > limit) throw new Error('附件不能超过 32 MB')
          yield part
        }
        signal.throwIfAborted()
        if (req.complete === false) throw new Error('上传已中断')
      }

      const readJson = async (req) => {
        const raw = await readRaw(req, 32 * 1024)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      }

      const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
      const pruneUploads = () => {
        const cutoff = Date.now() - UPLOAD_TTL_MS
        for (const [key, value] of pendingUploads) {
          if (!value.sending && value.createdAt <= cutoff) pendingUploads.delete(key)
        }
      }
      const checkUploadRoom = (sessionId) => {
        pruneUploads()
        let count = 0
        for (const value of pendingUploads.values()) if (value.sessionId === sessionId) count++
        if (pendingUploads.size >= MAX_PENDING_UPLOADS || count >= MAX_SESSION_UPLOADS) {
          throw new Error('待发送附件过多，请先发送已有附件或稍后再试')
        }
      }
      const rememberUpload = (key, value) => {
        checkUploadRoom(value.sessionId)
        pendingUploads.set(key, value)
      }
      const requireUploadAgent = async (sessionId) => {
        const service = chatOf()
        if (typeof service.resolveAgent !== 'function') throw new Error('宿主缺少附件会话校验服务')
        const found = await service.resolveAgent(sessionId)
        if (found && found.agent) return found.agent
        // Older session-controller builds return Agent directly; current public
        // API returns { agent } or { error }.
        if (found && found.error) throw found.error
        if (found && found.session) return found
        throw new Error('会话不存在')
      }
      const requestLifetime = (req, res) => {
        const controller = new AbortController()
        const abort = () => controller.abort(new Error('请求已中断'))
        const closed = () => { if (!res.writableEnded) abort() }
        req.on('aborted', abort)
        res.on('close', closed)
        return {
          signal: controller.signal,
          dispose() { req.off('aborted', abort); res.off('close', closed) },
        }
      }
      const requirePost = (req, res, type) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          json(res, 405, { error: '只接受 POST' })
          return false
        }
        if (String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== type) {
          json(res, 415, { error: '请求必须使用 ' + type })
          return false
        }
        return true
      }

      // 原始二进制上传：文件由 fileUploads 按 Session 暂存，图片由 attachments
      // 先做图像准入再用一次性 token 交给后续 prompt。请求体硬上限沿用交付文件
      // 的 32 MiB 边界，名称只作为显示名传给宿主，绝不解释为路径。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/upload',
        handler: async (req, res) => {
          if (!requirePost(req, res, 'application/octet-stream')) return
          if (Number(req.headers['content-length']) > MAX_BYTES) {
            json(res, 413, { error: '附件不能超过 32 MB' })
            return
          }
          const lifetime = requestLifetime(req, res)
          let active = false
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const sessionId = asText(url.searchParams.get('sessionId')).trim()
            const kind = asText(url.searchParams.get('kind')).trim().toLowerCase()
            const name = asText(url.searchParams.get('name')).trim().slice(0, 200)
            const mime = asText(url.searchParams.get('mime')).trim().toLowerCase()
            if (!sessionId) throw new Error('缺少 sessionId')
            if (kind !== 'image' && kind !== 'file') throw new Error('上传类型无效')
            if (activeUploads >= 8) throw new Error('正在上传的附件过多，请稍后重试')
            activeUploads++; active = true
            checkUploadRoom(sessionId)
            await requireUploadAgent(sessionId)
            lifetime.signal.throwIfAborted()
            const measure = { bytes: 0 }
            if (kind === 'image') {
              if (!IMAGE_TYPES.has(mime)) throw new Error('只支持 PNG、JPEG、WEBP、GIF 图片')
              const store = ctx.get('attachments')
              if (!store || typeof store.saveImage !== 'function') throw new Error('宿主没有图片附件服务')
              const ref = await store.saveImage({ data: await readBytes(req, MAX_BYTES, lifetime.signal, measure), mediaType: mime, ...(name ? { name } : {}) })
              lifetime.signal.throwIfAborted()
              if (!ref || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_BYTES) throw new Error('图片处理后超过 32 MB 或附件信息无效')
              const token = randomUUID()
              rememberUpload('image:' + token, { sessionId, kind, ref, bytes: Math.max(measure.bytes, ref.bytes), createdAt: Date.now() })
              json(res, 200, { ok: true, upload: {
                kind: 'image', token, name: ref.name || name || '图片', bytes: ref.bytes,
                mime: ref.mediaType, width: ref.width, height: ref.height,
              } })
              return
            }
            const uploads = ctx.get('fileUploads')
            if (!uploads || typeof uploads.uploadStream !== 'function') throw new Error('宿主没有文件上传服务')
            const value = await uploads.uploadStream({
              sessionId,
              data: limitedChunks(req, MAX_BYTES, lifetime.signal, measure),
              signal: lifetime.signal,
              ...(name ? { name } : {}),
            })
            lifetime.signal.throwIfAborted()
            if (!value || !asText(value.receiptId) || !value.file || value.file.bytes !== measure.bytes) throw new Error('宿主返回了无效的文件上传信息')
            rememberUpload('file:' + value.receiptId, { sessionId, kind, ref: value.file, bytes: measure.bytes, createdAt: Date.now() })
            json(res, 200, { ok: true, upload: {
              kind: 'file', receiptId: String(value.receiptId),
              name: value.file && value.file.name ? value.file.name : name || '文件',
              bytes: value.file && value.file.bytes ? value.file.bytes : 0,
            } })
          } catch (e) {
            if (!res.destroyed && !res.writableEnded) json(res, 200, { error: why(e) })
          } finally {
            if (active) activeUploads--
            lifetime.dispose()
          }
        },
      }), 'in-hand: chat upload route')

      const ctl = () => new AbortController()

      // 会话列表。标题只对**活着的**会话可得（sessionTitle 需要一个 Session 对象），
      // 冷会话退化成 cwd 目录名或短 id —— 不假装有标题，也不为此去逐个加载会话。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/sessions',
        handler: async (req, res) => {
          try {
            const signal = ctl().signal
            const value = await chatOf().list({}, signal)
            const store = ctx.get('sessions')
            const titles = ctx.get('sessionTitle')
            const rows = []
            for (const s of (value && value.items) || []) {
              const id = String(s.sessionId)
              // 子代理会话不出现在手机上：它们是宿主内部的干活会话，不需要人进去说话，
              // 而且没有父地址连日志都读不了（分页会报 "require their durable parent
              // address"）。列表里混进来只会让"该点哪个"变得更难。
              const origin = asText(s.origin)
              if (origin === 'subagent') continue
              const live = store !== undefined ? store.get(id) : undefined
              let title = ''
              if (live !== undefined && titles !== undefined) {
                const snap = titles.get(live)
                if (snap && snap.title) title = String(snap.title)
              }
              const cwd = asText(s.cwd)
              rows.push({
                id,
                title,
                fallback: title ? '' : (cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : id.slice(0, 8)),
                running: !!s.running,
                blank: !!s.blank,
                updatedAt: asNum(s.updatedAt),
                cwd,
                origin,
                depth: asNum(s.delegationDepth),
              })
            }
            json(res, 200, { sessions: rows })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat sessions route')

      // ── 手机能选的工作区 ──────────────────────────────────────────────────
      //
      // 这是"把宿主的哪块磁盘交给公网客户端"这件事的一部分，所以设计上只有一条：
      // **清单由服务端给，/chat/create 只采纳清单里逐字命中的那一条。**
      // 客户端可以发任意字符串，但发不进清单里的目录 —— 原来"刻意不接受客户端传 cwd"
      // 的取舍没有被放弃，只是从"完全不能选"变成"只能在服务端列出的里面选"。
      //
      // 三个来源：① 现有会话的 cwd（你最近在哪儿干活，天然是你认过的目录）
      //          ② 环境变量 DSH_TASKWATCH_WORKSPACES（`;` 分隔，覆盖固定候选）
      //          ③ 固定候选默认 D:\Projects —— 本机约定，装到别处请用环境变量改。
      // 不存在的目录不进清单（statSync 判过），iOS 上少一个点进去报错的入口。
      const wsEnv = asText(process.env.DSH_TASKWATCH_WORKSPACES).trim() || 'D:\\Projects'
      const workspaceList = async () => {
        const seen = new Set()
        const rows = []
        const add = (p, why) => {
          const raw = asText(p).trim().replace(/[\\/]+$/, '')
          if (!raw) return
          const key = raw.toLowerCase()
          if (seen.has(key)) return
          seen.add(key)
          try {
            if (!statSync(raw).isDirectory()) return
          } catch {
            return
          }
          rows.push({ path: raw, name: raw.split(/[\\/]/).pop() || raw, why })
        }
        try {
          const value = await chatOf().list({}, ctl().signal)
          for (const s of (value && value.items) || []) {
            if (asText(s.origin) === 'subagent') continue
            add(s.cwd, 'recent')
          }
        } catch {
          // 会话列不出来就只给固定候选 —— 不为一个下拉框把接口整个搞失败。
        }
        for (const p of wsEnv.split(';')) add(p, 'pinned')
        return rows
      }

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/workspaces',
        handler: async (req, res) => {
          try {
            json(res, 200, { workspaces: await workspaceList() })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: workspaces route')

      // 新建会话。可以带 `workspace`（绝对路径），但必须命中上面那份清单。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/create',
        handler: async (req, res) => {
          try {
            const body = await readJson(req)
            const request = {}
            if (asText(body.agentPreset)) request.agentPreset = asText(body.agentPreset)
            let used = ''
            const want = asText(body.workspace).trim().replace(/[\\/]+$/, '')
            if (want) {
              const hit = (await workspaceList()).find((w) => w.path.toLowerCase() === want.toLowerCase())
              if (!hit) throw new Error('这个工作区不在服务端的候选清单里')
              request.cwd = hit.path
              used = hit.path
            }
            const value = await chatOf().create(request)
            json(res, 200, { ok: true, sessionId: String(value.sessionId), agentPreset: asText(value.agentPreset), workspace: used })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat create route')

      // 发消息。requestId 由宿主生成：客户端不该能决定请求身份。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/send',
        handler: async (req, res) => {
          if (!requirePost(req, res, 'application/json')) return
          const lifetime = requestLifetime(req, res)
          const locked = []
          try {
            const body = await readJson(req)
            const sessionId = asText(body.sessionId)
            const text = asText(body.text)
            if (!sessionId) throw new Error('缺少 sessionId')
            if (body.attachments !== undefined && !Array.isArray(body.attachments)) throw new Error('附件格式无效')
            const uploads = body.attachments || []
            if (uploads.length > 4) throw new Error('一次最多添加 4 个附件')
            if (!text.trim() && !uploads.length) throw new Error('消息不能为空')
            pruneUploads()
            let totalBytes = 0
            const seen = new Set()
            // 先原子校验/锁定整批元数据，再做异步读盘，失败时解锁而不消费。
            for (const item of uploads) {
              if (!item || typeof item !== 'object') throw new Error('附件格式无效')
              const kind = asText(item.kind)
              if (kind !== 'image' && kind !== 'file') throw new Error('附件类型无效')
              const key = kind + ':' + asText(kind === 'image' ? item.token : item.receiptId)
              const record = pendingUploads.get(key)
              if (!record || record.sessionId !== sessionId || record.kind !== kind) throw new Error('附件已失效或不属于当前会话，请重新上传')
              if (seen.has(key)) throw new Error('请勿重复添加同一个附件')
              if (record.sending) throw new Error('附件正在发送，请勿重复提交')
              seen.add(key)
              totalBytes += record.bytes
              if (totalBytes > MAX_BYTES) throw new Error('每条消息的附件总大小不能超过 32 MB')
              record.sending = true
              locked.push({ key, record, item })
            }
            const content = []
            if (text.trim()) content.push({ type: 'text', text })
            const agent = uploads.length ? await requireUploadAgent(sessionId) : null
            lifetime.signal.throwIfAborted()
            for (const { record, item } of locked) {
              if (record.kind === 'file') {
                const receiptId = asText(item.receiptId)
                const service = ctx.get('fileUploads')
                if (!service || typeof service.resolve !== 'function') throw new Error('宿主没有文件上传服务')
                const ref = service.resolve(agent, receiptId)
                if (!ref || ref.attachmentId !== record.ref.attachmentId || ref.bytes !== record.bytes) throw new Error('文件上传已失效，请重新上传')
                content.push({ type: 'file', receiptId })
                continue
              }
              if (record.kind === 'image') {
                const store = ctx.get('attachments')
                if (!store || typeof store.readImage !== 'function') throw new Error('宿主没有图片附件服务')
                const stored = await store.readImage(record.ref, lifetime.signal)
                lifetime.signal.throwIfAborted()
                content.push({
                  type: 'image', mediaType: stored.ref.mediaType,
                  data: Buffer.from(stored.data).toString('base64'),
                  ...(stored.ref.name ? { name: stored.ref.name } : {}),
                })
                continue
              }
            }
            const request = {
              requestId: randomUUID(),
              sessionId,
              mode: body.mode === 'steer' ? 'steer' : 'queue',
              content,
            }
            if (asText(body.timeZone)) request.clientTimeZone = asText(body.timeZone)
            const value = await chatOf().prompt(request, lifetime.signal)
            if (!value || value.accepted !== true) throw new Error('宿主未接收消息，请重试')
            for (const { key, record } of locked) if (pendingUploads.get(key) === record) pendingUploads.delete(key)
            if (!res.destroyed && !res.writableEnded) json(res, 200, { ok: true, accepted: true })
          } catch (e) {
            if (!res.destroyed && !res.writableEnded) json(res, 200, { error: why(e) })
          } finally {
            for (const { record } of locked) record.sending = false
            lifetime.dispose()
          }
        },
      }), 'in-hand: chat send route')

      // 停止当前轮。只中止这一轮，入队里还没跑的消息保留（服务端语义如此）。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/cancel',
        handler: async (req, res) => {
          try {
            const body = await readJson(req)
            const sessionId = asText(body.sessionId)
            if (!sessionId) throw new Error('缺少 sessionId')
            const value = await chatOf().cancel({ sessionId })
            json(res, 200, { ok: true, accepted: !!(value && value.accepted) })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat cancel route')

      // 会话日志的流式跟随（SSE）。
      //
      // follow() 返回的本来就是**为传输设计的 wire 帧**（SessionWireEvent.data 是
      // JsonValue），所以这里可以安全地逐帧 JSON.stringify —— 不需要、也不应该去
      // 触碰活对象。帧分三类：snapshot（开场快照）/ event（消息、工具调用）/ 
      // assistant-stream（逐字增量）。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/stream',
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const sessionId = url.searchParams.get('sessionId') || ''
          if (!sessionId) { json(res, 400, { error: '缺少 sessionId' }); return }
          const raw = Number(url.searchParams.get('maxMessages'))
          const maxMessages = Math.min(200, Math.max(10, isFinite(raw) && raw > 0 ? Math.floor(raw) : 60))

          const c = ctl()
          let closed = false
          res.on('close', () => { closed = true; c.abort() })

          try {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              // nginx 默认会缓冲响应，缓冲了流式就废了；这个头让它别缓冲。
              'x-accel-buffering': 'no',
            })
            res.write(': taskwatch stream\n\n')
            const frames = await chatOf().follow({
              address: { kind: 'session', sessionId },
              maxMessages,
              assistantStream: true,
            }, c.signal)
            for await (const frame of frames) {
              if (closed) break
              res.write('data: ' + JSON.stringify(frame) + '\n\n')
            }
          } catch (e) {
            if (!closed) {
              try {
                res.write('data: ' + JSON.stringify({ type: 'taskwatch-error', message: why(e) }) + '\n\n')
              } catch { /* 已断开 */ }
            }
          } finally {
            try { res.end() } catch { /* 已断开 */ }
          }
        },
      }), 'in-hand: chat stream route')

      // 会话用量：把「轮 / 步 / token/s / 缓存命中 / token 消耗 / 上下文占用」一次交给手机。
      // 优先读取 sessionController.projections() 的官方持久投影：它不需要激活会话，
      // 冷会话也能显示完整数字。旧宿主没有投影时，再退回 live 事件和 tokenMeter，
      // 但不会把估算值冒充成精确的 token 消耗。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/usage',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const sessionId = url.searchParams.get('sessionId') || ''
            if (!sessionId) throw new Error('缺少 sessionId')
            const chat = chatOf()
            const store = ctx.get('sessions')
            const live = store !== undefined ? store.get(sessionId) : undefined
            let baseline = null
            if (typeof chat.projections === 'function') {
              try { baseline = await chat.projections({ sessionId }, ctl().signal) } catch { baseline = null }
            }
            if (live === undefined && !baseline) { json(res, 200, { live: false }); return }
            const out = { live: true, turns: 0, steps: 0, toolCalls: 0 }
            const values = baseline && baseline.values && typeof baseline.values === 'object' ? baseline.values : {}
            const sessionStats = values.sessionStats
            const tokenUsage = values.tokenUsage
            const contextPressure = values.contextPressure
            const contextBreakdown = values.contextBreakdown
            let hasSessionStats = false
            let hasTokenUsage = false

            if (sessionStats && typeof sessionStats === 'object') {
              hasSessionStats = true
              out.turns = asNum(sessionStats.turns)
              out.steps = asNum(sessionStats.steps)
              out.llmMs = asNum(sessionStats.llmMs)
              out.toolMs = asNum(sessionStats.toolMs)
              out.ttftMs = asNum(sessionStats.ttftMs)
              out.ttftSteps = asNum(sessionStats.ttftSteps)
              out.decodeMs = asNum(sessionStats.decodeMs)
              out.decodeTokens = asNum(sessionStats.decodeTokens)
              if (out.decodeMs > 0 && out.decodeTokens >= 0) {
                out.tokensPerSecond = out.decodeTokens * 1000 / out.decodeMs
              }
            }

            if (tokenUsage && typeof tokenUsage === 'object') {
              hasTokenUsage = true
              out.uncachedInputTokens = asNum(tokenUsage.uncachedInputTokens)
              out.outputTokens = asNum(tokenUsage.outputTokens)
              out.cacheReadTokens = asNum(tokenUsage.cacheReadTokens)
              out.cacheWriteTokens = asNum(tokenUsage.cacheWriteTokens)
            }

            if (contextPressure && typeof contextPressure === 'object') {
              const projected = typeof contextPressure.projectedTokens === 'number' && isFinite(contextPressure.projectedTokens)
                ? contextPressure.projectedTokens : null
              const pressure = typeof contextPressure.pressureTokens === 'number' && isFinite(contextPressure.pressureTokens)
                ? contextPressure.pressureTokens : null
              if (projected !== null || pressure !== null) {
                out.contextTokens = projected === null ? pressure : projected
              }
              out.contextWindow = asNum(contextPressure.contextWindow)
            }
            if (contextBreakdown && typeof contextBreakdown === 'object') {
              out.contextBreakdown = {
                systemTokens: asNum(contextBreakdown.systemTokens),
                toolsTokens: asNum(contextBreakdown.toolsTokens),
                messageTokens: asNum(contextBreakdown.messageTokens),
              }
            }

            // 这几个字段是前端详情与指标条共用的规范化口径。
            if (hasTokenUsage) {
              out.tokenConsumption = out.uncachedInputTokens + out.outputTokens +
                out.cacheReadTokens + out.cacheWriteTokens
              const promptTokens = out.uncachedInputTokens + out.cacheReadTokens + out.cacheWriteTokens
              if (promptTokens > 0) out.cacheHitPercent = 100 * out.cacheReadTokens / promptTokens
            }

            try {
              const events = typeof live.ownEvents === 'function' ? live.ownEvents() : []
              for (const e of events) {
                if (!e || !e.type) continue
                if (!hasSessionStats && e.type === 'turn/start') {
                  const n = asNum(e.data && e.data.turn)
                  if (n > out.turns) out.turns = n
                } else if (!hasSessionStats && e.type === 'step/start') out.steps += 1
                else if (e.type === 'tool/call') out.toolCalls += 1
              }
            } catch (e) { out.eventsError = why(e) }

            const meter = ctx.get('tokenMeter')
            if (meter !== undefined && typeof meter.measure === 'function') {
              try {
                const m = meter.measure(live)
                if (!hasTokenUsage) out.totalTokens = asNum(m.totalTokens)
                out.surfaceTokens = asNum(m.surfaceTokens)
                const base = m.baseline
                if (!hasTokenUsage && base && base.kind === 'usage' && base.usage) {
                  out.inputTokens = asNum(base.usage.inputTokens)
                  out.outputTokens = asNum(base.usage.outputTokens)
                  out.cacheReadTokens = asNum(base.usage.cacheReadTokens)
                  out.cacheWriteTokens = asNum(base.usage.cacheWriteTokens)
                  out.reasoningTokens = asNum(base.usage.reasoningTokens)
                  out.tokenConsumption = out.inputTokens + out.outputTokens + out.cacheReadTokens + out.cacheWriteTokens
                  const promptTokens = out.inputTokens + out.cacheReadTokens + out.cacheWriteTokens
                  if (promptTokens > 0) out.cacheHitPercent = 100 * out.cacheReadTokens / promptTokens
                }
              } catch (e) { out.meterError = why(e) }
            } else {
              out.noTokenMeter = true
            }

            if (typeof out.contextTokens !== 'number' && out.surfaceTokens) out.contextTokens = out.surfaceTokens
            if (!out.tokensPerSecond && out.decodeMs > 0 && out.outputTokens >= 0) {
              out.tokensPerSecond = out.outputTokens * 1000 / out.decodeMs
            }
            if (out.contextWindow > 0 && typeof out.contextTokens === 'number') {
              out.contextPercent = Math.min(100, 100 * out.contextTokens / out.contextWindow)
            }

            try {
              const rc = typeof live.requestContext === 'function' ? live.requestContext() : undefined
              if (rc) {
                out.provider = asText(rc.provider)
                out.model = asText(rc.model)
                if (!out.contextWindow) out.contextWindow = asNum(rc.contextWindow)
              }
            } catch (e) { /* 上下文窗口拿不到就不带，页面自然不显示百分比 */ }

            if (out.contextWindow > 0 && typeof out.contextTokens === 'number') {
              out.contextPercent = Math.min(100, 100 * out.contextTokens / out.contextWindow)
            }

            json(res, 200, out)
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat usage route')

      // 往更早翻历史。follow 的开场快照只给最近 maxMessages 条，
      // 再往前要按 beforeSeq 分页取。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/page',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const sessionId = url.searchParams.get('sessionId') || ''
            if (!sessionId) throw new Error('缺少 sessionId')
            const before = Number(url.searchParams.get('beforeSeq'))
            const through = Number(url.searchParams.get('throughSeq'))
            if (!isFinite(before) || before <= 0) throw new Error('缺少有效的 beforeSeq')
            const rawMax = Number(url.searchParams.get('maxMessages'))
            const request = {
              address: { kind: 'session', sessionId },
              throughSeq: isFinite(through) && through > 0 ? Math.floor(through) : Math.floor(before),
              beforeSeq: Math.floor(before),
              maxMessages: Math.min(200, Math.max(5, isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 40)),
            }
            const value = await chatOf().page(request, ctl().signal)
            json(res, 200, {
              records: value && value.records ? value.records : [],
              hasMore: !!(value && value.hasMore),
            })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat page route')

      // 冷会话的标题（批量）。
      //
      // 为什么需要它：SessionSummary 里**根本没有 title 字段**（只有 cwd），
      // 所以会话列表上 60 条全会显示成同一个目录名 —— 实测就是这个效果，
      // 列表完全没法用。真正的标题在事件日志的 session/title 帧里（靠近开头）。
      //
      // 分页语义是实测出来的（2026-09-22）：
      //   · throughSeq 不能超过该会话的 cursor，否则报 "through seq N is past cursor M"
      //     —— 而 M 正是需要的值，所以能一步重试；
      //   · beforeSeq 是**排他上界**，窗口是 [beforeSeq-maxMessages, beforeSeq)。
      // 于是先按 40 探一次（足够覆盖标题所在的开头），撞上 cursor 错误就用错误里
      // 给出的真实 cursor 重试。
      const findTitle = (value) => {
        for (const r of (value && value.records) || []) {
          const ev = r && r.event
          if (ev && ev.type === 'session/title' && ev.data && ev.data.title) return String(ev.data.title)
        }
        return ''
      }

      const pageTitle = async (sid, seq) => {
        const value = await chatOf().page({
          address: { kind: 'session', sessionId: sid },
          throughSeq: seq,
          beforeSeq: seq,
          maxMessages: 40,
        }, ctl().signal)
        return findTitle(value)
      }

      const probeTitle = async (sid) => {
        try {
          return await pageTitle(sid, 40)
        } catch (e) {
          const m = /past cursor (\d+)/.exec(why(e))
          if (!m) return ''
          try {
            return await pageTitle(sid, Number(m[1]))
          } catch {
            return ''
          }
        }
      }

      // 每个会话要 1~2 次持久化读（实测约 0.5s/次），8 个串行就是 7.5 秒 ——
      // 手机上打开列表等这么久不可接受。限并发 5，配合下面的缓存，
      // 只有第一次打开会花一两秒。
      const TITLE_TTL_MS = 10 * 60 * 1000
      const titleCache = new Map()

      const readTitle = async (sid) => {
        const hit = titleCache.get(sid)
        if (hit !== undefined && Date.now() - hit.at < TITLE_TTL_MS) return hit.title
        const title = await probeTitle(sid)
        // 空结果**不缓存**：会话刚建、标题还没生成时，缓存空值会让它十分钟都空着。
        if (title) titleCache.set(sid, { at: Date.now(), title })
        return title
      }

      const titlesFor = async (ids, limit) => {
        const out = {}
        let next = 0
        const worker = async () => {
          while (next < ids.length) {
            const id = ids[next++]
            const title = await readTitle(id)
            if (title) out[id] = title
          }
        }
        await Promise.all(new Array(Math.min(limit, ids.length)).fill(0).map(worker))
        return out
      }

      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/titles',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const ids = (url.searchParams.get('ids') || '')
              .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20)
            json(res, 200, { titles: await titlesFor(ids, 5) })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat titles route')

      // 可选模型目录（含每个 provider 的分组与默认项）。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/models',
        handler: async (req, res) => {
          try {
            const value = await chatOf().modelCatalog()
            const groups = []
            for (const g of (value && value.groups) || []) {
              const models = []
              for (const m of (g.models || [])) {
                models.push({
                  id: asText(m.id),
                  name: asText(m.name) || asText(m.id),
                  reasoning: m.reasoning
                    ? {
                        defaultEffort: asText(m.reasoning.defaultEffort),
                        efforts: (m.reasoning.efforts || []).map((e) => ({ id: asText(e.id), name: asText(e.name) || asText(e.id) })),
                      }
                    : null,
                })
              }
              groups.push({ id: asText(g.id), name: asText(g.name) || asText(g.id), models })
            }
            const d = (value && value.default) || {}
            json(res, 200, {
              default: { provider: asText(d.provider), model: asText(d.model) },
              groups,
            })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat models route')

      // 切换某个会话使用的模型。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/taskwatch/chat/model',
        handler: async (req, res) => {
          try {
            const body = await readJson(req)
            const sessionId = asText(body.sessionId)
            const provider = asText(body.provider)
            const model = asText(body.model)
            if (!sessionId) throw new Error('缺少 sessionId')
            if (!provider || !model) throw new Error('缺少 provider / model')
            const value = await chatOf().selectModel({ sessionId, provider, model })
            const sel = (value && value.selected) || {}
            json(res, 200, { ok: true, selected: { provider: asText(sel.provider), model: asText(sel.model) } })
          } catch (e) {
            json(res, 200, { error: why(e) })
          }
        },
      }), 'in-hand: chat model route')
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch',
      handler: (req, res) => send(res, 200, 'text/html; charset=utf-8', readPage()),
    }), 'in-hand: page route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/manifest.webmanifest',
      handler: (req, res) => send(res, 200, 'application/manifest+json; charset=utf-8', MANIFEST),
    }), 'in-hand: manifest route')

    // 脚本位于 /taskwatch/sw.js，故 scope '/taskwatch' 无需 Service-Worker-Allowed 头即可生效。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/sw.js',
      handler: (req, res) => send(res, 200, 'text/javascript; charset=utf-8', readSw(), {
        'service-worker-allowed': '/taskwatch',
      }),
    }), 'in-hand: service worker route')

    for (const [path, asset] of ICONS) {
      let body
      try {
        body = readFileSync(asset.file)
      } catch (e) {
        console.error('dsh-in-hand: 读不到图标 ' + asset.file + ' —— ' + why(e))
        continue
      }
      const content = body
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => send(res, 200, asset.type, content, {
          'cache-control': 'public, max-age=86400',
        }),
      }), 'in-hand: icon route ' + path)
    }
  } else {
    console.error('dsh-in-hand: 没有 webServer 服务，HTTP 路由与页面均未注册')
  }
}
