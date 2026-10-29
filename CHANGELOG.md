# 更新日志

本文件从 v1.6.0 起记录；更早版本（v1.1.0 – v1.5.2）的发布说明在 GitHub Releases。

## v1.8.6 — 票据受众绑定与严格一次性

### 为什么改（2026-10-29）

v1.7.2 的 v2 票据解决了「宿主签的票中继不认」，但证明确实留了两个缺口：

1. **跨入口重放**：票据用同一把 HMAC 密钥签发，中继与插件却**各自独立**校验，票里也没有
   「受众」。给局域网入口签的票，在 60 秒有效期内可以被拿去兑换公网中继（反之亦然）；
   两边不共享 nonce 记账，所以谁都不知道对方已经用过。
2. **单进程内的原子性**：校验与「标记已用」只要分成两步，同一进程内就存在极短窗口的重放。

### 票据格式：v3（`lib/ticket.js`）

- `v3.<expMs>.<nonce>.<aud>.<hmac>`，HMAC = HMAC-SHA256(secret, `'v3|' + expMs + '|' + nonce + '|' + aud`)。
- `aud ∈ { remote, lan }` 表示**校验方身份**，不是入口名字：公网中继只收 `remote`，
  插件宿主只收 `lan`。受众不符一律 401，文案不回显原因，原因只进日志。
- 受众按「谁兑现这张票」判定（端口 + 本机地址）：`publicUrl` 指向中继 → `remote`；
  局域网直连回宿主自己 → `lan`；`lanUrl` 指到中继时同样是 `remote`。

### 严格一次性

- 新增 `redeemTicket(secret, ticket, { aud, guard })`：解析 → 受众 → 验签 → 时效 → 记账，
  全在**一个同步函数**里，中间没有 `await`；`claim()` 在同一次调用里「查 Set + 写 Set」。
- 记录带过期时间：`claim` 时按需清理 + 30 秒一次的后台定时器（`unref`，不拖住进程退出）
  + 容量硬上限，Set 不会无限涨。
- 已用过的票再来 → 401，并记一行 `replay attempt`（只写受众与版本，**不含票面**）。

### 兼容：升级顺序任意，任何时刻都不锁门

- v2 票在过渡期内继续接受（没有 aud，无法绑定）。**过渡期截止 `TICKET_V2_SUNSET_AT`
  = 2027-01-01T00:00:00Z**；此后 v2 一律拒绝。插件与中继用的是同一个日期，改日期必须两边一起改。
- 插件默认**仍签 v2**，只有中继亲口声明支持 v3 才签 v3：探测
  `GET <中继>/taskwatch/lan.json` 的 `ticketVersions` 是否含 3（免鉴权、无凭据）；
  探测失败 / 字段缺失 / 超时 1.5 秒 → 回退 v2。正向缓存 10 分钟、负向 60 秒。
- 中继侧同时接受 v3（`aud=remote`）与过渡期内的 v2，并在 `/healthz` 响应头
  `x-taskwatch-ticket-versions: 3,2`、`/taskwatch/lan.json` 与 `/taskwatch/ticket` 的
  `ticketVersions` / `ticketAudience` 字段里声明能力。
- 因此：旧中继 + 新插件 → 插件签 v2，旧中继照旧认（不会把 v3 当未知格式拒掉）；
  新中继 + 旧插件 → 旧插件的 v2 照旧认；两边都新 → 自动升级到 v3。

### 未改

`lib/client.js`、文件白名单、审批/问答失败语义、`DSH_TASKWATCH_ROOTS` 均未改动。

### 自检

- 新增 `scripts/check-ticket.mjs`（七组）：签发/兑换一次、二次 401；受众错配双向 401；
  篡改 exp/nonce/aud/hmac 与过期、超长跨度全部 401；同一 nonce 并发 10 次恰好 1 次成功；
  v2 过渡票期内可用、期后 `v2-sunset`；旧中继（无 `ticketVersions`）→ 签 v2 / 新中继 → 签 v3 /
  探测失败 → v2；注入时间的过期清理与容量上限。
