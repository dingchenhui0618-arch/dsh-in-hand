# 更新日志

本文件从 v1.6.0 起记录；更早版本（v1.1.0 – v1.5.2）的发布说明在 GitHub Releases。

## 未发布 — DSH Web 端口固定为 3080

### 部署（本机配置 + 文档，无代码改动）

- **查清了端口的真实来源**：桌面版把 `--port 0` 写死在 `app.asar` 的
  `@deepseek-ai/dsh-desktop-host/lib/index.js`（OS 每次随机挑端口），而 `app.asar` 里
  **没有** `DSH_PORT` / `DSH_WEB_PORT` 之类的环境变量入口（全文搜索 0 命中），配置文件
  也没有端口字段。真正的可改点是 `@deepseek-ai/dsh-web-app/cordis.patch.yml` 的
  `webserver` 行（`port: !!js ctx.webStartup.port ?? 3080`），用户补丁层可以整段覆盖它。
- 本机已在 `~/.dsh/profiles/desktop/cordis.patch.yml` 覆盖该行、把 `port` 固定为
  **3080**，并把 `tls` / `compression` / `compressionLevel` / `compressionThresholdBytes`
  原样写回（补丁层是整段替换 config，不写回等于删掉）。保存后该 profile 是 live 生效的，
  DSH 当场在 3080 重新监听：实测 `curl http://127.0.0.1:3080/` → 401、
  `/taskwatch/data` → 200。
- **顺带找到手机页 502 的真实原因**：中继的实际上游不是用户级 `RELAY_UPSTREAM` ——
  `~/.dsh/autostart/services-watchdog.ps1` 拉起中继时把它写死成
  `http://127.0.0.1:19387`（3080 退役时的临时值），而桌面版的端口早已是随机的。
  已改为 `http://127.0.0.1:3080`，并删除用户级 `RELAY_UPSTREAM`（让默认值唯一）；
  看门狗的 `dsh-desktop-host` 探测端口同步改为 3080。
- README 新增「DSH Web 端口固定为 3080」一节，写清「改端口要三处联动」：
  `webserver` 行的 `port`、看门狗里的 `RELAY_UPSTREAM`、以及该文档。

### 升级注意

- 中继的 `UPSTREAM` 是启动时读取的模块常量，改环境变量不会热生效：**改完必须重启一次中继**
  （它由看门狗托管，杀掉后 15 秒内自动拉起）。
- 3080 被别的程序占用时桌面版会 bind 失败、Web 界面起不来；`curl http://127.0.0.1:3080/`
  先确认是谁在应答。

## v1.7.5 — 去掉入口自动跳转，修复反复刷新

**根因（代码坐标是改前的 `lib/page.html`）**：双入口脚本把「该走哪条路」的判断写进
`apply()`（L4718–4721），而 `apply()` 不只在点胶囊时调用 —— 初始加载读完
`/taskwatch/entries` 会调一次（L4812），每 12 秒的 `/taskwatch/upstream-health` 体检
回来还会调一次（L4766 / L4770）。判断结果不是 `stay` 就 `POST /taskwatch/ticket`
（L4726）然后 `location.href = j.url`（L4739）。两条路对「这条路通不通」的判断一旦
互相矛盾（远端体检 `{ok:false}` → 判「去局域网」；局域网这条请求报错 → 判「回远端」），
页面就会 A→B→A 无限往返 —— 现象正是地址栏来回变、整页反复刷新。旧的三态偏好
（`tw-route-pref`）也会在加载时按「固定入口」直接换路，属于同一条路径。

### 手机页

- **加载时绝不导航**：`apply()` 现在只渲染胶囊；入口清单的 `.then` 里不再有体检、
  定时器或签票。初始加载路径上没有一条分支会改地址。
- **切换只由用户点选触发**：胶囊点开是小菜单，列出「远端 / 局域网」两条入口
  （当前项标「当前」，另一项标「切换」）。点另一项 = 签一张票 + 跳一次。
  自动模式已删除（不再用「刚才通不通」猜）：页面不再请求 `upstream-health`，
  也没有 12 秒轮询与「固定入口」三态循环。
- **8 秒护栏**：跳转前把 `{at, to}` 写进 `sessionStorage['tw-route-jump']`；
  8 秒内再点只给静态提示「刚刚切换过，N 秒后才能再切」，**不签票、不跳**。
