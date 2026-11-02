/**
 * GitHub 设备码授权与「给仓库点星」的纯函数层（v1.8.23）。
 *
 * 为什么换 token 必须在宿主（Node）里做：
 *   GitHub 的 `/login/device/code` 与 `/login/oauth/access_token` **不返回 CORS 头**。
 *   页面在浏览器里直接 POST 会被跨域策略挡掉，而且把 `client_secret`（这里根本不用）
 *   或设备码塞进页面也没有任何好处。所以流程拆成两半：
 *
 *     页面：POST /taskwatch/star/start → 只拿到 user_code 与 verification_uri
 *           POST /taskwatch/star/poll  → 只拿到 pending / denied / expired / starred
 *     宿主：拿 device_code 换 access_token，立刻 PUT /user/starred，然后丢弃 token。
 *
 * 这个文件里**没有一行日志**。token 只出现在 pollDeviceFlow 的返回值与 starRepo 的
 * 请求头里，调用方（lib/index.js）在同一个 tick 内把它用掉并置 null。
 *
 * 零依赖，只用 Node 内置 fetch；`fetchImpl` 只为测试注入，生产路径不传。
 */

export const GITHUB_STAR_CLIENT_ID = 'Ov23lirBPNSw0dkWf1ZP'
export const GITHUB_STAR_REPO = Object.freeze({
  owner: 'dingchenhui0618-arch',
  repo: 'dsh-in-hand',
})
export const DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
// 空 scope：只要能给公开仓库点星，不读私有仓库、不碰任何用户资料。
// 空值也要在请求体里带上 `scope=`，GitHub 对缺省 scope 的宽容度不值得赌。
export const DEVICE_SCOPES = ''
export const STAR_USER_AGENT = 'dsh-in-hand'
export const STAR_API_BASE = 'https://api.github.com'

const FORM_TYPE = 'application/x-www-form-urlencoded'
const JSON_ACCEPT = 'application/json'
const API_ACCEPT = 'application/vnd.github+json'
const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/

/** 注入 fetch 时用注入的；生产路径每次调用都取当时的全局 fetch，测试可整体替换。 */
function pickFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl
  return (...args) => {
    if (typeof globalThis.fetch !== 'function') throw new Error('fetch-unavailable')
    return globalThis.fetch(...args)
  }
}

async function readJson(response) {
  try {
    const data = await response.json()
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

/**
 * 发起设备码授权。
 * 返回 { deviceCode, userCode, verificationUri, expiresIn, interval }。
 * `deviceCode` 只留给宿主，页面永远看不到它。
 */
export async function startDeviceFlow({ clientId = GITHUB_STAR_CLIENT_ID, fetchImpl } = {}) {
  const id = String(clientId || '').trim()
  if (!id) throw new Error('github-client-id-missing')
  const body = new URLSearchParams()
  body.set('client_id', id)
  body.set('scope', DEVICE_SCOPES)
  const response = await pickFetch(fetchImpl)(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      accept: JSON_ACCEPT,
      'content-type': FORM_TYPE,
    },
    body: body.toString(),
  })
  if (!response || !response.ok) throw new Error('github-device-code-http')
  const data = await readJson(response)
  const deviceCode = String(data.device_code || '').trim()
  const userCode = String(data.user_code || '').trim().toUpperCase()
  const verificationUri = String(data.verification_uri || '').trim()
  if (!deviceCode) throw new Error('github-device-code-missing')
  if (!USER_CODE_RE.test(userCode)) throw new Error('github-user-code-invalid')
  let verified = ''
  try {
    const url = new URL(verificationUri)
    if (url.protocol === 'https:' && /(^|\.)github\.com$/i.test(url.hostname)) verified = url.toString()
  } catch { /* 下面统一判空 */ }
  if (!verified) throw new Error('github-verification-uri-invalid')
  const expiresRaw = Number(data.expires_in)
  const intervalRaw = Number(data.interval)
  return {
    deviceCode,
    userCode,
    verificationUri: verified,
    expiresIn: Number.isFinite(expiresRaw) && expiresRaw > 0 ? Math.floor(expiresRaw) : 900,
    interval: Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.max(1, Math.floor(intervalRaw)) : 5,
  }
}

/**
 * 轮询换 token。GitHub 用 200 + `error` 表达"还没好"，所以不能只看 HTTP 状态。
 * status ∈ pending / slow_down / expired / denied / { status:'ok', token }。
 */
export async function pollDeviceFlow({ clientId = GITHUB_STAR_CLIENT_ID, deviceCode, fetchImpl } = {}) {
  const id = String(clientId || '').trim()
  const code = String(deviceCode || '').trim()
  if (!id || !code) throw new Error('github-device-flow-args')
  const body = new URLSearchParams()
  body.set('client_id', id)
  body.set('device_code', code)
  body.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code')
  const response = await pickFetch(fetchImpl)(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: JSON_ACCEPT,
      'content-type': FORM_TYPE,
    },
    body: body.toString(),
  })
  if (!response || !response.ok) throw new Error('github-access-token-http')
  const data = await readJson(response)
  const token = typeof data.access_token === 'string' ? data.access_token : ''
  if (token) return { status: 'ok', token }
  const interval = Number(data.interval)
  const extra = Number.isFinite(interval) && interval > 0 ? { interval: Math.max(1, Math.floor(interval)) } : {}
  switch (String(data.error || '')) {
    case 'authorization_pending': return { status: 'pending', ...extra }
    case 'slow_down': return { status: 'slow_down', ...extra }
    case 'expired_token': return { status: 'expired' }
    case 'access_denied': return { status: 'denied' }
    default: throw new Error('github-access-token-error')
  }
}

/**
 * PUT /user/starred/<owner>/<repo>。
 * 204 = 刚点上；304 = 之前就点过（也算成功）；404 / 401 / 403 返回错误码，不抛。
 */
export async function starRepo({ token, owner = GITHUB_STAR_REPO.owner, repo = GITHUB_STAR_REPO.repo, fetchImpl } = {}) {
  const access = String(token || '').trim()
  const own = String(owner || '').trim()
  const name = String(repo || '').trim()
  if (!access) return { ok: false, code: 'unauthorized', status: 0, error: '授权已失效，请重新授权' }
  if (!own || !name) return { ok: false, code: 'bad-repo', status: 0, error: '仓库地址不完整' }
  const url = STAR_API_BASE + '/user/starred/' + encodeURIComponent(own) + '/' + encodeURIComponent(name)
  const response = await pickFetch(fetchImpl)(url, {
    method: 'PUT',
    headers: {
      accept: API_ACCEPT,
      authorization: 'Bearer ' + access,
      'content-length': '0',
      'user-agent': STAR_USER_AGENT,
    },
  })
  const status = Number(response && response.status) || 0
  if (status === 304) return { ok: true, already: true, status }
  if (status === 204 || status === 200 || status === 201) return { ok: true, already: false, status }
  if (status === 404) return { ok: false, code: 'not-found', status, error: '仓库不存在或当前账号无权访问' }
  if (status === 401) return { ok: false, code: 'unauthorized', status, error: '授权已失效，请重新授权' }
  if (status === 403) return { ok: false, code: 'forbidden', status, error: 'GitHub 拒绝了这次点星，请稍后再试' }
  return { ok: false, code: 'star-failed', status, error: '点星没有成功，请稍后再试' }
}
