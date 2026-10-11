#!/usr/bin/env node
/**
 * 客户端 bundle 的契约测试。
 *
 * 浏览器加载这个文件的方式是：当作普通脚本执行 → 它调用
 * window.__ModuleLoader__.load({id, factory}) → 浏览器按 id 索引 factory，
 * 在需要时调用 factory(require) 拿到插件导出。
 *
 * 所以这里就照那条路径真的跑一遍，而不是只做语法检查：
 *   1. 作为**脚本**（非模块）能否解析
 *   2. 是否恰好注册一次，且 id 与 package.json 的 name 完全一致
 *   3. factory(require) 返回的对象是否含 name / inject / apply
 *   4. apply(fakeCtx) 是否真的往两个插槽各注册了一次
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { Script as VmScript } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`  ${mark}  ${label}${detail && !condition ? ' -> ' + detail : ''}`)
}

// --- 1. 必须是合法脚本，且不能含模块语法 ---
let run
try {
  run = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', source)
  check('作为普通脚本可解析', true)
} catch (e) {
  check('作为普通脚本可解析', false, e.message)
  process.exit(1)
}
check('不含 import/export 语句',
  !/^\s*(import|export)\s/m.test(source))

// --- 2. 捕获注册 ---
const captured = []
const styleNodes = []
const fakeDocument = {
  createElement() {
    const node = { attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v }, remove() {} }
    styleNodes.push(node)
    return node
  },
  head: { appendChild() {} },
}

run(
  { __ModuleLoader__: { load(registration) { captured.push(registration) } } },
  fakeDocument,
  async () => ({ json: async () => ({}) }),
  () => 0,
  () => {},
)

check('恰好注册一次', captured.length === 1, `实际 ${captured.length} 次`)
check("注册 id 与 package.json 的 name 一致", captured[0] && captured[0].id === pkg.name,
  `注册 id=${captured[0] && captured[0].id}，包名=${pkg.name}`)
check('提供了 factory 函数', captured[0] && typeof captured[0].factory === 'function')

// --- 3. factory 的产物 ---
const required = []
const fakeReact = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
}
const fakeRequire = (spec) => {
  required.push(spec)
  if (spec === 'react') return fakeReact
  throw new Error('未在种子表内: ' + spec)
}

let plugin
try {
  plugin = captured[0].factory(fakeRequire)
} catch (e) {
  check('factory(require) 可执行', false, e.message)
  process.exit(1)
}
check('factory(require) 可执行', true)
check('只向 require 索取种子表内的模块',
  required.every((s) => s === 'react'), required.join(', '))
check('导出 name', plugin && plugin.name === pkg.name, String(plugin && plugin.name))
check('导出 apply 函数', plugin && typeof plugin.apply === 'function')
check('导出 inject 数组且含 slots',
  plugin && Array.isArray(plugin.inject) && plugin.inject.includes('slots'),
  JSON.stringify(plugin && plugin.inject))

// --- 4. apply 真的注册到插槽 ---
const injected = []
const registrations = []
const fakeCtx = {
  effect(fn) { return fn() },
  slots: {
    inject(name, factory) { injected.push(name); registrations.push(factory()) },
    register(spec) { return spec },
  },
}
let applyError = null
try {
  plugin.apply(fakeCtx)
} catch (e) {
  applyError = e
}
check('apply(ctx) 不抛异常', applyError === null, applyError && applyError.message)
check('注入 sidebar.panellist', injected.includes('sidebar.panellist'), injected.join(', '))
check('注入 main', injected.includes('main'), injected.join(', '))
check('插入了一个 <style> 节点', styleNodes.length === 1, `实际 ${styleNodes.length} 个`)
check('style 节点带 data-dsh-in-hand 标记',
  styleNodes[0] && styleNodes[0].attrs['data-dsh-in-hand'] !== undefined)

// --- 5. Host 半边的契约 ---
//
// 这一节是 2026-09-21 那次真实故障的回归防护。v1.0.0 漏了 inject，导致
// ctx.get('webServer') 在组合期拿到 undefined，全部路由被静默跳过
// （/taskwatch 一律 404）。客户端那半边当时检查得很细，宿主这半边却没人管，
// 所以补上：宿主插件缺 name / inject / apply 中任何一个都必须构建失败。
// Windows 上动态 import 绝对路径必须走 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
const host = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)

check('宿主导出 name 且与包名一致', host.name === pkg.name, String(host.name))
check('宿主导出 apply 函数', typeof host.apply === 'function')
check("宿主 inject 是数组且含 'webServer'",
  Array.isArray(host.inject) && host.inject.includes('webServer'),
  JSON.stringify(host.inject))

// 路由注册全靠 webServer；少了它整页 404 而不报错，正是最难查的失败姿态。
check('宿主 apply 声明了 1 个形参（ctx）', host.apply.length === 1, String(host.apply.length))

const hostSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
check("宿主注册了 '/taskwatch' 路由", hostSrc.includes("'/taskwatch'"))

// 外壳（页面 / SW）必须**按请求读盘**，不能在模块加载时读一次就缓存。
// 2026-10-10：中继本来就是按请求读盘的，所以手机刷新就生效；插件这边原先缓存，
// 于是同一份 page.html 有了两个生效时机 —— 手机已经是新版，本机 /taskwatch 还是
// 旧版，还要重启整个客户端才更新。实测差：手机 112018 字符 vs 宿主内存 110001 字符。
// 改成每次请求重读（几十 KB 的本地文件，开销可忽略）。manifest 仍内联在代码里，
// 那是**改代码**，本来就要重启，不在这条断言的范围内。
check('页面与 SW 按请求读盘（改了页面不用重启客户端就生效）',
  !/^const (PAGE|SERVICE_WORKER)\s*=/m.test(hostSrc) &&
    /send\(res, 200, 'text\/html; charset=utf-8', readPage\(\)\)/.test(hostSrc) &&
    /send\(res, 200, 'text\/javascript; charset=utf-8', readSw\(\)/.test(hostSrc) &&
    /function readPage\(\)/.test(hostSrc) && /function readSw\(\)/.test(hostSrc))

// 写入口的范围。原来是 `!/method === 'POST'/` 这种"检查写法"的断言 ——
// 2026-09-22 加了 8 条对话路由（其中 4 条是写）之后它**照样通过**，
// 是一条假绿灯：它证明的是"没这么写"，不是"没有这个能力"。
// 改成正面清点：所有路由里，不属于只读白名单的必须全部落在 /taskwatch/chat/ 之下。
const READONLY_ROUTES = new Set([
  '/taskwatch',
  '/taskwatch/data',
  '/taskwatch/session',
  '/taskwatch/manifest.webmanifest',
  '/taskwatch/sw.js',
  // 2026-10-09：交付文件只读出口（图片 / PDF / 文本 / 视频）。只有 GET/HEAD 语义、
  // 不接受请求体、不列目录；「能不能读」由 lib/files.js 的白名单裁决。所以它属于
  // 只读集合，而不是被当成"又随手加了一条路由"。
  '/taskwatch/file',
])
const declaredPaths = [...hostSrc.matchAll(/path:\s*'(\/taskwatch[^']*)'/g)].map((m) => m[1])
const chatPaths = declaredPaths.filter((p) => !READONLY_ROUTES.has(p))
check('新增路由全部落在 /taskwatch/chat/ 之下（写能力只从这一组来）',
  chatPaths.length > 0 && chatPaths.every((p) => p.startsWith('/taskwatch/chat/')),
  chatPaths.join(' ') || '(没有)')
// 交付文件出口必须真的走白名单解析。这类功能最容易退化成"任意文件读取"的写法是
// readFileSync(用户传来的路径)，所以这里正面钉住它经过 files.js，而不是断言"没这么写"。
check('交付文件路由走 lib/files.js 的白名单解析',
  declaredPaths.includes('/taskwatch/file') &&
    hostSrc.includes('resolveTarget(') &&
    hostSrc.includes('rootsFrom(') &&
    hostSrc.includes('infoOf('))
// 2026-10-09：从 9 增到 10 —— 新增 /taskwatch/chat/usage（只读），
// 手机端指标行靠它拿「轮次 / 步数 / token / 缓存命中 / 上下文占用」。
// 这个数字故意钉死：以后再加路由，必须回到这一行确认一次是有意为之。
// 2026-10-09：从 10 增到 11 —— 新增 /taskwatch/chat/workspaces（只读），
// 手机端「+」先选工作区再建会话。
// 2026-10-11：从 11 增到 12 —— 新增 /taskwatch/chat/upload（写入），
// 手机端可以把已校验的文件或图片随消息送入当前会话。
// 这个数字故意钉死：以后再加路由，必须回到这一行确认一次是有意为之。
check('对话路由共 12 条（7 读 + 5 写，增删都要是有意识的）',
  chatPaths.length === 12, `实际 ${chatPaths.length}：${chatPaths.join(' ')}`)
check('对话路由把 sessionController 当软依赖、并逐请求获取',
  /ctx\.get\('sessionController'\)/.test(hostSrc) && /chatOf\(\)/.test(hostSrc))
check('prompt 的 requestId 由宿主生成（客户端不能决定请求身份）',
  /requestId:\s*randomUUID\(\)/.test(hostSrc))
// 2026-10-09：这条原来钉的是 !/request\.cwd\s*=/（"不接受客户端指定 cwd"）。
// 工作区选择改变了能力，但没有改变"谁来决定" —— 所以断言跟着改成钉**新的边界**，
// 旧写法整条删掉：留着它就只能靠绕过它来加功能，那才是真的失去守门。
check('cwd 只能来自服务端的工作区清单，不能是客户端原样字符串',
  /const hit = \(await workspaceList\(\)\)\.find/.test(hostSrc) &&
    /request\.cwd = hit\.path/.test(hostSrc) &&
    !/request\.cwd = asText\(/.test(hostSrc))
check("SSE 关掉了 nginx 缓冲（否则流式会退化成一次性）",
  hostSrc.includes("'x-accel-buffering': 'no'"))

// 轮询路径的开销与缓存协商。snapshot() 一次要问一圈服务（每个 agent 的 jobs、
// 每个会话的 eventAt/title/goal、每个 agent 的 listDescendants），而手机页面
// 每 3 秒轮询一次，桌面面板和多个标签页还会各来一份。这两条断言把「不能退化成
// 每请求全量采集」和「不能退化成每次都重传整份 JSON」钉住。
check('宿主对快照做 TTL 缓存并合并并发请求',
  /SNAPSHOT_TTL_MS/.test(hostSrc) && /inflight/.test(hostSrc))
check('宿主用 If-None-Match 协商 304',
  hostSrc.includes('if-none-match') && /send\(res,\s*304/.test(hostSrc))

// --- 6. 打包元数据 ---
const patch = readFileSync(join(ROOT, pkg.dsh.bundle.patch), 'utf8')
check('cordis.patch.yml 用包名引用插件', patch.includes(pkg.name), patch.trim())
check('exports["./client"] 指向构建产物',
  pkg.exports && pkg.exports['./client'] === './lib/client.js',
  JSON.stringify(pkg.exports && pkg.exports['./client']))
check("dsh.client.platform 为 web",
  pkg.dsh.client && pkg.dsh.client.platform === 'web')
check('files 含 lib 与 cordis.patch.yml',
  pkg.files.includes('lib') && pkg.files.includes('cordis.patch.yml'))

// --- 7. 手机页面（lib/page.html）---
//
// 这一节盯两件在真实使用里会出事、但肉眼看不出来的事：
//   1) XSS —— 页面把会话标题、任务 label 等用户可控文本拼进 innerHTML。
//      它是 npm 上公开的插件，别人的标题里出现 <img onerror> 就会执行。
//   2) 手机上的耗电 —— 页面常驻后台标签页时不该继续每 3 秒发请求。
const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')

// 改名的契约：package.json / 插件 id / 页面标题 / PWA 名称必须一起走，不许半途而废。
// 2026-10-10 从 dsh-taskwatch 改成 dsh-in-hand（掌上 DSH）时加的。
//
// 注意这里查的是**包标识** "dsh-taskwatch"，不是路由前缀 "taskwatch"：
// /taskwatch/* 是故意保留的对外契约——手机桌面那个入口就挂在它上面，
// 改了要重新配对、重新加主屏，所以它继续叫 taskwatch。
const IDENTITY_FILES = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/page.html', 'lib/sw.js']
const staleIdentity = IDENTITY_FILES.filter((f) => readFileSync(join(ROOT, f), 'utf8').includes('dsh-taskwatch'))
check('代码与包标识里没有残留的旧包名 dsh-taskwatch',
  staleIdentity.length === 0, staleIdentity.join(', ') || '干净')

const hostSource = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
check('手机页标题与 PWA manifest 都是新名字「掌上 DSH」',
  /<title>掌上 DSH<\/title>/.test(page) && /short_name: '掌上 DSH'/.test(hostSource))

const escMap = /ESC\s*=\s*\{([^}]*)\}/.exec(page)
const escaped = escMap ? escMap[1] : ''
check("page.html 的转义表覆盖 & < > \" '",
  escaped.includes("'&'") && escaped.includes("'<'") && escaped.includes("'>'")
    && escaped.includes('&quot;') && escaped.includes('&#39;'),
  escMap ? escMap[1] : '(找不到 ESC 表)')

// 页面里的内联脚本必须能编译。
//
// 它既不是模块、也没有任何构建步骤会碰它，所以一个手误（比如编辑时把某个函数的
// 声明行连同别的改动一起替换掉）不会让 CI 变红，只会在浏览器里变成一片空白。
// 这条断言就是为那种时刻准备的 —— 写它之前刚发生过一次。
const pageScript = /<script>([\s\S]*?)<\/script>/.exec(page)
let pageSyntaxError = null
if (!pageScript) pageSyntaxError = '找不到内联 <script> 块'
else { try { new Function(pageScript[1]) } catch (e) { pageSyntaxError = e.message } }
check('page.html 的内联脚本可编译', pageSyntaxError === null, pageSyntaxError || '')

// XSS 的四条主路径必须走 textContent 或 esc()。
//
// 说明白这条断言的能力边界：它是**代理**，不是证明 —— 它盯住的是已知的四个
// 入口（模型正文、工具提示、工具名、会话标题），不是"全页面无 XSS"。
// 之所以仍然值得写：这四处正是唯一会渲染外部文本的地方，改动时踩中的概率最高。
// 2026-10-08 改：这两条原先钉的是**具体写法**（`b.textContent = text`、
// `a.textContent = it.hint`），加入代码块渲染后写法变了（改用 createTextNode 与嵌套
// 的 <code>），断言于是失败 —— 但安全性并没有变差。所以改成守**性质**：
// 模型正文只能落到文本节点上，绝不允许喂进 innerHTML。
check('page.html 的气泡正文只走文本节点（模型正文不进 innerHTML）',
  !/\.innerHTML\s*=\s*(s|text|it\.hint|it\.text)\b/.test(page) &&
  (/b\.textContent\s*=\s*s/.test(page) || /createTextNode\(/.test(page)))
check('page.html 的工具提示只走文本节点（命令内容不进 innerHTML）',
  /codeEl\.textContent\s*=\s*it\.hint/.test(page) &&
  !/\.innerHTML\s*=\s*it\.hint/.test(page))
check('page.html 的工具名经 toolLabel 后用 textContent 写入',
  /nm\.textContent\s*=\s*toolLabel\(/.test(page))

// 2026-09-22 实测踩到的坑：tool/result 的顶层**没有** callId，
// 真正的 id 在 data.message.source.callId。按顶层读会一直拿到 undefined，
// 表现是每来一个工具结果就新插一张错卡。这条断言把它钉住。
check('page.html 从 data.message.source.callId 取工具结果 id',
  /message\.source\.callId/.test(page) && /resultCallId\(d\)/.test(page))

// 会话标题靠 session/title 帧补全（冷会话也有），否则顶部只会显示目录名。
check('page.html 处理 session/title 帧',
  /'session\/title'/.test(page) && /setTitle\(/.test(page))

// 就地更新要按序号定位，别靠"最后一张卡"猜。
check('page.html 按 data-i 序号就地替换节点',
  /data-i/.test(page) && /querySelector\('\[data-i="/.test(page))

// service worker 的离线兜底用的是 offline:true + errors[]（形状在 lib/sw.js 里）。
// 不认它，断网时会显示成"一切正常，没有任务在跑" —— 对监控来说，
// 把"读不到"说成"没事"是最坏的一种错。
check('page.html 认 service worker 的离线快照形状',
  /d\.offline/.test(page) && /d\.errors/.test(page))

// 对话接口绝不能被 service worker 经手：/taskwatch/chat/stream 是长连接 SSE，
// 一旦被包一层就退化成"等整段读完再给"，流式全丢。
const sw = readFileSync(join(ROOT, 'lib', 'sw.js'), 'utf8')
check('sw.js 显式放过对话接口',
  /indexOf\('\/taskwatch\/chat\/'\)/.test(sw))

// 外壳必须网络优先。cache-first + 手工升 CACHE 版本号已经害过两次：
// 改了 page.html 忘了升号，已安装的手机一直吃旧页面，而服务端看不出任何异常。
check('sw.js 的外壳走网络优先（改了页面手机才会更新）',
  /fetch\(e\.request\)/.test(sw) && /\.catch\(\(\)\s*=>\s*caches\.match\(e\.request\)/.test(sw))

// 下面这条防的是 2026-10-08 那次"手机一直停在只读旧页、而服务端两份文件字节一致"：
// install 用原子的 addAll，任何一个 URL 当次取不到就整体回滚，旧 SW 永远掌权。
check('sw.js 的 install 用 allSettled 而非原子 addAll',
  // 先剥掉整行注释再判：sw.js 的说明文字里正好提到了 c.addAll(SHELL) 这串字，
  // 不剥的话这条会对着注释报失败。
  /Promise\.allSettled\(SHELL\.map/.test(sw.replace(/^\s*\/\/.*$/gm, '')) &&
  !/\.addAll\(/.test(sw.replace(/^\s*\/\/.*$/gm, '')))
// 2026-10-10 的真实事故（也是"手机页打不开"的真凶）：上一版为了对付"旧外壳不会自己
// 变新"，在 activate 里主动 navigate 每个 window —— 那次导航又要由**尚未完成
// activate 的**自己来接管，两边互等。注册从此永远停在 state === "activating"，
// scope 内（也就是整个 /taskwatch）所有导航一起挂死；而同一个 URL 用 curl 或从
// scope 外 fetch 只要 110ms，服务端完全正常，从外面根本查不出来。
// 更糟的是有一条断言在**要求**这段代码，所以它被锁死了 —— 现在反过来钉住它。
// 页面已经是网络优先，每次导航都取新版，这种重载既没必要也致命。
check('sw.js 的 activate 不导航自己（会自我死锁，把 scope 内导航全挂死）',
  !/clients\.matchAll\(\{\s*type:\s*'window'\s*\}\)/.test(sw.replace(/^\s*\/\/.*$/gm, '')) &&
  !/\.navigate\(/.test(sw.replace(/^\s*\/\/.*$/gm, '')) &&
  /clients\.claim\(\)/.test(sw))
check('page.html 把会话标题经 esc() 再拼进 HTML',
  /esc\(title\)/.test(page))
const escUses = (page.match(/esc\(/g) || []).length
check('page.html 的 esc() 用在足够多的入口上（≥ 12 处）',
  escUses >= 12, `实际 ${escUses} 处`)

check('page.html 在页面隐藏时停止轮询',
  page.includes('visibilitychange') && page.includes('document.hidden'))

// 与宿主的 304 是配套的：用 no-store 的话浏览器根本不保存响应，
// 也就永远不会带 If-None-Match 回来，宿主那边的 304 就成了死代码。
check("page.html 用 cache:'no-cache' 取状态（304 才可能生效）",
  /cache:\s*'no-cache'/.test(page))

// 对话页与宿主路由必须对齐：页面调的每个接口都要真的注册过。
// 这条能抓住"改了路由名忘了改页面"这种单侧改动 —— 它在浏览器里只会表现为
// 一个静默失败的按钮，很难查。
const pageChatPaths = [...new Set([...page.matchAll(/\/taskwatch\/chat\/([a-z]+)/g)]
  .map((m) => '/taskwatch/chat/' + m[1]))]
const hostChatPathSet = new Set(chatPaths)
const missingChat = pageChatPaths.filter((p) => !hostChatPathSet.has(p))
check('页面调用的每个对话接口都在宿主注册过',
  pageChatPaths.length >= 6 && missingChat.length === 0,
  missingChat.length ? '缺: ' + missingChat.join(' ') : pageChatPaths.join(' '))

// 流式靠 SSE；切会话后旧连接必须被丢弃，否则两条流会把内容串在一起。
check('page.html 用 EventSource 跟随会话',
  /new EventSource\(/.test(page))
check('page.html 用序号丢弃切会话后的旧流',
  /mine\s*!==\s*SEQ/.test(page))

// 逐字输出只改一个节点：整页重建会让长会话每来一个字都重排。
check('page.html 的逐字输出只改单个节点',
  /streaming\.bub\.textContent\s*=/.test(page))
// 真测行为，而不是查字符串在不在。
//
// 之前这条是 `hostSrc.includes('"generatedAt":0')` 之类 —— 那种断言在 ETag 明明
// 永不命中（因为 generatedAt 每次都变）时依然显示「通过」，等于给自己发绿灯。
const etagBase = { generatedAt: 1, totals: { sessions: 2 }, sessions: [{ id: 'a' }] }
const etagOther = { generatedAt: 1, totals: { sessions: 3 }, sessions: [{ id: 'a' }] }
const etagNewer = { generatedAt: 999999, totals: { sessions: 2 }, sessions: [{ id: 'a' }] }

check('ETag 对内容敏感',
  host.etagOf(etagBase) !== host.etagOf(etagOther))
check('ETag 对 generatedAt 免疫（否则 304 永不命中）',
  host.etagOf(etagBase) === host.etagOf(etagNewer))
check('ETag 是带引号的合法值',
  /^"[0-9a-f]{20}"$/.test(host.etagOf(etagBase)), host.etagOf(etagBase))

// ── P2：溢出与折叠（方案 docs/ui-ux-plan.md §2.3 的八条） ──────────────────
// 盯的是"机制存在且能被用户触达"，不是"某段 CSS 长得像不像"。
check('page.html 超长回复会折叠、且能展开（aria-expanded 同步）',
  /FOLD_CHARS/.test(page) && /classList\.add\('fold'\)/.test(page) &&
  /classList\.toggle\('open'\)/.test(page) && /aria-expanded/.test(page))
check('page.html 代码围栏渲染成可自我滚动的代码块，并带复制',
  /function codeNode/.test(page) && /\.code pre/.test(page) &&
  /overflow:auto/.test(page))
check('page.html 复制有两条路径，失败时如实提示（不假装成功）',
  /navigator\.clipboard/.test(page) && /execCommand\('copy'\)/.test(page) &&
  /'复制失败'/.test(page))
check('page.html 工具的长命令可展开、可复制（不再无声截断）',
  /展开完整内容/.test(page) && /copyText\(it\.hint/.test(page))
check('page.html 流式结束时移除临时气泡（否则同一段话显示两遍）',
  /S\.streaming\.row\.remove\(\)/.test(page))
check('page.html 有回到底部与未读计数',
  /id="tobottom"/.test(page) && /unseen/.test(page) && /noteIncoming\(\)/.test(page))
check('page.html 滚动监听是 passive + rAF 节流的（不拖慢滚动）',
  /\{\s*passive\s*:\s*true\s*\}/.test(page) && /requestAnimationFrame/.test(page))
check('page.html 流式输出有尾部渐隐、页面禁止横向滚动',
  /\.bub\.streaming/.test(page) && /mask-image/.test(page) &&
  /overflow-x:clip/.test(page))
check('page.html 连续多个工具调用会折叠成一行摘要',
  /TOOL_GROUP_MIN/.test(page) && /function groupNode/.test(page) &&
  /function toolRunAt/.test(page) && /\.toolgroup/.test(page))
check('page.html 分组按状态决定默认展开（失败绝不能被折叠藏起来）',
  /var opened = running > 0 \|\| failed > 0/.test(page) &&
  /body\.hidden = !opened/.test(page) && /aria-expanded/.test(page))
check('page.html 分组增量更新会清掉已单独渲染的旧行（同一批步骤不显示两遍）',
  /data-g=/.test(page) && /stray\.remove\(\)/.test(page) &&
  /function groupRow/.test(page))
check('page.html markdown 支持标题/粗体/行内代码/列表',
  /\.md-h/.test(page) && /createElement\('strong'\)/.test(page) &&
  /createElement\('code'\)/.test(page) && /\.md-li/.test(page))
check('page.html XSS 底线：markdown 渲染段内不含任何 innerHTML',
  (function () {
    const a = page.indexOf('function inlineInto')
    const b = page.indexOf('function toolNode')
    if (a < 0 || b <= a) return false
    const seg = page.slice(a, b)
    return seg.indexOf('innerHTML') === -1 && seg.indexOf('textContent') !== -1
  })())
check('page.html markdown 渲染件被 bubNode 真正调用（不是写了没用）',
  /blocksInto\(b, plain\)/.test(page) && /blocksInto\(b, s\)/.test(page))

// ── 设计技能清单里的硬性要求（ui-ux-pro-max / impeccable / hallmark） ──────
check('page.html 触碰区不小于 44px（检索库标为 Critical）',
  /\.iconbtn\{[^}]*width:44px/.test(page) && /#send\{[^}]*height:44px/.test(page))
check('page.html 支持 prefers-reduced-motion',
  /prefers-reduced-motion/.test(page))
check('page.html 有 :focus-visible 焦点环（键盘可见、触屏不留光圈）',
  /:focus-visible/.test(page))
check('page.html 用客户端真实主题令牌，不是自编颜色',
  /--dsw-alias-label-primary/.test(page) &&
  /--nb-1000:#0f1115/.test(page) &&
  // 注意是 -new-color 结尾：客户端的 --dsw-alias-brand-primary 其实是中性色
  // （亮 #0f1115 / 暗 #f9fafb），蓝色是 -new-color。名字很有欺骗性，钉死它。
  /--dsw-alias-brand-primary-new-color:#4176e6/.test(page) &&
  !/--dsw-alias-brand-primary:#4176e6/.test(page))
check('page.html 采纳了包内暗色品牌蓝的真实覆盖 #5686fe',
  /--dsw-alias-brand-primary-new-color:#5686fe/.test(page))
check('page.html 明暗两套令牌都有（暗色只有一份）',
  /:root\[data-theme='dark'\]/.test(page) &&
  // 按"含令牌声明的暗色块"计数，不能数选择器出现次数 ——
  // base 规则里还有一个 :root[data-theme='dark']{color-scheme:dark}。
  (page.match(/:root\[data-theme='dark'\]\s*\{[^}]*--dsw-/g) || []).length === 1)

// ── 动效层（第 10 节「纸墨微动」）─────────────────────────────────────────
// 动效的风险不是"好不好看"，而是两件会真出事的事：
//   1. 入场动画挂在**会被整段重渲染**的节点上 → 每 3 秒轮询一次就重放一次，
//      观感从"灵动"变"抽搐"。所以它们必须由 JS 按"状态刚刚变化"加的类门控。
//   2. 用 JS 先把内容藏起来、等加载完再显示 → JS 一挂，图片就永远看不见。
//      所以"隐藏"只能挂在 JS **之后**加上去的 .loading 上。
// 这两条正面钉住，不靠肉眼。
check('动效层声明了统一的时长与曲线令牌',
  /--mo-fast:120ms/.test(page) && /--mo-base:200ms/.test(page) &&
    /--mo-slow:320ms/.test(page) && /--mo-ease:cubic-bezier/.test(page) &&
    /--mo-spring:cubic-bezier/.test(page))
check('入场动画由 JS 加的类门控，不在 .tool/.md-img 上裸挂',
  !/\.tool\.(ok|no)\s*\{[^}]*animation:/.test(page) &&
    !/\.md-img\s*\{[^}]*animation:/.test(page) &&
    /\.tool\.fresh\.no\s*\{[^}]*animation:/.test(page) &&
    /\.md-imgwrap\.loading \.md-img\{opacity:0/.test(page) &&
    /\.md-imgwrap\.done \.md-img\{opacity:1/.test(page))
check('缩小动效时状态语义仍在（墨环与骨架图有静态等价）',
  /prefers-reduced-motion:reduce\)\{[\s\S]*?\.tool\.run \.sp\{background:transparent/.test(page) &&
    /prefers-reduced-motion:reduce\)\{[\s\S]*?\.md-imgwrap\.loading \.md-img\{opacity:1/.test(page))
check('行为层用事件委托 + rAF 合并（不逐按钮挂事件、不每个 chunk 都重算）',
  /addEventListener\('pointerdown'/.test(page) &&
    /requestAnimationFrame\(function \(\) \{ queued = false; mark\(\) \}\)/.test(page))
// 浮标的位置必须跟着**页脚真实高度**走。写死 bottom 的后果是它压住指标行中间那几个字，
// 而指标行折成一行还是两行随内容变 —— 这类"某些屏、某些数据下才看得出"的毛病，
// 靠截图偶尔撞见一次，靠断言才能不再回来。
check('浮标按页脚真实高度定位，不是写死的像素',
  /bottom:calc\(var\(--foot-h/.test(page) &&
    /ResizeObserver\(putFoot\)\.observe\(foot\)/.test(page) &&
    /setProperty\('--foot-h'/.test(page))
// 正文排版尺度：这组数字是"读起来不晕"的底线，是设计决定而不是随手写的。
// 让断言拦一下 —— 以后谁想调小，得先看见这条为什么存在。
check('正文排版尺度（行高 / 段间 / 标题间距 / 列表间距 / 中文断行）',
  /\.md-p\{margin:0 0 3px;line-height:1\.72/.test(page) &&
    /\.md-blank\{height:16px\}/.test(page) &&
    /\.md-h\{[^}]*margin:16px 0 7px/.test(page) &&
    /\.md-li\{[^}]*margin:5px 0/.test(page) &&
    (page.match(/line-break:strict/g) || []).length >= 4 &&
    /\.md-bq\{/.test(page) && /\.md-hr\{/.test(page) &&
    /className = 'md-bq'/.test(page) && /className = 'md-hr'/.test(page))
// 工作区选择：能做，但只能做服务端允许的那部分。这两条断言钉的是那个边界本身 ——
// 清单由服务端给、create 只采纳清单内路径、页面不自己拼路径。
check('工作区清单由服务端给，create 只采纳清单内路径',
  /path: '\/taskwatch\/chat\/workspaces'/.test(hostSrc) &&
    /DSH_TASKWATCH_WORKSPACES/.test(hostSrc) &&
    /这个工作区不在服务端的候选清单里/.test(hostSrc) &&
    /request\.cwd = hit\.path/.test(hostSrc) &&
    /statSync\(raw\)\.isDirectory\(\)/.test(hostSrc))
check('手机页从服务端取工作区清单，不自己拼路径',
  /fetch\('\/taskwatch\/chat\/workspaces'/.test(page) &&
    /chat\/create', path \? \{ workspace: path \} : \{\}/.test(page) &&
    /el\.id = 'wsp'/.test(page) && /#wsp\{/.test(page))

// 牌桌的"你能不能操作"必须由**轮到你**决定，不能拿快照里的 legal 决定。
// legal 描述的是当前行动者（host.js:231 取 players[state.toAct]）—— 多半是正在思考
// 的 AI。用它开按钮，就是"按钮亮着、点了没反应"：插件 act() 在 toAct !== 0 时静默
// 返回原快照、HTTP 照样写 200（host.js:921-923）。这类坏体验截图和字符串检查都很难
// 撞见（真机上要正好落在 AI 的回合），所以把判据本身钉住。
check('牌桌动作按钮按 toAct===0 开，不拿 legal（属于当前行动者）开',
  /var myTurn = s\.status === 'playing' && s\.toAct === 0/.test(page) &&
    /\$\('pkFold'\)\.disabled = !can \|\| !legal\.fold/.test(page) &&
    /\$\('pkCheck'\)\.disabled = !can \|\| !\(legal\.check \|\| legal\.call\)/.test(page) &&
    /\$\('pkRaise'\)\.disabled = !can \|\| !raisable/.test(page) &&
    !/var can = !PK\.busy && !!\(legal\.fold/.test(page))
// toAct 下发的就是座位号（host.js:242），不是对象：读 .seat/.name 永远 undefined。
// 注释里会引用这两个错误写法做说明，所以先剥掉注释再判（只判真正执行的代码）。
const pageCode = page.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
check('手机页不把 toAct 当对象读（它就是座位号）',
  !/s\.toAct\.(seat|name)/.test(pageCode) && /s\.toAct === seatNo/.test(pageCode))
// 静默 no-op 是插件的行为，页面改不了；但页面不能跟着沉默 —— 当场把原因说出来。
check('轮不到你时页面当场说原因，200 不当成生效',
  /还没轮到你，等对手行动/.test(page) &&
    /这一下没生效：刚轮到别人/.test(page) &&
    /if \(!\(live\.status === 'playing' && live\.toAct === 0\)\)/.test(page))
// 牌面：插件下发的是 {r:2..14, s:'s'|'h'|'d'|'c'}（dsh-holdem src/cards.js:2-3）。
// 不映射就是真机上的 "13h 14d" —— 那是 K♥ A♦，但没人看得懂。红桃/方块还要标红。
check('牌面按插件的真实编码映射成 K♥ 这种可读形式',
  /var PK_RANK = \{ 14:'A', 13:'K'/.test(page) && /var PK_SUIT = \{ s:'♠', h:'♥', d:'♦', c:'♣' \}/.test(page) &&
    /PK_RANK\[r\] != null \? PK_RANK\[r\] : String\(r\)/.test(page) &&
    /'pk-card' \+ \(hidden \? ' back' : ''\)/.test(page) && /\.pk-card\.red\{color:#c0392b\}/.test(page))
// 座位里的牌是纯文本、公共牌走 pkCard()，两条渲染路径各有一套红字，缺一条就有一半的牌不红。
check('座位与公共牌的红色花色都标了（两条渲染路径都照顾到）',
  /\.pk-seat \.cd \.cdc\.red\{color:#ff9a8f\}/.test(page) &&
    /<span class="cdc' \+ \(\/\[♥♦\]\/\.test\(t\) \? ' red' : ''\)/.test(page))
// heroHand 是牌型名（成牌前是「底牌」），不是牌面：标成「你的牌」会把人绕晕。
// 说明文字里会引用那个错标法，所以剥掉注释再判。
check('不把 heroHand（牌型名）当成牌面显示',
  !/你的牌：/.test(pageCode) && /s\.heroHand !== '底牌' \? '<div class="pk-hint">牌型：'/.test(pageCode))

// ── 内联脚本必须能被 JS 解析器解析 ──────────────────────────────────────────
// 2026-10-10 的真实事故：改牌桌提示那一行时少写了一个右括号，整段 IIFE 直接
// SyntaxError —— 页面照样返回 200、"看着正常"，而聊天区与牌桌一起死（#pkSeats
// 根本没建出来）。当轮 133 条契约**全是字符串匹配**，一条都没红。
// 这是本仓库第三次栽在"字符串检查会撒谎"上，所以让解析器自己说话。
const inlineScripts = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
let inlineSyntaxError = ''
const inlineOk = inlineScripts.length >= 2 && inlineScripts.every((src, i) => {
  try { new VmScript(src, { filename: `page-inline-${i + 1}.js` }); return true } catch (err) {
    inlineSyntaxError = `第 ${i + 1} 段：${err.message}`
    return false
  }
})
check('page.html 的内联脚本能被解析器解析（语法错误不靠肉眼）', inlineOk,
  inlineSyntaxError || `内联脚本段数=${inlineScripts.length}`)

// 结构图标必须是矢量 SVG，不能是 emoji 或 ☰ ➤ ✕ ✓ 这类字符：
// 字符图标在不同字体下大小、基线、粗细都不一样，换台设备就变形。
// 注释里提到这些字符是允许的，所以先剥掉注释再判。
const pageBare = page.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
check('page.html 没有用 emoji 或字符当结构图标',
  !/[\u{1F300}-\u{1FAFF}]/u.test(pageBare) && !/[☰➤✕✓👋]/.test(pageBare))

// ── 令牌防漂移：页面的内联子集必须与 lib/tokens.css 逐条一致 ────────────────
//
// lib/tokens.css 是从客户端安装包（app.asar 里 @deepseek-ai/dsh-client-ui-theme
// 注入的 design-platform.css）全量提取的 246 个令牌，可重跑且逐字节确定。
// 页面只内联实际用到的子集（少一次请求、SW 更好缓存），但两者一旦漂移，
// "和客户端同一套令牌"这句话就不成立了 —— 所以这儿逐条比，而不是靠人眼。
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
function cssBlock(css, re) {
  const m = re.exec(css)
  if (!m) return null
  const j = css.indexOf('{', m.index)
  if (j < 0) return null
  let depth = 0, k = j
  for (; k < css.length; k++) {
    if (css[k] === '{') depth++
    else if (css[k] === '}') { depth--; if (!depth) break }
  }
  return css.slice(j + 1, k)
}
function cssDecls(txt) {
  const out = {}
  if (txt) for (const m of txt.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;}]+)/g)) out[m[1].trim()] = m[2].trim()
  return out
}
const normColor = (v) => {
  let s = String(v).trim().toLowerCase().replace(/\s+/g, '')
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]
  return s
}

let tokensCss = ''
try {
  tokensCss = stripCssComments(readFileSync(join(ROOT, 'lib', 'tokens.css'), 'utf8'))
} catch (e) { /* 下面断言会明确报出来，不静默通过 */ }
check('lib/tokens.css 存在（页面令牌的权威源）', tokensCss.length > 1000)