- `scripts/check-ticket-hmac.mjs` 扩展到 v3：真实临时端口中继实例上验证「宿主 v2 → 中继 302」、
  「中继 v3 自兑一次 + 重放 401 + 宿主 401（受众）」、「中继声明 v3 后宿主签 v3 并兑换成功」。
- `npm run check` 退出 0。

### 未验证

- 生产中继进程重启（需管理员）后 v3 真正生效；
- 真机跨入口重放（手机在局域网入口拿到票、60 秒内去公网入口兑换）。

## v1.8.5 — 中继一键部署模板与三步指南（P3）

### 为什么改（2026-10-29）

P3 的目标是「部署降到一条命令」。真正卡人的不是中继本身，而是三份必须手写、且写错就
不安全的配置：systemd 单元、nginx（SSE 关缓冲 + 不把令牌记进日志）、以及「从零到手机能连」
的顺序。这一版把这半段固化成模板 + 可复制命令；**没有改任何运行时代码**。

### 新增（`docs/deploy/`，仓库文档，不进 npm 包）

- `README.md`：前提 + 三步（服务器初始化 / 装中继 / nginx + 证书）+ 手机首次配对 +
  自检 + 三条最常见故障（502、401、SSE 被缓冲）。
- `taskwatch-relay.service`：`Restart=always`、`EnvironmentFile=-/etc/taskwatch-relay/env`、
  `NoNewPrivileges=yes`、`ProtectSystem=strict`、`ReadWritePaths=/var/lib/taskwatch-relay`、
  `User=taskwatch`；每一项都在注释里写了为什么。
- `nginx.conf.example`：80→443、certbot 落点、`/taskwatch` 与 `/taskwatch/file` 代理、
  SSE 关缓冲（`proxy_buffering off` / `proxy_read_timeout 1h` / `proxy_http_version 1.1`）、
  `client_max_body_size 60m`、安全头、`$uri` 日志（不记 `?k=` 里的令牌）。
- `install-relay.sh`：Debian/Ubuntu 幂等安装；`openssl rand -base64 32` 生成令牌，
  env 600 root:root；`systemctl enable --now`；**不碰** `/etc/nginx`。
- `check-relay.sh`：只读五项自检（`/healthz`、`/taskwatch`、`/taskwatch/data`、
  `manifest.webmanifest`、图标）；失败只给状态与建议，**绝不打印令牌**。

### 文档

- 主 README「在外网 / 手机上访问」顶部加了一行指向 `docs/deploy/README.md`：
  「想省掉手写 nginx，用这条三步部署」。

### 自检

- `bash -n install-relay.sh`、`bash -n check-relay.sh` 均通过（远端 bash）。
- `systemd-analyze verify` 通过；仅有的告警来自服务器上无关的 `cloudmonitor.service`。
- 独立最小 nginx 配置 `nginx -t` 通过（nginx 1.30.2；`listen ... http2` 有弃用告警，
  不影响加载，模板注释里写了替代写法）。
- **未验证**：真的按文档装一台新服务器、certbot 首次签发、手机首次配对（见文档末尾）。

## v1.8.4 — 断线自动重连与陈旧提示（P2）

### 为什么改（2026-10-29）

手机的真实网络是抖动的：Wi-Fi 切 4G、锁屏十分钟回来、中继重启导致换端口或一段 502。
旧页面把 `EventSource` 交给浏览器自动重连，间隔不可见也没法暂停；快照失败还按固定
5 秒轮询，断得久了首页看起来就像「没有任务」。这一版把连接生命周期收回来：断线时
保留最后一帧，恢复后自动续上。

### 页面（`lib/page.html`）

- **自管 EventSource 生命周期**（会话流 + 审批 / 提问流）：出错先 `close()`，再按
  1s → 2s → 5s → 10s → 30s（每档 ±20% 抖动、30s 封顶）退避；`document.hidden`
  时暂停排期，`visible` 时立刻恢复。
- **`/taskwatch/data` 单飞 + 同一退避**：并发调用复用同一个 promise；失败后
  `nextAt` 未到之前，5 秒 tick 也直接跳过，不会叠加成请求风暴。
- **在线状态**：`online` 立刻取快照并重开事件流；`offline` 只更新状态 UI，
  不清 `HOME_GOOD`，也不清对话 DOM。
