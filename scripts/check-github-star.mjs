#!/usr/bin/env node
/**
 * v1.8.23：点星改为 GitHub OAuth Device Flow 的契约测试。
 *
 * 全程不碰真 GitHub：本地起一个假 GitHub（POST /login/device/code、
 * POST /login/oauth/access_token、PUT /user/starred/...），用注入的
 * fetchImpl / 全局 fetch 拦截把三个真实 URL 指过去。
 *
 * 六组断言：
 *   1. 正常链路：start → user_code 形如 XXXX-XXXX → pending → token →
 *      假服务器收到 PUT，带 Authorization / User-Agent / Accept；页面拿到 starred。
 *   2. token 不外泄：start / poll 的任何响应体里都没有 token 或 device_code；
 *      lib/github-star.js 里没有任何 console 输出。
 *   3. 304 算成功且 already:true；404 返回失败文案、不崩。
 *   4. denied / expired 两条分支；slow_down 把 interval 加 5 秒。
 *   5. flowId 不存在 → flow-expired。
 *   6. 页面侧：授权面板存在、关闭会停轮询、slow_down 有 +5 常量、
 *      data-act="star" 不再直接链到仓库。
 */
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
const MODULE = join(ROOT, 'lib', 'github-star.js')
const SW = join(ROOT, 'lib', 'sw.js')
const home = mkdtempSync(join(tmpdir(), 'tw-github-star-'))
process.env.DSH_HOME = home
delete process.env.DSH_TASKWATCH_GITHUB_CLIENT_ID

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  PASS  ' + name) }
  else { failed++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')) }
}

const {
  GITHUB_STAR_CLIENT_ID, GITHUB_STAR_REPO,
  pollDeviceFlow, starRepo, startDeviceFlow,
} = await import('../lib/github-star.js')
const { apply } = await import('../lib/index.js')

// ── 假 GitHub + 宿主路由共用一个 HTTP 服务器 ───────────────────────────────
const routes = new Map()
const handlers = new Map()
const webServer = {
  register(spec) {
    routes.set(spec.path, spec.handler)
    return () => {}
  },
}
const ctx = {
  get(name) { return name === 'webServer' ? webServer : undefined },
  effect(fn) { return fn() },
  on(event, fn) { handlers.set(event, fn); return () => {} },
}
apply(ctx, {})

