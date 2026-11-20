# 接口与采集面

> 插件注册在 DSH 回环上的全部路由、每一条的请求体与错误码，以及它从宿主软读了哪些服务。
>
> 这一篇是从 [README](../../README.md) 拆出来的：内容与当时实装一致，只搬了容器、修了相对路径，没有改写。

[回到 README](../../README.md) · [文档索引](../../README.md#文档)

## 为什么需要它

DSH 的 Web GUI 没有内置鉴权，而默认 preset 往往是 `danger-full-access`。把整个 GUI
暴露到公网，等于把一台能执行任意命令的机器的入口挂出去。

这个插件的做法是**不暴露 GUI，另开一组窄接口**：

- **读**：把状态渲染成一份手机看得懂的页面，只放行这一条路径就够。
- **写**：`/taskwatch/chat/*` 把 DSH **自己的**会话运行时接到手机上 —— 直接对话、
  逐字收回复、随时停止、切换会话与模型、调整排队顺序。写入口**只有 6 条**，全部列在下面。

采集面完全通过 `ctx.get(...)` 软读取服务，任何一个服务不存在都只会让对应的那一块
留空，不会让插件挂载失败。对话那一组同理：拿不到 `sessionController` 时只让这一个
功能返回明确错误，不影响只读页面。

## 采集面

| 区块 | 内容 |
|---|---|
| 需要你介入 | 等待中的 `approval/request` 与 `user-questions/request` |
| 会话 | 运行/空闲、最后活动时间、该会话在跑的后台任务数、preset、是否仅日志 |
| 会话详情 | 点开后：目标、待介入事项、属于它的后台任务与子代理、最近对话 |
| 目标 | phase、轮次 `started/max`、activation、阻塞原因 |
| 后台任务 | id、label（多行命令已折成单行）、kind、status、生命周期时长、属主会话 |
| 子代理树 | 层级、深度、父会话、activity、mode |
| 工作流 | 当前 phase、日志条数、已运行时长 |
| 采集诊断 | 采集过程中单项失败的原因（不静默吞掉） |

## HTTP 路由

读（`GET`）：

| 路径 | 类型 | 说明 |
|---|---|---|
| `/taskwatch` | HTML | 手机页：以对话为主，顶部状态条点开是任务详情 |
| `/taskwatch/data` | JSON | 全部状态的快照，带 `ETag`，未变化回 `304`。`pending[]` 里两种待办靠 `kind` 区分：审批（`approval`）与选项式提问（`question`，带 `questions[]` / `options[]` / `multiSelect` / `intent`） |
| `/taskwatch/session?id=&limit=` | JSON | 单个会话的最近对话（`limit` 上限 60，默认 20） |
| `/taskwatch/file?id=` · `?path=` · `?sessionId=` · `?info=1` | 二进制 / JSON | 交付文件：附件走 `id`（v1.8.27 起页面会同时带 `&ref=<JSON>`，宿主要用它校验元数据；只送 id 会 404）；绝对路径走白名单根，带 `sessionId` 时改走「本会话引用过的绝对路径」（单个文件 ≤50 MB）；`info=1` 只回元数据 |
| `/taskwatch/chat/sessions` | JSON | 可对话的会话列表（**不含子代理会话**） |
| `/taskwatch/chat/workspaces` | JSON | 新建对话可选的工作区（现有会话的 `cwd` + 固定候选 + 环境变量追加；只列真实存在的目录） |
| `/taskwatch/chat/models` | JSON | 可选模型目录 |
| `/taskwatch/chat/titles?ids=` | JSON | 批量补会话标题（最多 20 个，宿主缓存 10 分钟） |
| `/taskwatch/chat/page?...` | JSON | 往更早翻会话历史 |
| `/taskwatch/chat/stream?sessionId=` | SSE | 跟随一个会话：开场快照 + 增量事件 + 逐字输出 |
| `/taskwatch/chat/queue?sessionId=` | JSON | 该会话未领取的消息：`items`（下一轮队列，可重排）与 `steering`（已插到本回合下一步） |
| `/taskwatch/decisions` | JSON | 当前手机端可决定的审批清单（内存里的活动 decision；`approveFromPhone:false` 时为空） |
| `/taskwatch/devices` | JSON | 设备账本（v1.8.7）：每台设备只有可读摘要名、首次/最近活跃、入口、配对次数、是否已撤销，外加 `current` 标记；不回设备 cookie 原值、IP 或完整 UA |
| `/taskwatch/pair/info` | JSON | 配对面板的静态部分（v1.9.0）：`targets`（每条入口的 `ok` 与不能用的原因）、`relay`（中继活没活、开了没有、报出的局域网地址、认哪几版票、`viaFallback`）、`config`（`lanUrl` 是否已经不再是本机网卡）与设备列表。**不回任何票据或配对码** |
| `/taskwatch/notify` | JSON | 通知通道（v1.8.15）：每个通道只有 `masked` 掩码地址、类型 / 格式 / 开关，外加 `anyEnabled` 与上限。完整地址既不在这个响应里，也不在页面里 |
| `/taskwatch/push/state` | JSON | 系统通知（v1.8.17）：`vapid` 公钥（页面 `subscribe()` 用）、`devices` / `total` / `mine` 台数、上限，以及每条订阅的**掩码**（`https://fcm.googleapis.com/…/AbCdEf`）、`uaShort` 与最近成功时间。完整 endpoint 与 `keys` 不进任何响应 |
| `/taskwatch/approvals/stream` | SSE | 审批事件流：`approval` 事件推送 pending / settled；页面可见时保持，隐藏时关闭 |
| `/taskwatch/entries` | JSON | 双入口清单：`{entries:[{kind:'remote'\|'lan',label,url,current}]}`；没配 `publicUrl` 时只有局域网一条 |
| `/taskwatch/manifest.webmanifest` | JSON | PWA manifest |
| `/taskwatch/sw.js` | JS | service worker |
| `/taskwatch/icon-192.png` · `/taskwatch/icon-512.png` | PNG | 图标 |

写（`POST`）—— 对话入口、一条换路票据、审批 / 回答各一条，外加一条只改内存账本的设备撤销：

| 路径 | 请求体 | 说明 |
|---|---|---|
| `/taskwatch/chat/upload` | 原始二进制（`sessionId/kind/name/mime` 查询参数） | 导入文件或图片；图片由宿主校验，文件按会话签发 receipt |
| `/taskwatch/chat/send` | `{sessionId,text,attachments?,mode?,now?,interrupt?,timeZone?}` | 给会话发文字和已上传附件；`now:true` 走宿主原生 steer 插队（语义见 [排队、重排与「立即发送」](impl.md#排队重排与立即发送的真实语义)） |
| `/taskwatch/chat/cancel` | `{sessionId}` | 停止当前这一轮 |
| `/taskwatch/chat/create` | `{}` 或 `{workspace}` | 新建会话；`workspace` 必须命中 `/taskwatch/chat/workspaces` 列出的路径 |
| `/taskwatch/chat/model` | `{sessionId,provider,model}` | 切换该会话使用的模型 |
| `/taskwatch/chat/queue/reorder` | `{sessionId,ids:[...]}` | 重排下一轮队列；`ids` 必须是当前队列的完整 id 列表 |
| `/taskwatch/ticket` | `{to:'remote'\|'lan'}` | 签发 60 秒的 **v2 HMAC 换路票据**（`v2.<exp>.<nonce>.<hmac>`），宿主与中继用同一密钥互认；只在内存里记已用的 nonce，不碰会话 / 文件 / 配置。没配 `publicUrl` 时远端请求回 `409 no-public-entry` |
| `/taskwatch/approve` | `{id, decision:'allow'\|'reject'}` | **手机端一次性审批**：只把一次已认领的 `approval/request` resolve 成 `allowed-once` / `rejected`。成功 `200`；参数错 `400`；未知 id `404`；重复提交 `409`；过期 / 已交还 `410`。不做 always-allow |
| `/taskwatch/answer` | `{id, answers:[{id, selected:string[], custom?}]}` | **手机端回答选项式提问**：把一次已认领的 `user-questions/request` resolve 成 `{answers}`。必须覆盖请求里所有题目、`selected` 只能取该题 `options[].label`、单选≤1 项、`custom`≤2000 字；不合规 `400` 并带 `field`（如 `answers[1].selected`）。未知 id `404`；重复提交 `409`；过期 / 已交还 `410` |
| `/taskwatch/devices/revoke` | `{deviceId}` | **撤销一台设备**（v1.8.7）：把账本记录标成 revoked 并清空它的配对记录；被撤销设备的下一次请求 `401`（`{ok:false, code:'device-revoked', revoked:true}`）。`deviceId` 是列表里的 12 位摘要，不是 cookie 原值。撤销自己同样 `200`（`self:true`），随后本端也 401 |
| `/taskwatch/pair/link` | `{to:'lan'\|'remote'}` | **签一张 60 秒的配对票并画成二维码**（v1.9.0）：票是 v3、受众按"谁兑现"算（中继 → `remote`），回 `{url, expiresAt, svg, ticketVersion}`。入口不可用时 `409`（`no-entry` / `entry-unreachable`），并带上原因，不签发 |
| `/taskwatch/pair/code` | `{}` | **取一个 6 位配对码**（v1.9.0）：向**本机**中继的 `/taskwatch/pair/new` 转一手（那个端点只认 `127.0.0.1`），回 `{code, expiresAt, ttlSec}`。中继不在本机时 `409 no-relay`，中继拒绝时 `502 relay-error`，绝不编一个码出来 |
| `/taskwatch/notify/add` | `{type:'feishu'\|'webhook', url, format?:'json'\|'form'}` | **保存一个通知通道**（v1.8.15）：写本机 `~/.dsh/taskwatch-notify.json`（权限收到仅当前用户），回显只有掩码。`https://` 以外仅放行本机 / 内网 `http://`，公网 `http://` `400` 且错误文案不回显地址 |
| `/taskwatch/notify/toggle` | `{id, enabled}` | 开关一个通道；没有启用通道时发送模块完全静默 |
| `/taskwatch/notify/remove` | `{id}` | 删除一个通道（地址丢了只能回飞书重新拿，所以页面用两步确认） |
| `/taskwatch/notify/test` | `{id}` | **真发一条测试消息**，回 `{ok,status,attempts,error,tookMs}`（失败也是 `200` 的结果汇报）。目标地址只从本机文件按 `id` 取，请求方不能指定 URL，所以这条路由不是通用代理 |
| `/taskwatch/push/subscribe` | `{endpoint, keys:{p256dh,auth}, origin}` | **保存这台设备的一条系统通知订阅**（v1.8.17）：写本机 `~/.dsh/taskwatch-push.json`（权限收到仅当前用户），响应只回掩码与台数。endpoint 只收 `https://`（本机 / 内网 `http://` 仅用于自测），`keys.p256dh` 必须 65 字节、`auth` 16 字节，否则 `400`。`deviceId` 由 `twd` cookie 派生，请求体指定不了 |
| `/taskwatch/push/unsubscribe` | `{id?}` | 关掉系统通知：带 `id` 只删那一条，不带就删**这台设备**的全部订阅（别的设备不受影响） |
| `/taskwatch/push/test` | `{}` | **真发一条测试通知**：走真实加密 + 真实 VAPID 签名，只发给这台设备的订阅，回 `{ok,sent,failed,results:[{id,masked,ok,status,error}],tookMs}`。目标只能来自本机文件，请求方不能指定 URL |

全部注册在 `ctx.webServer` 上，不代理 DSH 自身的 `/api`，也不转发任意路径。
写入口就只有上面这些对话入口 + 1 条换路票据 + 1 条一次性审批 + 1 条回答 + 1 条设备撤销
+ 4 条通知设置 + 3 条系统通知（只有 `notify/test` 与 `push/test` 会主动发起外部请求，
两条的目标都不可由请求方指定） —— 契约测试会**正面清点**路由表，
新增路由必须在只读 / 对话 / 非对话写三张白名单里显式归类，漏一个就让构建失败
（早先那条断言写的是"源码里不出现 `method === 'POST'`"。加了 5 个写路由之后它
照样通过，是条假绿灯：它证明的是"没这么写"，不是"没有这个能力"）。