- **可见性恢复**：`visibilitychange → visible` 立刻 `fetch('/taskwatch/data')` 一次；
  `pageshow`（`persisted`）兜 iOS bfcache 回来不触发 visibility 的情况。
- **陈旧检测**：`lastOkAt` 超过 3 × 轮询周期（15 秒）时，页脚显示
  「连接已断开 · 正在重试（N 秒前成功）」+「立即重试」；恢复后自动消失。
- **连接三档**：复用现有 `.netq` 三点组件 —— 稳定（绿）/ 重连中（黄点 + 文案）/
  离线（红点 + 文案），重连中与离线不再只靠颜色。

### 自检

- 新增 `scripts/check-reconnect.mjs`（真 Chrome + CDP）：离线提示且旧内容仍在、
  `online` 后 5 秒内提示消失与 `lastOkAt` 更新、reload 后重连计数归零且退避严格
  递增、CDP 网络日志最大并发 = 1、`document.hidden` 期间不重连与不发请求、
  `visible` 后立刻补一次；16 项全部通过。
- `npm run check` 退出 0；`lib/sw.js` 的 `CACHE` 升到 `taskwatch-v24`，
  已安装的 PWA 下次打开才能拿到新外壳。
- `docs/demo.html` 用 `npm run demo` 重新生成（契约测试逐字节比对）。

### 未验证

- 真机 Wi-Fi ↔ 4G 切换、iOS 锁屏后的定时器节流（Safari 会冻结后台定时器）；
  页面用 `visibilitychange` / `pageshow` 兜底，但还没有真机实测。

## v1.8.3 — 手机端可回答选项式提问与计划审批（P0 补齐）

### 为什么改（2026-10-29）

P0 的第一类「放不放行」在 v1.8.0 做完了，第二类「选哪一个」还空着：`user-questions/request`
到手机页只剩一张「待回答」卡和一句「去回答」，点过去仍然要在桌面上选。于是补上——
不新写一套机制，直接复用审批那套 broker / 超时 / 审计 / 在线判定。

### 宿主（`lib/index.js`）

- **认领 `user-questions/request`**：`AskUserQuestionRequestEvent` 是 waterfall，手机页在线时
  插件返回 `{answers}` 认领它，否则 `next()`。失败语义与审批逐条一致：无手机在线立刻
  `next()`；超时（同一个 `approvalTimeoutMs`）`next()` 并审计 `by:'timeout'`；`signal`
  abort 立刻交还；任何内部异常 `try/catch` 后 `next()`。
- **`pending[]` 新增 `kind:'question'`**：`title`（`header` 或问题前 40 字）、`detail`、
  `options[]`（label + description）、`multiSelect`、`intent`、`expiresAt`、`canDecide`，
  以及给多题渲染用的完整 `questions[]`（每次拷贝标量、题数 ≤12、选项数 ≤24）。
- **`POST /taskwatch/answer`**：`{id, answers:[{id, selected, custom?}]}`。必须覆盖请求里
  所有题目；`selected` 只能取该题 `options[].label`；`multiSelect:false` 时 ≤1 项；
  `custom` ≤2000 字。不合规回 `400` 且带 `field`（`answers[1].selected` 这种），
  **校验失败不消费这次认领**。未知 id `404`；重复提交 `409`；过期 / 已交还 `410`。
- **审计**：提问单独一条 `{at, session, kind:'question', title, outcome, by,
  selectedCount, custom}`；不记选了哪一项、不记自定义回答原文。

### 页面（`lib/page.html`）

- 首页待办区、任务详情抽屉、会话页输入框上方的问答条都渲染同一份 `questionCardHtml`。
- 单选是整行按钮（label 一行、description 第二行、≥44px），点选后仍需按「提交回答」；
  多选可多选；多题纵排，没答完时提交禁用并标「待回答」；`intent.kind === 'plan-review'`
  带「计划审批」徽标，`intent.approve` 对应选项用主色强调。
- 自定义回答默认收起；倒计时 `mm:ss` 与审批一致，到 0 显示「已退回桌面」；提交成功收起
  为「已提交」；宿主回 `409` / `410` 显示「已由桌面处理」；网络失败保留已选项与草稿、可重试。