- **`?t=` 落地清理与锁定**：URL 带 `?t=` 时立刻 `history.replaceState` 清掉参数，
  并把入口锁成当前项（`sessionStorage['tw-route-lock']`）；地址匹配优先、锁兜底，
  锁定项不再参与任何判断。
- `lib/sw.js` 的 `CACHE` 升到 `taskwatch-v15`；`docs/demo.html` 重新生成。

### 自检

- 新增 `scripts/check-no-autonav.mjs`：静态断言换路脚本只有一处改地址（且在
  `navigateOnce` 里）、无 `reload/assign/replace`、无定时器、初始加载分支不导航不签票；
  再用 Chrome headless + CDP 真加载 `page.html`，mock 出「旧代码会立刻往返」的信号，
  断言 20 秒（虚拟时间）内主框架只导航 1 次、没签过票；另测 `?t=` 清理与锁定、
  8 秒护栏、手动切换只跳一次且不会跳回来。已接入 `npm run check`。
- 真实渲染截图（CDP、390 宽）在 `D:\Projects\_ui-review\round6\`。

### 升级注意

- `page.html` 由插件宿主 / 中继从磁盘读取，升级后**新开页面**才会拿到新外壳；
  已装成 App 的手机需要**关掉页面再打开**一次，新 service worker 才会接管。

## v1.7.4 — 刷新 service worker 缓存（修复页面改动不生效）

- CACHE 由 taskwatch-v13 升到 taskwatch-v14：此前所有页面改动都被旧 SW 缓存挡住，
  手机上看到的仍是旧 HTML/JS，点切换仍按旧逻辑报错。
- 升级后首次打开会自动换新缓存；若仍显示旧版，关闭页面再打开一次。

## v1.7.3 — 票据入口参数与 lanUrl 修正

**结论先说**：页面与服务端的票据字段**本来是一致的**（都是 `to`），本次没有改接口；
真正被修掉的是 `lanUrl` 的**静默失效**，以及"配错时没有任何提示"这件事。

### 修复

- `normalizeLanUrl` 之前直接复用 `normalizePublicUrl`（只收纯 origin），于是最自然会写的
  `http://10.0.51.18:3099/taskwatch` 被悄悄丢弃，再回落到自动探测内网 IP ——
  现象就是「配了 lanUrl 但条目还是宿主的 58996」。现在允许并只允许入口自己的
  `/taskwatch` 后缀（entries / ticket 还会再拼一次，否则会变成 `/taskwatch/taskwatch`）；
  其它路径仍然无效。
- `publicUrl` / `lanUrl` 配了却归一化成空时，启动日志打一条告警（只写键名与预期形态，
  不回显值）。以前的静默回落是这类问题最难查的地方。
- 新增 `scripts/check-contract.mjs`：静态钉住页面 `fetch('/taskwatch/ticket')` 发的是
  `{to: ...}`、服务端读的是 `body.to`；并用真实 HTTP 覆盖 `lanUrl` 带/不带 `/taskwatch`
  两种写法的入口清单与票据 URL。已接入 `npm run check`。

### 排查记录（给下一次省时间）

- `POST /taskwatch/ticket {"to":"remote"}` 在 1.7.2 宿主上实测返回 200 + `url`，
  之前记录的「空响应体」是命令行引号问题，不是契约不一致。
- 公网 `…/taskwatch?t=v2.…` 返回 401 的根因**不在插件**：3099 上的中继进程是 10/19
  启动的旧版，只认自己 Map 里的随机票（它自己签出的 `t` 是 24 字符随机串，不是 `v2.`）。
  中继不会热更新，重启后才加载 v2 校验。

## v1.7.2 — 票据 HMAC 互认

**根因**：宿主签的换路票打到公网（域名后面是中继）→ 中继只认自己进程内 Map 里的
随机串 → 401。两个进程不可能共享内存，所以票必须**自己能证明自己**。

### 票据格式（两边一致，`lib/ticket.js` / 中继 `server.mjs`）

```text
t = 'v2.' + <expMs 十进制> + '.' + <nonce base64url> + '.' + <hmac base64url>
HMAC = HMAC-SHA256(secret, 'v2|' + expMs + '|' + nonce)
nonce = crypto.randomBytes(16)
```

校验：格式 `^v2\.\d{13}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}$` → `timingSafeEqual`
比 HMAC → `expMs > now` → `expMs - now <= 180000`（60 秒 TTL + 时钟偏差）。
签名不对 / 过期 / 格式不符一律当作「不是本票」；只有非 `v2.` 形状才回落到原来的
进程内 Map，所以老页面、老票仍然能用。

