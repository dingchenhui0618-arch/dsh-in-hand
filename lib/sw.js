// 掌上 DSH（dsh-in-hand）的 service worker。
//
// 与 lib/page.html 一样只留一个来源：插件从磁盘读它对外提供，部署侧的中继也读
// 同一个文件，所以不会像内联副本那样慢慢漂移。
//
// 离线策略有意做得保守：外壳可离线打开，但状态数据永远走网络。对监控而言，
// 看到过期状态比看到断连更危险，所以断网时返回一份**显式的** offline 快照，
// 让人一眼看出「这是没读到，不是真的没任务」。
//
// ⚠️ CACHE 版本号同时是页面更新的开关。SHELL 里的 /taskwatch 是 cache-first，
// 改了 lib/page.html 却不升这个号，已安装的客户端会一直吃旧页面。只升号还不够：
// activate 里必须删掉非当前版本的缓存 —— caches.match() 不指定 cache 时会搜索
// **全部**缓存，残留的旧缓存照样会被命中。
const SHELL = ['/taskwatch', '/taskwatch/icon-192.png', '/taskwatch/icon-512.png']
// v8：install 不再用原子性的 addAll，并在 activate 时**强制重载已打开的页面**。
//
// 起因（2026-10-08 实测）：手机上装成 App 的页面一直停在只读的旧版，而服务端
// 发出的 page.html 与 sw.js 都已经是新版、两者字节完全一致。也就是说旧 SW 手里
// 那份 cache-first 的页面永远等不到替换 —— 两种情况都会造成死锁：
//
//   1. 新 SW 的 install 里用 c.addAll(SHELL)，它是**原子**的：只要三个 URL 里有
//      一个当时没取到（手机切网、隧道抖动），整个 install 就失败回滚，旧 SW 继续
//      掌权，然后每次导航重复失败。
//   2. 即使新 SW 装好并 skipWaiting + clients.claim 接管，**已经打开的那个页面
//      本身不会重新载入**，用户看到的仍是旧页面，很容易判定成"没生效"。
//
// 所以：install 改成 allSettled（取不到的项留着，下次再说），activate 里补一次
// 主动重载。activate 只在新版本接管时触发，不会来回刷。
// v9：换成 DSH 的虎鲸标。图标在 SHELL 里是**预缓存**的，所以不升这个号，
//     已经装到桌面的手机永远显示旧图标 —— 换 logo 必须跟着升版本。
// v10：页面新增交付文件渲染（对话里直接铺图、PDF 给可点卡片）。外壳是 cache-first，
//     不升号的话装到手机桌面的 PWA 会继续拿旧页面，功能上了也看不见。
// v11：页面新增动效层（纸墨微动）。图标是 cache-first 的，而换的正是发送键/空态
//     这些**在壳子里**的东西，所以同样要升号才保证已安装的客户端拿到新版。
// v12：activate 里那次「主动重载已打开的页面」被删掉了 —— 它会**自我死锁**。
//
// 起因（2026-10-10 真机实测，是"手机页打不开、一直卡"的真凶）：
//   activate 里 await Promise.all(clients.matchAll(...).map(c => c.navigate(c.url)))
//   —— activate 在等这次导航结束，而这次导航又要由**尚未完成 activate 的**这个 SW
//   来接管，两边互等。结果是注册永远停在 active.state === "activating"，
//   从此**所有 scope 内的导航**（也就是整个 /taskwatch）都拿不到响应：浏览器一直转，
//   而同一个 URL 用 curl 或从 scope 外 fetch 只要 110ms，服务端一切正常、完全查不出来。
//   实测证据：解除注册后同一页面 329ms 打开；受这个卡住的 SW 控制时 30s 超时。
// 那次重载是 cache-first 时代的补丁（旧外壳永远不会自己变新）。现在页面已经是
// **网络优先**（见下面 fetch 里的注释），每次导航本来就取新版，这个补丁既没必要、
// 又足以把整站打死。别再加回来。
// v17（v1.7.7）：页面换了正文图片的兜底渲染（坏图 → 44px 以内提示条）与抽屉图标
//     （字符字形 → 内联 SVG）。外壳里的 icon-192 也是预缓存的，一起升号清掉旧壳。
// v18（v1.7.8）：图片流光的包含块修好（长会话不再整屏闪）+ 附件信封改成图片卡。
// v20（v1.8.0）：手机端新增一次性审批（批准 / 拒绝 + 二次确认 + 倒计时）。这是
//     外壳里的交互，不升号的话装到桌面的 PWA 会继续拿旧页面，看不到按钮。
const CACHE = 'taskwatch-v20'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 用 allSettled 而不是 addAll：addAll 是原子的，一个 URL 失败会让整个
      // install 回滚 —— 那正是 2026-10-08 手机卡在旧页面上的原因之一。
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys()
    // 只清自己前缀的缓存。CacheStorage 是**按源共享**的，缓存名全局唯一，
    // 无条件删除会把同源下任何其它应用的缓存一起干掉 —— 现在 DSH GUI 自己
    // 不用 service worker 所以看不出后果，但中继源或以后同端口挂别的应用时
    // 这就是真实的跨作用域误伤。
    await Promise.all(keys
      .filter((k) => k.indexOf('taskwatch-') === 0 && k !== CACHE)
      .map((k) => caches.delete(k)))
    await self.clients.claim()
    // 这里**故意不做**「重载已打开的页面」。曾经有一版这么写：
    //   const cs = await self.clients.matchAll({ type: 'window' })
    //   await Promise.all(cs.map((c) => c.navigate(c.url)))
    // 它在 activate 里等一次由自己接管的导航，形成自我死锁：注册永远停在
    // "activating"，scope 内所有导航一起挂死（v12 的注释里有完整实测记录）。
    // 页面现在是网络优先，不需要这种重载，所以也不该为它冒这个风险。
  })())
})

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return

  // 单会话对话：只走网络，永不缓存。断网时要回**会话形状**的错，而不是 data 形状的
  // 空快照 —— 两者的字段不一样，回错了前端读不到 error，只会显示成「没有消息」。
  if (u.pathname === '/taskwatch/session') {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({
      id: '', live: false, total: 0, messages: [],
      error: '离线：读不到 DSH，无法读取会话',
    }), { headers: JSON_HEADERS })))
    return
  }

  // 状态快照：同样只走网络，断网回一份显式的离线空快照。
  if (u.pathname === '/taskwatch/data') {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({
      generatedAt: Date.now(),
      offline: true,
      errors: ['离线：读不到 DSH，数据未刷新'],
      totals: { sessions: 0, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
      sessions: [], jobs: [], subagents: [], pending: [], workflows: [],
    }), { headers: JSON_HEADERS })))
    return
  }

  // 对话接口一律**不碰**：只走网络，绝不缓存、绝不包一层。
  // 尤其是 /taskwatch/chat/stream —— 它是一条长连接的 SSE，被 service worker
  // 经手就会退化成"等整段读完再给"，流式效果全丢。POST 在函数开头已经被方法
  // 判断放行了，这里再显式拦一次，防的是以后有人加一条 /taskwatch 下的通配规则。
  // v1.8.0 的审批 SSE 同理，显式放过。
  if (u.pathname.indexOf('/taskwatch/chat/') === 0 || u.pathname === '/taskwatch/approvals/stream') return

  if (SHELL.indexOf(u.pathname) >= 0) {
    // 页面本身走**网络优先**：先取新的，失败（离线）才回缓存。
    //
    // 原先是 cache-first + 手工升 CACHE 版本号。那个开关很难不出错 ——
    // 2026-09-22 这一轮就踩了两次：改了 page.html 忘了升号，已安装的手机一直
    // 吃旧页面，而服务端一切正常，从外面完全查不出来。页面只是几十 KB 的本地
    // 文件，多一次往返可以忽略，换来的是"改了就生效"。
    if (u.pathname === '/taskwatch') {
      // 2026-10-12：只把**成功**响应写进外壳缓存。
      //
      // 以前是"拿到什么就存什么"，于是中继或上游抖一下的那次 502 会被存成外壳。
      // 之后手机只要离线导航，就吃出那张 502 页面 —— 看着像"又断了"，其实服务端
      // 早就好了，而且从服务端完全查不出来（缓存里的旧响应）。
      // 现在非 2xx 时不写缓存，并改用缓存里的外壳兜底：界面照常渲染，数据接口
      // 自己会报它该报的错。CACHE 版本号跟着升到 v13，把已经存进去的 502 清掉。
      e.respondWith(
        fetch(e.request)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone()
              caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {})
              return res
            }
            return caches.match(e.request).then((hit) => hit || res)
          })
          .catch(() => caches.match(e.request).then((hit) => hit || Response.error()))
      )
      return
    }
    // 图标很少变，仍然 cache-first，省一次往返。
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)))
  }
})