if (tokensCss) {
  const pageCss = stripCssComments(page)
  // 页面的静态色阶（--nb-*）在这里定义，用来把 var() 展开成具体色再比。
  const ramp = cssDecls(cssBlock(pageCss, /(?:^|\n)\s*:root\s*\{/))
  const resolveVar = (v, seen) => {
    seen = seen || new Set()
    const m = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(String(v).trim())
    if (!m || seen.has(m[1])) return v
    seen.add(m[1])
    return ramp[m[1]] ? resolveVar(ramp[m[1]], seen) : v
  }
  for (const [label, pageRe, tokRe] of [
    ['亮色', /(?:^|\n)\s*:root\s*\{/, /(?:^|\n)\s*:root\s*\{/],
    ['暗色', /:root\[data-theme='dark'\]\s*\{/, /(?:^|\n)\[data-theme='dark'\]\s*\{/]
  ]) {
    const pv = cssDecls(cssBlock(pageCss, pageRe))
    const tv = cssDecls(cssBlock(tokensCss, tokRe))
    const bad = []
    let compared = 0
    for (const k of Object.keys(pv)) {
      if (!k.startsWith('--dsw-alias-')) continue
      if (!(k in tv)) continue
      compared++
      if (normColor(resolveVar(pv[k])) !== normColor(tv[k])) {
        bad.push(`${k}: 页面=${normColor(resolveVar(pv[k]))} tokens.css=${normColor(tv[k])}`)
      }
    }
    check(`page.html 的${label}令牌与 lib/tokens.css 逐条一致（比对 ${compared} 条）`,
      compared >= 10 && bad.length === 0, bad.join(' | '))
  }
}

// ── 演示页（docs/demo.html）不能悄悄腐烂 ────────────────────────────────────
//
// 2026-10-08 的真实事故：那一轮 UI 重构把 page.html 结尾的启动行从 `tick();` 换成
// async IIFE，scripts/make-demo.mjs 的字面量锚点当场失效 —— 而这里当时没有覆盖，
// 于是 CI 全绿、README 指向的演示页却生成不出来、内容停在旧界面，整整一个版本
// 没人发现。现在：锚点必须命中；提交的 demo.html 必须等于"拿当前 page.html 现算
// 一遍"的结果（时间戳归一化后逐字节比）。只要 page.html 再动结构而生成器没跟上，
// 这里立刻红。
try {
  const { buildDemo, normalizeDemo, BOOT_ANCHOR } = await import(pathToFileURL(join(HERE, 'make-demo.mjs')).href)
  check('make-demo 的启动块锚点仍能命中 lib/page.html', BOOT_ANCHOR.test(page))

  const built = normalizeDemo(buildDemo(page, 1760000000000))
  let committed = ''
  try { committed = normalizeDemo(readFileSync(join(ROOT, 'docs', 'demo.html'), 'utf8')) } catch (e) { /* 下面报 */ }
  check('docs/demo.html 与当前 lib/page.html 的构建结果一致（跑 npm run demo 更新）',
    committed.length > 0 && committed === built,
    committed.length ? '演示页已过期，请跑 npm run demo' : 'docs/demo.html 不存在或读不到')
  check('演示页不注册 service worker', !/serviceWorker\s*\.\s*register/.test(committed))
  // ⚠️ 这里**绝不能**写真实令牌的字面量：这是公开仓库，写进去就等于把凭据前缀
  // 一起发布。（2026-10-08 我真这么干了，是推送前扫描把自己抓出来的。）
  // 改用令牌的**形状**匹配 —— 挡住真实数据泄漏的效果一样，但本身不含秘密。
  check('演示页不含真实数据（令牌形状 / 本机路径 / 中继目录）',
    committed.length > 0 && !/c_0_[A-Za-z0-9]{16,}|D:\\+Projects|taskwatch-relay/.test(committed))
  check('演示页带上"非真实数据"的自述', /演示数据/.test(committed))
} catch (e) {
  check('演示页生成链可用（生成器可被导入并构建）', false, e.message)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