### 跨进程互认的边界

- 短时效（60 秒）+ HMAC 签名 + **各自进程内**的已用 nonce Set（带 TTL 清理）。
- **不是严格一次性**：跨进程没有共享的「已用」状态，一张从未被这两个进程见过的票
  在窗口内理论上可重放一次。要严格一次性得引入共享存储（Redis / SQLite），
  当前换路场景不划算。README「安全边界」已如实写明。

### 密钥文件与权限

- 解析顺序（宿主与中继完全一致）：`TASKWATCH_TICKET_SECRET`（≥32 字符）→
  `<用户主目录>/.dsh/taskwatch-ticket.key`（UTF-8、`trim`、≥32 字符）→ 都没有时
  由**先用到的一方**生成 `crypto.randomBytes(32).toString('base64url')` 并写入该文件。
- Windows 下生成后用 `icacls <file> /inheritance:r /grant:r <当前用户>:F` 只留当前用户；
  Linux/macOS 用 `chmod 600`。
- 该文件**绝不能被任何 git 仓库跟踪**：插件 `.gitignore` 增加 `taskwatch-ticket.key`
  与 `*.key`（只写模式，不含真实路径）；README 说明文件位置与权限。
- 密钥按需初始化：只读监控不换路时不需要它，也不在启动时写用户主目录。

### `lanUrl`（可选）

- 新配置项 `lanUrl`（也支持 `DSH_TASKWATCH_LAN_URL`）：配了就把 `entries` 的局域网
  条目换成它，不再自动探测内网 IP；`ticket {to:'lan'}` 也返回 `lanUrl/taskwatch?t=…`。
- 典型用法是指向中继的局域网入口，这样宿主签的 v2 票由中继验签兑换。
- **插件自己的路由没有令牌门**（授权在中继那层），README 明确建议把 `lanUrl` 指到有
  鉴权的中继，而不是指回插件宿主自身。

### 测试与发布

- 新增 `scripts/check-ticket-hmac.mjs`（真实 handler + 临时端口）：
  宿主签 → 中继实例验、中继签 → 宿主验、篡改签名拒绝、过期 / 超长跨度拒绝、
  老格式随机票仍走 Map、密钥文件自动生成（只断言存在 + 长度，不打印内容）。
  中继那一侧在本机存在时**真的 spawn 临时端口实例**（不碰 3099），测完杀掉；
  中继目录不在本机时两条跨实例断言明确 SKIP。
- `package.json` 的 `check` 串上这份测试；`npm run demo` → `npm run check` 退出码 0。

## v1.7.1 — 修复「去远端」不停报错

**根因（已实测确认）**：手机页的入口切换会调 `POST /taskwatch/ticket`（`lib/page.html`）
与 `GET /taskwatch/entries`，而这两条接口**只有中继（`taskwatch-relay`）实现**，插件宿主
里没有。于是从宿主页面（例如 `http://127.0.0.1:52676/taskwatch`）点「去远端」拿到的是
405 / 404，没有 `j.url`，探测循环每 12 秒再重试一次 —— 用户看到的就是「点了去远端，
一直报错」。实测：宿主 `POST /taskwatch/ticket` → 405，`GET /taskwatch/entries` → 404；
中继两者 → 401（存在，只是要令牌）。

### 宿主侧（`lib/index.js`）

- 新增 `GET /taskwatch/entries`：`{ok:true, entries:[{kind:'remote'|'lan', label, url, current}]}`。
  公网地址只来自插件配置项 **`publicUrl`**（也支持环境变量 `DSH_TASKWATCH_PUBLIC_URL`），
  代码里不写死任何域名；**没配就只报局域网一条**。同时保留中继的 `remote` / `lan` / `current`
  字段，同一份页面在两种外壳下都能读。
- 新增 `POST /taskwatch/ticket`：签发 **60 秒有效、一次性** 的票据，返回
  `{ok:true, url:'<publicUrl>/taskwatch?t=<ticket>'}`；`{to:'lan'}` 也支持（同网段优先）。
  没配 `publicUrl` 时远端请求明确回 **409 `no-public-entry`** + 中文错误。
- `GET /taskwatch?t=`：命中票据 → **302 到 `/taskwatch` 并 Set-Cookie**（与中继同形），
  兑换即删、重放无效；未知 / 过期票据 → **401**（与中继的选择一致）。
