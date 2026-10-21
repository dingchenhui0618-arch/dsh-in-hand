#!/usr/bin/env node
/**
 * 消息队列路由契约测试。
 *
 * 走真实的 node:http 服务与真实路由处理函数，只把 DSH 服务换成假实现 ——
 * 不调用模型、不碰真实会话。覆盖：
 *   - 无令牌访问（宿主不鉴权，401 由中继负责；这条测试钉住事实，不假装有鉴权）
 *   - 参数校验 / 方法 / content-type
 *   - 队列读取、排序稳定性、整份 id 列表的原子重排
 *   - now 的两种边界：在跑（steer 不打断）与空闲（steer 直接起一轮）
 *   - now + interrupt：cancel → 等 idle → steer；等不到就 409 且不发消息
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { apply } from '../lib/index.js'

const routes = new Map()
const services = {}

function message(id, text, source = 'user') {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: source, rpcId: 'rpc-' + id },
  }
}

function makeAgent(sessionId, { status = 'idle', nextTurn = [], nextStep = [] } = {}) {
  const lists = { 'next-turn': nextTurn.slice(), 'next-step': nextStep.slice() }
  return {
    id: sessionId,
    status,
    inbox: {
      get nextTurn() { return lists['next-turn'] },
      get nextStep() { return lists['next-step'] },
      splice(target, start, deleteCount, inserted) {
        const next = lists[target].toSpliced(start, deleteCount, ...inserted)
        const ids = new Set()
        const both = target === 'next-turn'
          ? [...next, ...lists['next-step']]
          : [...lists['next-turn'], ...next]
        for (const item of both) {
          if (ids.has(item.id)) throw new Error(`message "${item.id}" is already pending`)
          ids.add(item.id)
        }
        lists[target].splice(start, deleteCount, ...inserted)
        return lists[target]
      },
    },
  }
}

const agents = new Map()
const prompts = []
const events = []
let failPrompt = false
let cancelCount = 0
let cancelKeepsRunning = false

const sessionController = {
  async list() { return { items: [] } },
  async resolveAgent(sessionId) {
    const agent = agents.get(sessionId)
    if (!agent) throw new Error('session not found')
    return { agent }
  },
  async prompt(request) {
    events.push('prompt:' + request.mode)
    if (failPrompt) throw Object.assign(new Error('prompt failed'), { code: 'gateway/internal' })
    prompts.push(request)
    const agent = agents.get(request.sessionId)
    if (!agent) throw Object.assign(new Error('session not found'), { code: 'session/not-found' })
    const text = request.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    const item = message('sent-' + prompts.length, text)
    if (request.mode === 'steer') agent.inbox.splice('next-step', agent.inbox.nextStep.length, 0, [item])
    else agent.inbox.splice('next-turn', agent.inbox.nextTurn.length, 0, [item])
    return { accepted: true }
  },
  async cancel({ sessionId }) {
    events.push('cancel')
    cancelCount++
    const agent = agents.get(sessionId)
    if (agent && !cancelKeepsRunning) agent.status = 'idle'
    return { accepted: true }
  },
}

services.webServer = { register(spec) { routes.set(spec.path, spec.handler) } }
services.sessionController = sessionController
services.sessions = {
  get(id) { return ['s1', 's2', 's3', 's4', 's5'].includes(id) ? { id } : undefined },
}
services.sessionPersistence = {
  async stat(id) { return ['s1', 's2', 's3', 's4', 's5'].includes(id) ? { id } : undefined },
}
services.agents = {
  get(id) { return agents.get(id) },
  list() { return [...agents.values()] },
}

const ctx = {
  get(name) { return services[name] },
  effect(fn) { return fn() },
  on() { return () => {} },
}
apply(ctx)

const server = http.createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
  if (!handler) { res.writeHead(404); res.end(); return }
  Promise.resolve(handler(req, res)).catch((error) => { res.writeHead(500); res.end(String(error)) })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function call(path, init = {}) {
  const response = await fetch(base + path, init)
  const body = await response.json()
  return { status: response.status, body }
}
function post(path, body, headers = { 'content-type': 'application/json' }) {
  return call(path, { method: 'POST', headers, body: JSON.stringify(body) })
}

agents.set('s1', makeAgent('s1', {
  status: 'running',
  nextTurn: [message('m1', '第一条'), message('m2', '第二条')],
  nextStep: [message('m3', '插队中')],
}))
agents.set('s2', makeAgent('s2'))
agents.set('s3', makeAgent('s3', { status: 'running', nextTurn: [message('k1', '旧队列')] }))
agents.set('s4', makeAgent('s4', { status: 'running' }))
agents.set('s5', makeAgent('s5', { nextTurn: [message('g1', '目标轮次', 'goal-round')] }))

// ── 读队列 ────────────────────────────────────────────────────────────────
// 宿主自己不鉴权：不带任何令牌也能读（401 由中继那层负责，见 README）。
let got = await call('/taskwatch/chat/queue?sessionId=s1')
assert.equal(got.status, 200)
assert.equal(got.body.running, true)
assert.deepEqual(got.body.items.map((x) => x.id), ['m1', 'm2'])
assert.deepEqual(got.body.steering.map((x) => x.id), ['m3'])
assert.equal(got.body.items[0].text, '第一条')
assert.deepEqual(got.body.counts, { queued: 2, steering: 1 })
assert.equal(got.body.truncated, false)

assert.equal((await call('/taskwatch/chat/queue')).status, 400)
assert.equal((await call('/taskwatch/chat/queue?sessionId=missing')).status, 404)

// 会话存在但已冷（没有 live agent）：队列不可用，不能假装空队列。
services.sessions.get = ((original) => (id) => (id === 'cold1' ? { id } : original(id)))(services.sessions.get)
got = await call('/taskwatch/chat/queue?sessionId=cold1')
assert.equal(got.status, 409)
assert.equal(got.body.code, 'queue-unavailable')

// 非 GET 一律 405，不新增只写一半的路由。
assert.equal((await call('/taskwatch/chat/queue?sessionId=s1', { method: 'POST' })).status, 405)

// ── 重排 ──────────────────────────────────────────────────────────────────
got = await post('/taskwatch/chat/queue/reorder', { sessionId: 's1', ids: ['m2', 'm1'] })
assert.equal(got.status, 200)
assert.equal(got.body.changed, true)
assert.deepEqual(agents.get('s1').inbox.nextTurn.map((x) => x.id), ['m2', 'm1'])
// steering 不参与排序，也不被这次重排改动。
assert.deepEqual(agents.get('s1').inbox.nextStep.map((x) => x.id), ['m3'])

// 同一顺序再次提交是幂等的（changed=false），不制造多余的 inbox splice。
got = await post('/taskwatch/chat/queue/reorder', { sessionId: 's1', ids: ['m2', 'm1'] })
assert.equal(got.status, 200)
assert.equal(got.body.changed, false)
assert.deepEqual(agents.get('s1').inbox.nextTurn.map((x) => x.id), ['m2', 'm1'])

// 排回去，验证两个方向都稳定。
got = await post('/taskwatch/chat/queue/reorder', { sessionId: 's1', ids: ['m1', 'm2'] })
assert.equal(got.body.changed, true)
assert.deepEqual(agents.get('s1').inbox.nextTurn.map((x) => x.id), ['m1', 'm2'])

// 少了 / 多了 / 重复 / 不是数组：分别是 409 queue-changed 与 400。
got = await post('/taskwatch/chat/queue/reorder', { sessionId: 's1', ids: ['m1'] })
assert.equal(got.status, 409)
assert.equal(got.body.code, 'queue-changed')
assert.deepEqual(got.body.current, ['m1', 'm2'])
got = await post('/taskwatch/chat/queue/reorder', { sessionId: 's1', ids: ['m1', 'm2', 'm9'] })
assert.equal(got.status, 409)
got = await post('/taskwatch/chat/queue/reorder', { sessionId: 's1', ids: ['m1', 'm1'] })
assert.equal(got.status, 400)
got = await post('/taskwatch/chat/queue/reorder', { sessionId: 's1', ids: 'm1' })
assert.equal(got.status, 400)
// 把 steering 消息混进 nextTurn 的 id 列表也会被当作集合不符。
got = await post('/taskwatch/chat/queue/reorder', { sessionId: 's1', ids: ['m1', 'm3'] })
assert.equal(got.status, 409)

// 队列里有目标轮次 / 子代理 / 提问回复这类非用户消息：不碰，明确 409。
got = await post('/taskwatch/chat/queue/reorder', { sessionId: 's5', ids: ['g1'] })
assert.equal(got.status, 409)
assert.equal(got.body.code, 'queue-unavailable')
assert.deepEqual(agents.get('s5').inbox.nextTurn.map((x) => x.id), ['g1'])

// 方法 / content-type 与 /chat/send 同一套：POST + application/json。
assert.equal((await call('/taskwatch/chat/queue/reorder', { method: 'GET' })).status, 405)
assert.equal((await post('/taskwatch/chat/queue/reorder', {}, { 'content-type': 'text/plain' })).status, 415)
assert.equal((await post('/taskwatch/chat/queue/reorder', { sessionId: 'missing', ids: ['x'] })).status, 404)
assert.equal((await post('/taskwatch/chat/queue/reorder', { sessionId: 'cold1', ids: ['x'] })).status, 409)

// 宿主缺 agents 服务：501，而不是 404 或空队列。
services.agents = undefined
assert.equal((await call('/taskwatch/chat/queue?sessionId=s1')).status, 501)
assert.equal((await post('/taskwatch/chat/queue/reorder', { sessionId: 's1', ids: ['m1', 'm2'] })).status, 501)
services.agents = { get(id) { return agents.get(id) }, list() { return [...agents.values()] } }

// ── now 的语义边界 ────────────────────────────────────────────────────────
// 在跑：now 走 steer（进 nextStep，排到本轮队列前），不 cancel、不打断工具调用。
prompts.length = 0
events.length = 0
cancelCount = 0
got = await post('/taskwatch/chat/send', { sessionId: 's1', text: '插队', now: true })
assert.equal(got.status, 200)
assert.equal(got.body.ok, true)
assert.equal(prompts.at(-1).mode, 'steer')
assert.equal(cancelCount, 0)
assert.deepEqual(agents.get('s1').inbox.nextTurn.map((x) => x.id), ['m1', 'm2'])
assert.equal(agents.get('s1').inbox.nextStep.at(-1).content[0].text, '插队')

// 空闲：同一个 now 仍然有效 —— steer 会唤醒 agent，直接起一轮，不需要 cancel。
got = await post('/taskwatch/chat/send', { sessionId: 's2', text: '空闲也发', now: true })
assert.equal(got.status, 200)
assert.equal(prompts.at(-1).mode, 'steer')
assert.equal(cancelCount, 0)
assert.equal(agents.get('s2').inbox.nextStep.at(-1).content[0].text, '空闲也发')

// 普通发送还是 queue，不能因为 now 的改动把默认语义换了。
got = await post('/taskwatch/chat/send', { sessionId: 's2', text: '普通排队' })
assert.equal(got.status, 200)
assert.equal(prompts.at(-1).mode, 'queue')
assert.equal(agents.get('s2').inbox.nextTurn.at(-1).content[0].text, '普通排队')

// now + interrupt：先 cancel，等 agent 真正 idle 之后再 steer。
prompts.length = 0
events.length = 0
cancelCount = 0
got = await post('/taskwatch/chat/send', { sessionId: 's3', text: '打断再发', now: true, interrupt: true })
assert.equal(got.status, 200)
assert.equal(cancelCount, 1)
assert.deepEqual(events, ['cancel', 'prompt:steer'])
assert.equal(prompts.at(-1).mode, 'steer')
// cancel 保留了旧队列；新消息进 nextStep（steering lane），先于保留的 nextTurn。
assert.deepEqual(agents.get('s3').inbox.nextTurn.map((x) => x.id), ['k1'])
assert.equal(agents.get('s3').inbox.nextStep.at(-1).content[0].text, '打断再发')

// 停不下来：2 秒后 409，消息不发出、队列不动。这条要真的等 2 秒。
prompts.length = 0
events.length = 0
cancelCount = 0
cancelKeepsRunning = true
got = await post('/taskwatch/chat/send', { sessionId: 's4', text: '发不出去', now: true, interrupt: true })
assert.equal(got.status, 409)
assert.equal(got.body.code, 'interrupt-timeout')
assert.equal(cancelCount, 1)
assert.equal(prompts.length, 0)
assert.deepEqual(agents.get('s4').inbox.nextTurn, [])
cancelKeepsRunning = false
agents.get('s4').status = 'idle'

// now 请求在宿主拒绝时可分辨（502 + code）；老写法仍保持 200 + {error}。
failPrompt = true
got = await post('/taskwatch/chat/send', { sessionId: 's2', text: '会失败', now: true })
assert.equal(got.status, 502)
assert.equal(got.body.code, 'host-rejected')
got = await post('/taskwatch/chat/send', { sessionId: 's2', text: '会失败' })
assert.equal(got.status, 200)
assert.match(String(got.body.error), /prompt failed/)
failPrompt = false

server.close()
console.log('queue route checks passed')