- `SW` 缓存升到 `taskwatch-v23`，已安装的 PWA 下次打开就能拿到新外壳。

### 自检

- 新增 `scripts/check-answer.mjs`：校验规则（缺失 / 非法选项 / 单选多值 / custom 超长 /
  重复 label / 未知题）、闸门控制流（离线 / 50ms 超时 / abort / 内部异常）、真实 HTTP
  （200 与宿主收到的 `{answers}`、400 + `field`、409 / 404 / 410、审计形状）、以及真 Chrome
  + CDP 页面断言（选项高度、计划审批徽标、未答完禁用提交、单选替换、多选、提交载荷）。
- `scripts/check-bundle.mjs` 把 `/taskwatch/answer` 显式归进非对话写路由；`npm run check`
  串上 check-answer。

## v1.8.2 — 首页改成待办优先（P1）

### 为什么改（2026-10-29）

打开手机页第一眼是一段对话。可人离屏的时候要看的是**现在有什么事在等我**：某条会话
跑完了没有、有没有东西卡在桌面上等我点一下。对话正文放在第二层就够了，第一层应该是
「在等你 / 在跑 / 继续上次」。

### 首页（新增）

- **标题位即概览**：`在等你 N 件`（N>0 用强调色），没有待办时是「暂时没有需要你的」。
  复用 header 的标题位，不另起横幅——390×844 的首屏每一行都付了租金。
- **待办区**：`待批准` / `待回答` 徽标 + 工具名 / 问题摘要 + 一句原因 + `expiresAt`
  倒计时；可决定的审批给「批准一次 / 拒绝」，问答项给「去回答」（跳到会话）。多件时
  只展开第一件，其余折成「还有 N 件」。
- **在跑区**：最多三条，标题 + 最新动作（工具名 · 第几步 · 后台任务数）+ 已运行时长，
  点进会话。
- **其他计数**：后台任务 / 子代理 / 今日轮次与步数，压成一行。
- **入口**：「继续上次会话」（`localStorage['taskwatch.session']` → 当前 → 第一个根会话）、
  「全部会话」（现有抽屉）。
- **断网不清空**：页面侧留一份"上次读到的好快照"，`offline:true` / `errors[]` 的兜底
  快照不会覆盖它；首页照旧显示旧状态，页脚补一条「连不上电脑 · 下面是你上次看到的状态」。
  审批语义、文件白名单、`DSH_TASKWATCH_ROOTS` 一律未动。

### 路由

- 无 hash = 首页；`#session/<id>` = 某个会话；刷新按 hash 恢复；深链接直接进会话。
- 首页 → 会话用 `pushState`（返回手势 / 浏览器返回直接回首页），会话之间换用
  `replaceState`（不堆历史条目）。
- 会话页顶部有明确的「返回首页」：header 最左边那颗按钮在首页是「全部会话」，在会话页
  变成向左箭头 + `aria-label="返回首页"`。不是把返回只留给系统手势。
- `#subagents` / `#subagents/<id>` 保持原样，列表页仍盖在主对话上。

### 数据（`/taskwatch/data`）

- 会话新增 `lastTool` / `lastToolAt` / `turnStartedAt` / `stepsInTurn`，顶层新增
  `today: {since, turns, steps, sessions, partial}`。
- 只对「在跑」或「今天动过」的会话读事件；按 `seq` 缓存，seq 不变直接复用；单次最多回看
  400 条事件，读不全就置 `partial`——首页宁可不显示今日数字，也不编一个偏小的数。

### 自检

- 新增 `scripts/check-home.mjs`（真 Chrome + CDP、DPR2、390/360 宽，**12 条断言**）：
  无 hash 落在首页且标题是「在等你 N 件」、有「继续上次会话」；canDecide 待办卡首屏可见
  （`getBoundingClientRect().top < 844`）且按钮 ≥44px；`#session/<id>` 进会话视图、顶部是
  返回首页（图标走属性判断，SVG 上 `.hidden` 不管用）、点它回首页、点会话行压历史后
  `history.back()` 回首页；N=0 显示「暂时没有需要你的」且入口仍在；390/360 无横向溢出；
  审批仍 POST `/taskwatch/approve`（`decision=allow`、同一 id）、二次确认照旧、处理过不留按钮。