const TOKEN = 'test-token-do-not-leak-0123456789'
const DEVICE_CODE = 'device-code-secret-do-not-leak'
const USER_CODE = 'ABCD-1234'
const githubHits = []
const routeTexts = []
let pollQueue = []
let starStatus = 204

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}
function collect(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname
  if (path === '/login/device/code' || path === '/login/oauth/access_token' || path.startsWith('/user/starred/')) {
    const body = await collect(req)
    githubHits.push({ method: req.method, path, headers: req.headers, body })
    if (path === '/login/device/code') {
      json(res, 200, {
        device_code: DEVICE_CODE,
        user_code: USER_CODE,
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      })
      return
    }
    if (path === '/login/oauth/access_token') {
      const next = pollQueue.length ? pollQueue.shift() : { error: 'authorization_pending' }
      json(res, next.status || 200, next.body || next)
      return
    }
    if (path.startsWith('/user/starred/')) {
      res.writeHead(starStatus)
      res.end()
      return
    }
  }
  const handler = routes.get(path)
  if (!handler) { res.writeHead(404); res.end('not found'); return }
  Promise.resolve(handler(req, res)).catch(() => {
    if (!res.headersSent) json(res, 500, { ok: false, error: 'test handler failed' })
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port

// 只把 GitHub 的域名映射到本地假服务器；宿主自身的路由仍走真实 127.0.0.1。
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  let target = ''
  try {
    target = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
    const url = new URL(target)
    if (url.hostname === 'github.com' || url.hostname === 'api.github.com') {
      return realFetch(base + url.pathname + url.search, init)
    }
  } catch { /* 非 URL 的输入原样交给真实 fetch */ }
  return realFetch(input, init)
}
const injectedFetch = (target, init) => {
  const url = new URL(String(target))
  return realFetch(base + url.pathname + url.search, init)
}

let deviceCookie = ''
async function call(path, init = {}) {
  const headers = { ...(init.headers || {}) }
  if (deviceCookie) headers.cookie = deviceCookie
  const response = await realFetch(base + path, { ...init, headers })
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie() : []
  for (const line of setCookies) {
    const m = /^twd=([^;]+)/.exec(line)
    if (m) deviceCookie = 'twd=' + m[1]
  }
  const text = await response.text()
  let body = {}
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: response.status, body, text }
}
const postJson = (path, body) => call(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const resetHits = () => { githubHits.length = 0 }
const startRoute = async () => {
  const got = await postJson('/taskwatch/star/start', {})
  routeTexts.push(got.text)
  return got
}
const pollRoute = async (flowId) => {
  const got = await postJson('/taskwatch/star/poll', { flowId })
  routeTexts.push(got.text)
  return got
}

// ── 1. 正常链路（模块层用注入的 fetchImpl，路由层走真实 HTTP）──────────────
console.log('\n[1] 正常链路')
pollQueue = [{ access_token: TOKEN, token_type: 'bearer', scope: '' }]
starStatus = 204
resetHits()
const directStart = await startDeviceFlow({ clientId: 'test-client', fetchImpl: injectedFetch })
check('startDeviceFlow 返回 XXXX-XXXX 的 user_code', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(directStart.userCode), directStart.userCode)
check('startDeviceFlow 返回 verificationUri 与默认 interval=5',
  directStart.verificationUri === 'https://github.com/login/device' && directStart.interval === 5,
  JSON.stringify({ uri: directStart.verificationUri, interval: directStart.interval }))
const directPoll = await pollDeviceFlow({ clientId: 'test-client', deviceCode: directStart.deviceCode, fetchImpl: injectedFetch })
check('pollDeviceFlow 拿到 access_token', directPoll.status === 'ok' && directPoll.token === TOKEN,
  JSON.stringify({ status: directPoll.status }))
const directStar = await starRepo({ token: TOKEN, fetchImpl: injectedFetch })
check('starRepo 对 204 返回成功', directStar.ok === true && directStar.already === false, JSON.stringify(directStar))
const directHit = githubHits.find((h) => h.method === 'PUT')
check('模块层注入把 PUT 指到了假服务器', !!directHit && directHit.path === '/user/starred/' + GITHUB_STAR_REPO.owner + '/' + GITHUB_STAR_REPO.repo,
  directHit && directHit.path)
check('模块层的 device/code 请求带 client_id 与 scope=public_repo',
  /(?:^|&)client_id=test-client(?:&|$)/.test(githubHits.find((h) => h.path === '/login/device/code').body) &&
  /(?:^|&)scope=public_repo(?:&|$)/.test(githubHits.find((h) => h.path === '/login/device/code').body))

// 路由层：同一套假 GitHub，start → pending → token → starred
pollQueue = [{ error: 'authorization_pending' }, { access_token: TOKEN }]
starStatus = 204
resetHits()
const started = await startRoute()
check('POST /taskwatch/star/start 返回 200 + userCode',
  started.status === 200 && started.body.ok === true && started.body.userCode === USER_CODE,
  JSON.stringify(started.body))
check('start 响应带 flowId / verificationUri / expiresIn / interval',
  !!started.body.flowId && started.body.verificationUri === 'https://github.com/login/device' &&
  started.body.expiresIn === 900 && started.body.interval === 5,
  JSON.stringify({ hasFlow: !!started.body.flowId, interval: started.body.interval }))
const pending = await pollRoute(started.body.flowId)
check('第一次 poll 返回 pending（宿主不把 deviceCode 交给页面）',
  pending.status === 200 && pending.body.ok === true && pending.body.status === 'pending',
  JSON.stringify(pending.body))
const starred = await pollRoute(started.body.flowId)
check('第二次 poll 返回 starred / already:false',
  starred.status === 200 && starred.body.ok === true && starred.body.status === 'starred' &&
  starred.body.already === false, JSON.stringify(starred.body))
const putHit = githubHits.find((h) => h.method === 'PUT')
check('假服务器收到 PUT /user/starred/<owner>/<repo>',
  !!putHit && putHit.path === '/user/starred/' + GITHUB_STAR_REPO.owner + '/' + GITHUB_STAR_REPO.repo,
  putHit && putHit.path)
check('PUT 带 Authorization: Bearer、User-Agent、Accept',
  !!putHit && putHit.headers.authorization === 'Bearer ' + TOKEN &&
  /dsh-in-hand/.test(String(putHit.headers['user-agent'] || '')) &&
  /vnd\.github\+json/.test(String(putHit.headers.accept || '')),
  putHit && JSON.stringify({ auth: !!putHit.headers.authorization, ua: putHit.headers['user-agent'], accept: putHit.headers.accept }))
const tokenHit = githubHits.find((h) => h.path === '/login/oauth/access_token')
check('换 token 的 body 带 device_code 与 urn:ietf...grant-type',
  !!tokenHit && tokenHit.body.includes('device_code=' + encodeURIComponent(DEVICE_CODE)) &&
  tokenHit.body.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code'),
  tokenHit && tokenHit.body)

// ── 2. token 不外泄 ────────────────────────────────────────────────────────
console.log('\n[2] token 不外泄')
check('所有 /taskwatch/star/* 响应体里没有 token', routeTexts.every((t) => !t.includes(TOKEN)))
check('所有 /taskwatch/star/* 响应体里没有 deviceCode', routeTexts.every((t) => !t.includes(DEVICE_CODE)))
check('start 响应里没有 deviceCode 字段', started.body.deviceCode === undefined)
const moduleSource = readFileSync(MODULE, 'utf8')
check('lib/github-star.js 没有任何 console 输出', !/console\s*\./.test(moduleSource))
check('lib/github-star.js 里没有把 token 拼进 URL',
  !/[?&](access_)?token=/i.test(moduleSource) && !/\$\{[^}]*\b(access_)?token\b[^}]*\}/i.test(moduleSource))