- 写路由门禁沿用现有写法：`POST` + `application/json`，另加 `Origin` / `Sec-Fetch-Site`
  同源校验；宿主仍不做令牌校验（401 由中继负责）。
- 契约测试新增 `scripts/check-entries.mjs`（真实 `node:http` + 真实 handler，临时端口），
  `scripts/check-bundle.mjs` 的路由白名单同步：只读组加 `/taskwatch/entries`，新增
  「非对话写」组放 `/taskwatch/ticket`，对话路由仍固定 14 条，并新增强制归类的断言。

### 手机页（`lib/page.html`）

- `ticket` / `entries` 返回 **404 或 405** → **不重试**，进入**静态降级**：胶囊按
  「只有一个入口」隐藏，**不报错、不弹提示**，轮询定时器一并清掉。
- 降级态在会话设置 / 任务详情里给一行静态说明：「当前页面由插件宿主提供，远端切换需要
  中继接口」，并附上手动「去远端」链接。
- 上次成功切换的远端地址记进 `localStorage['tw-remote-url']`（只认 `http(s)`），
  降级态里有记忆才显示那个链接。
- 其它错误（500 / 502 / 网络错误）同一句 **30 秒内只提示一次**，换路失败后冷却 30 秒
  再试，不进入重试风暴；`upstream-health` 的 404 按「未知」处理并停掉探测，**不**误判成
  「这条路断了」。
- 44px 命中区、无横向滚动、明暗两套保持不变（真实渲染截图验证：390 宽、CDP、真 Chrome）。

### 未覆盖 / 边界

- 插件宿主不实现 `GET /taskwatch/upstream-health`（仍只在中继侧），所以宿主页面不做自动
  体检切换，只能手动换路。
- `publicUrl` 需要指向**宿主自己的公网入口**；若指向中继，中继不认宿主签发的票据。
- 升级后需要重启 DSH 才生效；发布时线上宿主仍是旧进程（`/taskwatch/ticket` 仍 405）。

## v1.7.0 — 注入/代码信息折叠、两行头栏、消息队列与「立即发送」

### 手机端

- **工具卡默认折叠成一行**（44–46px）：`状态 · 名称 · 时间 · 完成 · 展开`，摘要里不含命令正文；
  正文用 `display:none` 真隐藏，展开/收起选择在 `pending → ok` 更新时保留，复制仍取完整原文。
- **注入类内容压成一行**：`系统注入`、`会话摘要`、system-reminder、技能清单、运行上下文都折成
  一行可展开的摘要，**不删原文**；用户气泡里超过 3 行的代码默认折 3 行。
- **头栏从 3–4 行压到 2 行**：工作区·模型降级为 12.5px 次要文字，入口胶囊移进标题行（不再压住内容）。
- **状态卡**：去掉无信息量的虚线段，整卡可点并带箭头。
- **连接质量三点**：绿（15s 内有帧）/ 黄（无帧但请求仍 200）/ 红（失败），tooltip 显示重连次数。
- **发送键在跑时变方形停止键**（调 `/taskwatch/chat/cancel`），按下 1px 位移，失败有中文提示。
- **字号三档**（小/中/大，`:root` 缩放，记忆在本地）；**草稿按会话自动保存与恢复**。
- **消息队列 UI**：`排队 N 条 · 展开` → 逐条上下箭头重排（乐观更新，`409 queue-changed` 按 `current`
  回滚）、`steering` 标"已插队"不可重排、长按发送键弹「打断并发送」。**宿主未提供队列接口时整块不渲染**。
- 视觉：消息按发送者分组（组首才显示时间）、Markdown 标题降一档字重、底部指标主次分明（在跑/上下文/
  缓存命中加粗，点击展开真实字段）、新消息 120ms 淡入，`prefers-reduced-motion` 下关闭全部动效。
- 参考 reactbits 的状态条渐变描边 + 玻璃内高光、卡片按压、运行呼吸环、选中行高亮；未引入任何依赖。

### 宿主侧

宿主侧（本次只改宿主，`lib/page.html` 由另一路改动接手）

- 新增 `GET /taskwatch/chat/queue?sessionId=`：读宿主 `Agent.inbox` 里未领取的
  `nextTurn`（下一轮队列，可排序）与 `nextStep`（已插到本回合下一步的 steering）