- `scripts/check-mobile.mjs` 改为显式 `showSession()` 再测会话页排版（演示页现在也默认首页）。
- 演示页时间戳按打开时刻整体平移，否则放几分钟再打开，待批准卡会按 `expiresAt` 过期成
  「已退回桌面」，截图与自检都会看到别人的残局。
- `lib/sw.js` 的 `CACHE` 升到 `taskwatch-v22`；`docs/demo.html` 重新生成；新拍
  `home-pending` / `home-pending-dark` / `home-idle` / `home-360` / `session-back`。

### 未验证

- 真机手感（iOS Safari 的边缘返回手势、Android 的返回键）没有在真实设备上跑过，只用
  headless Chrome 的 `history.back()` 与 CDP 验证了路由本身。
- 多件待办（>2）的折叠展开只在演示数据上点过；真实并发里两件同时可决定的情形没有遇到。

## v1.8.1 — 会话引用白名单（远端可看本地产出的 PDF/图片）

### 经用户授权的安全边界放宽（2026-10-29）

- **授权来源**：用户在 **2026-10-29** 明确批准方案 A —— 远端只放行「**本会话里被引用过的
  绝对路径**」。这是对 `/taskwatch/file` 只服务 `~/.dsh/attachments` / `~/.dsh/outbox`
  的一次极窄放宽；`DSH_TASKWATCH_ROOTS` 本身没有改。
- **入口**：`/taskwatch/file` 新增 `sessionId` 参数。带它时走会话引用白名单；**旧调用不带
  `sessionId` 时行为完全不变**，仍只认原来的两个根目录。
- **白名单构建**：复用 `/taskwatch/session` 那份会话读取实现（`readSessionMessages`），
  从消息正文里抓绝对路径（盘符 `[A-Za-z]:[\\/]` 或 `/...`，到空白 / 引号 / 括号 / 反引号
  为止，支持 JSON 转义的 `\\`）。按 `sessionId` 缓存，**消息条数或最后一条消息时间变化就
  整体重建**。不做事件监听：插件本来就在取文件时读得到会话消息，监听只会多一条会漂移的
  状态源。
- **六道校验**：① `resolve` 规范化后必须在白名单里（Windows 大小写不敏感），含 `..` 直接
  拒；② 路径不得含 NUL、不得为相对路径；③ `realpathSync` 后必须是普通文件（拒目录 /
  设备 / 断链）；④ realpath 与请求路径不同（符号链接）时，**真实路径也必须被引用过**；
  ⑤ 单个文件 ≤ **50 MB**（超出 `413`）；⑥ 类型仍走原 MIME / 魔数白名单，`.svg` / `.html`
  / `.js` 不放宽。
- **默认仍拒绝**：未命中白名单一律 `403 outside-roots`；跨会话取同一路径同样 403。
- **审计**：每次放行写一行 `{at, session, path(≤200 字), size, via:'session-ref'}` 到
  `~/.dsh/taskwatch-audit.log`（`DSH_HOME` 优先）；拒绝不写。
- **页面**：文件链接带上 `sessionId`；403 / 413 的提示可区分（「该文件未被本会话引用」/
  「文件超过 50 MB」），文件卡片仍可点原路径，图片失败仍是 36px 提示条、页面不留破图。

### 自检

- `scripts/check-files.mjs` 扩到 **75 项**，新增：命中白名单 200、未命中 403、跨会话 403、
  `..` 穿越 403、符号链接（Windows 无文件链接权限时退到目录 junction）逃逸 403、目录 403、
  超过 50 MB 413（`truncate` 稀疏文件，不真写 50 MB）、缺 `sessionId` 的旧调用行为不变、
  缓存随消息条数变化重建、审计字段与「拒绝不写」。
- 页面契约断言：文件 URL 含 `sessionId`、两种错误文案存在、缓存键带会话。
- `lib/sw.js` 的 `CACHE` 升到 `taskwatch-v21`；`docs/demo.html` 重新生成。

### 未验证

真机、真实 PDF 渲染（页面只给入口卡片）、超大文件在真机上的表现。