check('页面源码里没有 access_token', !/access_token/.test(readFileSync(PAGE, 'utf8')))

// ── 3. 304 算成功；404 返回失败文案、不崩 ──────────────────────────────────
console.log('\n[3] 304 / 404')
pollQueue = [{ access_token: TOKEN }]
starStatus = 304
const again = await startRoute()
const already = await pollRoute(again.body.flowId)
check('304（之前就点过）返回 starred 且 already:true',
  already.body.ok === true && already.body.status === 'starred' && already.body.already === true,
  JSON.stringify(already.body))
pollQueue = [{ access_token: TOKEN }]
starStatus = 404
const notFoundFlow = await startRoute()
const notFound = await pollRoute(notFoundFlow.body.flowId)
check('404 返回可读失败文案，不崩',
  notFound.status === 200 && notFound.body.ok === false && notFound.body.status === 'failed' &&
  typeof notFound.body.error === 'string' && notFound.body.error.length > 0 &&
  !notFound.body.error.includes('404'), JSON.stringify(notFound.body))
const afterNotFound = await pollRoute(notFoundFlow.body.flowId)
check('失败后流程已删除（再 poll 是 flow-expired）',
  afterNotFound.body.ok === false && afterNotFound.body.code === 'flow-expired',
  JSON.stringify(afterNotFound.body))

// ── 4. denied / expired / slow_down ───────────────────────────────────────
console.log('\n[4] denied / expired / slow_down')
pollQueue = [{ error: 'access_denied' }]
const deniedFlow = await startRoute()
const denied = await pollRoute(deniedFlow.body.flowId)
check('denied 分支返回 status=denied', denied.body.ok === true && denied.body.status === 'denied',
  JSON.stringify(denied.body))