- 新增 `POST /taskwatch/chat/queue/reorder`：`{sessionId, ids:[...]}`，按完整 id
  列表整体重排 `nextTurn`；集合不符时 409 并要求刷新，避免把已领取的消息插回去
- `/taskwatch/chat/send` 新增 `now:true`：走宿主原生 `mode:'steer'` 插队，不中止
  正在跑的工具/模型调用；`interrupt:true` 则先 cancel（保留队列）、等 idle 再
  steer，2 秒停不下来就 409 且不发消息
- 错误可分辨：400 参数 / 404 会话不存在 / 409 队列不可用或已变化 /
  501 宿主缺服务 / 502 宿主拒绝。新路由与 `send` 共用同一套 POST + JSON 入口
- 契约测试新增 `scripts/check-queue.mjs`，`npm run check` 已接入

边界

- 宿主的 Remote `sessionController.updateQueue` 只有 edit/remove/steer，**没有换位**；
  重排走的是 dsh-agent 文档化的 `Agent.inbox.splice`，因此只对 live agent 有效
- 宿主不鉴权（只监听回环），401 由中继负责；本次没有新增任何令牌校验

## 1.6.0 — 2026-10-12（双入口切换按钮 + SW 不再缓存 502 + 局域网直连）

手机页右上角多了一个能换路的胶囊，离线外壳不再可能吃出旧 502 页，配套中继新增了
局域网直连这条路。

双入口（手机页）
- 右上角胶囊显示当前走的是哪条路（远端 / 局域网），点一下在 **自动 → 固定局域网 →
  固定远端** 之间循环，选择记在 `localStorage`（键 `tw-route-pref`）
- 自动规则只依据两个信号 —— 这条路刚才通不通、你上次选了哪条：远端路上
  `GET /taskwatch/upstream-health` 体检失败就切局域网（若可用）；局域网路上请求失败
  就切回远端。能用的那条路不会被主动换掉
- 换路**不需要重输 6 位配对码**：先向中继要一张 60 秒有效、一次性、兑换即作废的凭据，
  跳过去时换成那条路的 cookie
- 为什么不做主动探测：浏览器按混合内容拦掉 https 页面探测 `http://` 内网地址，而中继
  经隧道看到的来源永远是 `127.0.0.1`
- 整段是独立 IIFE，只在经中继访问时出现；任何异常只让它自己不显示，不影响页面其它功能

Service Worker（`lib/sw.js`）
- 不再"拿到什么就存什么"：只有 `res.ok` 的响应才写进外壳缓存，非 2xx 时用缓存里的外壳
  兜底。此前中继或上游抖一下的那次 502 会被存成外壳，之后手机离线导航就吃出那张旧 502
  页 —— 看着像"又断了"，其实服务端早就好了，而且从服务端完全查不出来
- `CACHE` 升到 `taskwatch-v13`：activate 里删掉非当前版本的缓存，把已经存进去的 502 清掉

配套中继（另一仓库 `dsh-in-hand-relay`，代码不在本仓库）
- 新增三个需要中继令牌的接口：`GET /taskwatch/entries`（入口清单与当前入口）、
  `POST /taskwatch/ticket`（换路凭据，60 秒一次性）、`GET /taskwatch/upstream-health`
  （上游体检）
- 新增**局域网模式**：中继目录出现 `.lan` 标记文件（或 `RELAY_LAN=1`）时，从只监听
  `127.0.0.1` 改为绑定 `0.0.0.0`（启动时读，改完需重启中继）；手机在同一 Wi-Fi 下直连
  `http://<内网IP>:3099/taskwatch`，复用同一套 6 位配对码。`/taskwatch/lan` 是
  **不含任何凭据**的说明页，`/taskwatch/lan.json` 是同一份数据的 JSON
- 中继自己发的那条 502 带 `x-taskwatch-hop: relay`，用来和服务器 nginx 发的 502 区分

兼容性
- `lib/page.html` 与 `lib/sw.js` 都是每次请求重读，所以这两处改动**不需要重启宿主**
- 双入口胶囊依赖中继侧那三个接口；中继没升级时按钮不出现，页面其余功能不受影响
- 局域网直连走 `http://`，不是安全上下文：没有 PWA / service worker / 摄像头 / 剪贴板

未验证
- 本文所述均为仓库内代码可核对的行为；换路与局域网直连在真实手机 + 路由器组合上的
  端到端表现未由本次发布复核（**未验证**）