## v1.8.0 — 手机端可批准一次（P0）

### 手机端一次性审批（`lib/index.js` / `lib/page.html`）

- **`approval/request` 从只观测升级为可认领**：这是 waterfall 事件，不调 `next()` 就等于
  认领。插件在有手机在线时挂起请求，等手机返回 `allowed-once` / `rejected`；其余情况
  一律交还 `next()`。
- **四条失败语义**：没有手机在线 → 立刻 `next()`；超时 → `next()`；`req.signal` abort
  （桌面已处理）→ 立刻交还；任何内部异常 → `try/catch` 后 `next()`。审批链不允许被
  插件自己打断。
- **只暴露两个结论**：`allowed-once` 与 `rejected`。没有 always-allow。
- **手机决定只成功一次**：重复提交 `409`；过期或已交还 `410`；未知 id `404`；参数错 `400`。
- **在线判据只复用现成通道**：手机页的 `GET /taskwatch/data?view=phone`（桌面 GUI 不带
  `view`，故意不算）与可见时的 `/taskwatch/approvals/stream` SSE。页面隐藏 / 锁屏会关
  SSE 并停止轮询，于是审批立刻退回桌面，而不是空等满 120 秒。
- **页面**：待批准卡片在 `canDecide` 时出现「批准一次」（主）与「拒绝」（危险色描边），
  按钮 ≥44px；批准弹「确认允许一次？」二次确认，拒绝不弹；`expiresAt` 倒计时
  `mm:ss`，到 0 收起并显示「已退回桌面」；成功「已提交」、`409/410`「已由桌面处理」、
  网络失败保留按钮可重试。
- **配置**：`approveFromPhone` 默认 `true`（false 时完全退回只观测）；
  `approvalTimeoutMs` 默认 `120000`，范围 `10000–600000`，越界取边界值并 warn。
- **审计**：每次决定（含超时 / abort / 内部异常）写一行
  `~/.dsh/taskwatch-audit.log`（`DSH_HOME` 优先），JSON Lines，权限只给当前用户；
  只记 `toolName` 与 `reason` 前 120 字，不记命令全文。

### 自检

- 新增 `scripts/check-approval.mjs`：50ms 超时可注入、离线不等待、abort 交还、内部异常
  交还、400/404/409/410、审计 `by:timeout` / `phone` / `desktop` / `error`。
- `scripts/check-mobile.mjs`：真 Chrome + CDP 在 390 / 360 宽断言 `canDecide` 时两个按钮、
  高度 ≥44px、`mm:ss` 倒计时、二次确认文案、无 `canDecide` 时不渲染按钮。
- `lib/sw.js` 的 `CACHE` 升到 `taskwatch-v20`；`docs/demo.html` 重新生成。

### 真机未验

按钮、确认层、倒计时截图都是真 Chrome + CDP（DPR2、390 宽）与注入状态，**没有在真实
手机上点过一次**；SSE 断线但未收到 close 的边界仍可能等到超时（结果安全，只是慢）。

## [Unreleased]

### 文档与工程

- 新增 [SECURITY.md](SECURITY.md)：信任边界（插件自己的 26 条路由不做鉴权）、票据与跨站门禁
  到底挡了什么、交付文件的四条白名单边界、上传与对话驱动的真实副作用、12 条已知限制。
- 新增 `.github/workflows/ci.yml`：ubuntu + windows × node 22/24 跑 `npm run check`，
  和 `publish.yml` 用的同一套检查；`publish.yml` 的语义不变（仍然只在 `v*` tag 上发布）。
- README 顶部补 CI / npm / license 三个 badge 与一句 star 引导。
- 不改运行逻辑、不升版本。

## v1.7.9 — 补 web app manifest（Android 可独立窗口）＋ 文档截图按当前界面重拍

### Web app manifest（`lib/manifest.webmanifest`）

- **修 404**：页面从 v1.7 起就写着 `<link rel="manifest" href="/taskwatch/manifest.webmanifest">`，
  但仓库里没有这个文件、中继也没有这条静态路由，本机与公网都拿不到。现在 manifest 是
  `lib/manifest.webmanifest` 独立文件，宿主按请求读盘、以 `application/manifest+json; charset=utf-8`
  提供（`cache-control: no-cache`），中继也直接读同一份文件，不再各存一份副本。