const afterDenied = await pollRoute(deniedFlow.body.flowId)
check('denied 后流程已删除', afterDenied.body.code === 'flow-expired', JSON.stringify(afterDenied.body))
pollQueue = [{ error: 'expired_token' }]
const expiredFlow = await startRoute()
const expired = await pollRoute(expiredFlow.body.flowId)
check('expired 分支返回 status=expired', expired.body.ok === true && expired.body.status === 'expired',
  JSON.stringify(expired.body))
pollQueue = [{ error: 'slow_down' }]
const slowFlow = await startRoute()
const slow = await pollRoute(slowFlow.body.flowId)
check('slow_down 把 interval 从 5 加到 10',
  slow.body.ok === true && slow.body.status === 'pending' &&
  slow.body.interval === 10 && slow.body.slowDown === true, JSON.stringify(slow.body))

// ── 5. flowId 不存在 ──────────────────────────────────────────────────────
console.log('\n[5] flowId 不存在')
const missing = await pollRoute('no-such-flow')
check('未知 flowId 返回 flow-expired',
  missing.status === 200 && missing.body.ok === false && missing.body.code === 'flow-expired' &&
  missing.body.error === '授权已过期，请重新发起', JSON.stringify(missing.body))
const noId = await postJson('/taskwatch/star/poll', {})
check('缺 flowId 返回 400 bad-request', noId.status === 400 && noId.body.code === 'bad-request',
  JSON.stringify(noId.body))

// ── 6. 页面侧静态断言 ──────────────────────────────────────────────────────
console.log('\n[6] 页面侧')
const page = readFileSync(PAGE, 'utf8')
const sw = readFileSync(SW, 'utf8')
check('页面有授权面板实现 openStarPanel', /function openStarPanel\s*\(/.test(page))
check('面板标题是「用 GitHub 账号点个星」', page.includes('用 GitHub 账号点个星'))
check('面板有 8 位码、复制、打开授权页、取消、等待状态',
  page.includes('data-star-code') && page.includes('data-star-copy') &&
  page.includes('打开 GitHub 授权页') && page.includes('data-star-cancel') &&
  page.includes('等待你在 GitHub 上确认…'))
check('面板有成功 / 取消 / 过期三态文案（✓ 用 \\u2713 转义）',
  page.includes('已点星 \\u2713') && page.includes('你取消了授权') && page.includes('授权码过期了'))
check('过期态有「重新发起」', page.includes('重新发起'))
check('关闭抽屉会调用 starStop() 停轮询',
  /function closeSheet\(\)\{[\s\S]{0,260}starStop\(\)/.test(page))
check('成功态有可关闭按钮', /function starRenderSuccess[\s\S]{0,500}data-star-close/.test(page))
check('slow_down 有 +5 秒常量与使用点',
  /STAR_SLOW_STEP\s*=\s*5/.test(page) && /base \+ STAR_SLOW_STEP/.test(page))
check('8 位码自动分成两段', /digits\.slice\(0, 4\) \+ '-' \+ digits\.slice\(4\)/.test(page))
const starTag = (page.match(/<button[^>]*data-act="star"[^>]*>/) || [''])[0]
check('data-act="star" 是按钮，不再直接挂仓库外链',
  !!starTag && !/href=/.test(starTag), starTag)
check('页面不再 window.open 仓库地址', !/window\.open\(['"]https:\/\/github\.com\/dingchenhui0618-arch\/dsh-in-hand/.test(page))
check('页面没有任何 GitHub API 域名', !/api\.github\.com|\/user\/starred/.test(page))
check('SW CACHE 已升到 taskwatch-v40', /const CACHE = 'taskwatch-v40'/.test(sw))

server.closeAllConnections()
server.close()
rmSync(home, { recursive: true, force: true })

console.log(`\n点星设备码授权：${passed}/${passed + failed} 通过`)
if (failed) { console.log('失败项：' + failed); process.exit(1) }
