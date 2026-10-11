#!/usr/bin/env node
/**
 * Upload route contract tests.  These go through a real node:http server and
 * the actual route handlers; only DSH services are fakes, so no model is run.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { apply } from '../lib/index.js'

const routes = new Map()
const images = new Map()
const files = new Map()
const prompts = []
let failPrompt = false

const usageSession = {
  ownEvents() { return [{ type: 'tool/call', data: {} }] },
  requestContext() { return { provider: 'test', model: 'test-model', contextWindow: 1000 } },
}

const sessionController = {
  async resolveAgent(sessionId) {
    if (!['s1', 's2'].includes(sessionId)) throw new Error('session not found')
    return { agent: { id: sessionId, session: sessionId } }
  },
  async prompt(request) {
    if (failPrompt) throw new Error('prompt failed')
    prompts.push(request)
    return { accepted: true }
  },
  async projections({ sessionId }) {
    if (sessionId !== 's1') return null
    return { asOfSeq: 9, values: {
      sessionStats: { turns: 2, steps: 5, llmMs: 1000, toolMs: 250, ttftMs: 100, ttftSteps: 2, decodeMs: 500, decodeTokens: 20 },
      tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 0 },
      contextPressure: { projectedTokens: 400, contextWindow: 1000 },
      contextBreakdown: { systemTokens: 100, toolsTokens: 100, messageTokens: 200 },
    } }
  },
}

const attachments = {
  async saveImage(input) {
    const data = Buffer.from(input.data)
    const id = `image-${images.size + 1}`
    const ref = { attachmentId: id, name: input.name || id, mediaType: input.mediaType, bytes: data.length, width: 1, height: 1 }
    images.set(id, { ref, data })
    return ref
  },
  async readImage(ref) {
    const hit = images.get(ref.attachmentId)
    if (!hit) throw new Error('image missing')
    return { ref: hit.ref, data: hit.data }
  },
}

const fileUploads = {
  async uploadStream(request) {
    const parts = []
    for await (const part of request.data) parts.push(Buffer.from(part))
    const data = Buffer.concat(parts)
    const receiptId = `receipt-${files.size + 1}`
    const ref = { attachmentId: `file-${files.size + 1}`, name: request.name || receiptId, bytes: data.length, mediaType: 'text/plain' }
    files.set(receiptId, { sessionId: request.sessionId, ref, data })
    return { receiptId, file: ref }
  },
  resolve(agent, receiptId) {
    const hit = files.get(String(receiptId))
    return hit && hit.sessionId === agent.id ? hit.ref : undefined
  },
}

const webServer = { register(spec) { routes.set(spec.path, spec.handler) } }
const services = { webServer, sessionController, attachments, fileUploads, sessions: { get(id) { return id === 's1' ? usageSession : undefined } } }
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
const address = server.address()
const base = `http://127.0.0.1:${address.port}`

async function call(path, init = {}) {
  const response = await fetch(base + path, init)
  const body = await response.json()
  return { status: response.status, body }
}
async function upload(sessionId, kind, bytes = Buffer.from('x'), extra = {}) {
  return call(`/taskwatch/chat/upload?sessionId=${sessionId}&kind=${kind}&name=${encodeURIComponent(extra.name || 'x.txt')}${kind === 'image' ? '&mime=image/png' : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
  })
}

// A mixed image + file message reaches prompt with both admitted content kinds.
const image = await upload('s1', 'image', Buffer.from('png-bytes'), { name: 'a.png' })
const file = await upload('s1', 'file', Buffer.from('file-bytes'), { name: 'a.txt' })
assert.equal(image.body.ok, true)
assert.equal(file.body.ok, true)
let sent = await call('/taskwatch/chat/send', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's1', text: '看一下', attachments: [image.body.upload, file.body.upload] }),
})
assert.equal(sent.body.ok, true)
assert.equal(prompts.at(-1).content.filter((part) => part.type === 'image').length, 1)
assert.equal(prompts.at(-1).content.filter((part) => part.type === 'file').length, 1)

// Usage reads the durable projection: closed steps, decode speed, cumulative tokens,
// cache hit and projected context occupancy all keep their official semantics.
let usage = await call('/taskwatch/chat/usage?sessionId=s1')
assert.equal(usage.body.steps, 5)
assert.equal(usage.body.tokensPerSecond, 40)
assert.equal(usage.body.tokenConsumption, 100)
assert.equal(usage.body.cacheHitPercent, 87.5)
assert.equal(usage.body.contextPercent, 40)
assert.deepEqual(usage.body.contextBreakdown, { systemTokens: 100, toolsTokens: 100, messageTokens: 200 })

// Failed prompt keeps image token available for a retry; accepted prompt consumes it.
const retry = await upload('s1', 'image', Buffer.from('retry'), { name: 'retry.png' })
failPrompt = true
sent = await call('/taskwatch/chat/send', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's1', text: '重试', attachments: [retry.body.upload] }),
})
assert.match(String(sent.body.error), /prompt failed/)
failPrompt = false
sent = await call('/taskwatch/chat/send', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's1', text: '重试', attachments: [retry.body.upload] }),
})
assert.equal(sent.body.ok, true)

// A receipt/token is scoped to its upload session and cannot cross sessions.
const scoped = await upload('s1', 'image', Buffer.from('scope'), { name: 'scope.png' })
sent = await call('/taskwatch/chat/send', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's2', text: '越权', attachments: [scoped.body.upload] }),
})
assert.match(String(sent.body.error), /不属于当前会话/)

// Count and aggregate byte limits are server-side, independent of client slicing.
sent = await call('/taskwatch/chat/send', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's1', text: '太多', attachments: [1, 2, 3, 4, 5] }),
})
assert.match(String(sent.body.error), /最多添加 4/)
const large = Buffer.alloc(16 * 1024 * 1024 + 1, 7)
const largeA = await upload('s1', 'file', large, { name: 'large-a.bin' })
const largeB = await upload('s1', 'file', large, { name: 'large-b.bin' })
sent = await call('/taskwatch/chat/send', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 's1', text: '太大', attachments: [largeA.body.upload, largeB.body.upload] }),
})
assert.match(String(sent.body.error), /总大小不能超过 32 MB/)

// Method/content-type and missing-host failures are explicit.
let bad = await call('/taskwatch/chat/upload?sessionId=s1&kind=file', { method: 'GET' })
assert.equal(bad.status, 405)
bad = await call('/taskwatch/chat/upload?sessionId=s1&kind=file', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
assert.equal(bad.status, 415)
services.fileUploads = undefined
bad = await upload('s1', 'file', Buffer.from('missing-service'), { name: 'missing.txt' })
assert.match(String(bad.body.error), /文件上传服务/)

server.close()
console.log('upload route checks passed')