- **Android 现在能「安装应用」**：`display: standalone` + `orientation: portrait` +
  `start_url` / `scope` 都是 `/taskwatch`，从 Chrome 菜单装到桌面后是独立窗口，不再只是
  带地址栏的快捷方式。`theme_color` / `background_color` 取页面 `theme-color` 的亮色真值
  `#f5f6f7`（暗色真值 `#151517` 仍由页面的 media 查询负责；manifest 只能写一个值）。
- **图标复用仓库里已有的两枚**：`/taskwatch/icon-192.png`（192×192）与
  `/taskwatch/icon-512.png`（512×512），`type: image/png`、`purpose: any`，没有新做图标。
  宿主这两条路由的缓存改成 `public, max-age=31536000, immutable`。
- **中继**：`taskwatch-relay/server.mjs` 的静态白名单补上 manifest 与
  `/taskwatch/icons/` 下的图标路径；中继是常驻进程，**重启后公网才生效**（本轮没有重启 3099）。

### 文档截图

- README 里的手机界面截图**整体换成 1.7.8 当前界面**：真 Chrome + CDP、DPR2、390 宽
  （另加一张 360 宽证明不横向溢出），落进 `docs/screenshots/current/`，共 7 张。
  体现工具卡折叠、状态条、长代码块横滑、子代理二级页、会话抽屉 + 字号三档、空状态。
- 旧图（`docs/screenshot-1.png`、`docs/screenshot-2.png` 以及 `v1.7.6-*` / `v1.7.7-*` /
  `v1.7.8-*` / `phone-*`）**保留在仓库里作历史留存，但 README 不再引用**；
  `docs/screenshots/README.md` 记录了每张图的界面状态、对应版本与是否演示数据。

### 自检

- `scripts/check-bundle.mjs` 新增断言：manifest 存在且 JSON 合法、字段与图标符合契约、
  页面引用的路径就是宿主注册并读盘的那一条、README 里每个 `docs/*.png` 都存在且不再引用
  `screenshot-1` / `screenshot-2`。
- `package.json` → `1.7.9`；`lib/sw.js` 的 `CACHE` 升到 `taskwatch-v19`（manifest 本身不进
  Service Worker 缓存，外壳版本升号是为了让已安装的客户端拿到这一版页面）。

## v1.7.8 — 长会话反复闪屏与附件信封

### 手机页（`lib/page.html`）

- **闪屏（真机复现并修复）**：`.md-imgwrap.loading::after` 的骨架流光用 `inset:0` 绝对定位，
  但 `.md-imgwrap` 没有定位，于是包含块一路退到**视口** —— 只要有一张懒加载图片还没进入
  视口（长会话里几十张都这样），它就永远带着 `.loading`，整屏出现一条 `1.35s` 无限循环的
  亮带，`translateX(55%)` 还会把自己的宽度算进文档宽度（390 的页面被撑到 **601**，可横向滚）。
  修复三处：`.md-imgwrap{position:relative}` 把流光关进图片盒（`border-radius:inherit`）、
  流光 `pointer-events:none` 绝不吃点击、`.loading` 只给**贴着视口**的图片挂（离屏图不再
  挂任何动画）。实测同一条会话：`scrollWidth` 601 → 390，静止 1.4s 内像素变化 2.55% → 0.1%。
- **附件信封不再显示成 XML**：DSH 给模型看的 `<path>…</path><type>image</type><content>…</content>`
  以前在手机上原样出现（某会话的第一条消息整条都是这种标签）。现在解析成真正的图片 / 文件卡，
  同样走 `imgNode` 的失败兜底；文本里不再留标签，也不会再多出重复的路径图片。
- **自检**：`scripts/check-mobile.mjs` 新增 6 条断言 —— 强制 `.loading` 后文档宽度不变、
  流光不吃点击（`pointer-events:none` 且不命中）、`.md-imgwrap` 是定位祖先；信封消息里
  不出现 `<path>`/`<type>`/`<content>` 文本，且渲染出图片位（失败时有提示条）。

### 其它

- `lib/sw.js` 的 `CACHE` 升到 `taskwatch-v18`；`docs/demo.html` 重新生成。

## v1.7.7 — 修复破图占位与图标字形乱码

### 手机页（`lib/page.html`）

- **图片加载失败不再留空框**：正文 / 附件里的 `img` 统一 `max-width:100%`、`height:auto`、
  `min-height:0`，未加载完不占位撑高；失败时（`error`、命中失败缓存、以及页面级捕获兜底）
  换成一条 **36px（≤44px）单行提示条**「图片未能加载 · 打开原图」，能打开原地址的给
  `<a target=_blank>`，`data:` / `blob:` 这类改为点一下就地重试。`error` 监听**先挂再赋
  `src`**，避免同一条坏 URL 第二次出现时收不到事件。
- **图标改内联 SVG**：会话抽屉里的「子代理 N」入口新增内联双人图标（`currentColor`、
  16px、`aria-hidden`），`＋ 开一个新会话` 与 `新建时选择 ›` / `工具轨迹 ›` 这类行尾箭头
  全部换成 12–16px 的 SVG path，彻底不依赖设备字体里有没有那个字形（真机上曾渲染成
  「廿」）。上传预览缩略图失败时换成 `IMG` 徽标，不在 32px 框里显示破图标。
- **自检**：`scripts/check-mobile.mjs` 新增两条硬断言 —— 注入两条必然失败的图片 URL 后，
  DOM 里**不存在破图 `img`**、出现 2 条高度 ≤44px 的提示条且不撑宽页面；「子代理」入口的
  首个子节点必须是 `<svg>`，入口里不许出现 `＋ › ‹ ✓ ✕` 这类字符图标。

### 其它

- `lib/sw.js` 的 `CACHE` 升到 `taskwatch-v17`；`docs/demo.html` 重新生成。
- 破图的真实来源（实测）：图片走 `/taskwatch/file`，中继白名单**有**这条路由（公网侧
  未鉴权是 401，不是 404）；404/403 出在宿主插件那侧 —— 该路由只服务
  `~/.dsh/attachments` 与 `~/.dsh/outbox` 两个根，`D:\Projects\...` 这类路径直接
  `{"error":"outside-roots"}` 403。所以本轮只做页面侧兜底，中继不需要改。

## v1.7.6 — 手机端对话排版：不横向溢出、左对齐、子代理二级页

### 手机页（`lib/page.html`）

- **不再撑宽或偷偷裁掉内容**：`main` / `.row` / 代码块 / 工具卡补 `min-width:0` 与真实
  `max-width`；助手代码块横向可滑（`overflow-x:auto`，细滚动条），长 URL / 路径 / 哈希在
  分隔符后插 `<wbr>`，表格按 GFM 渲染进 `.tablewrap` 自己横滑 —— 页面级 `scrollWidth`
  不再变化。
- **统一左基线**：助手正文、流式回复、工具调用 / 分组全部 100% 宽、`text-align:left`；
  用户消息仍靠右，保留「我 / 助手」的区分。
- **只显示当前会话**：切会话同步清空 `S.items` 与 DOM，`S.epoch` + `data-session` 戳记，
  SSE 用 `SEQ` 与 `sessionId` 双保险丢弃旧帧；用量 / 队列回包也校验 sid。
- **子代理二级页**：工具条「子代理 N」→ `#subagents` 列表 → `#subagents/<id>` 查看，
  返回回主对话；子代理会话从 `/taskwatch/data.sessions` 取（宿主 `/chat/sessions` 会过滤），
  用只读快照 `/taskwatch/session` 渲染，输入框标「只读」并禁用发送。
- **自检**：新增 `window.twSelfCheck()`，断言 390 / 360 下 `scrollWidth <= innerWidth`、
  内容块不越界、助手三处左缘一致、`data-session` 与当前会话一致、切会话无残留。

### 其它

- `lib/sw.js` 的 `CACHE` 升到 `taskwatch-v16`；`docs/demo.html` 重新生成。
- 已知边界：子代理只读快照受宿主上限约束（最多 60 条、每条 4000 字）；已结束且不在
  live 列表里的子代理会话读不到历史，列表里显示为不可点。

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
