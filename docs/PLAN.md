# 发展计划与每日进度

这份文件是**唯一**的计划与进度真源：排在前面的是路线图，最下面是按天追加的日志。
每天收工前把当天改动、卡点、明天第一件事写进日志，第二天从这里接着看。

## 三条原则

1. **只做能改变性质的事**：手机端从「能看」变成「能做决定」，价值远大于任何 UI 精修。
2. **不扩大信任面**：文件读取、审批权限、公网暴露，任何放宽都先问，默认保持现状。
3. **每天可交付**：一天一小步，当天提交并推 `origin/main`；做不完也写清楚停在哪儿。

## 节奏

- 开工：读本文件最下面的「日志」，确认昨天停在哪、今天第一件事是什么。
- 收工：`git push` 之后追加一条日志（日期 / 完成 / 卡点 / 明天第一件事 / 需要用户决定的事）。
- 需要用户判断的事，**先写进「待决」再问**，不要自己拍板。

## 路线图（P0–P6）

判断标准：这个插件的价值上限 = **手机端「做决定」的能力 × 提醒可靠性**，不是隧道技术，也不是界面精致度。

| 级别 | 事项 | 为什么 | 量级 |
|---|---|---|---|
| P0 | 手机端能审批/回答（把「等待事项」变成可操作的决定） | 核心闭环缺这最后一环，其余都是外围 | L |
| P1 | 首页改成「待办优先」，对话流降为第二层 | 离屏的人要的是判断，不是阅读 | M |
| P1 | 离屏通知（有事项等你时推到你手机上） | 不推送＝用户永远不知道该打开它 | M |
| P2 | 中继做成用户级自愈服务，不再需要管理员重启 | 每次改代码都要 UAC = 用户被迫介入 | M |
| P2 | 断线与重连体验（切网、锁屏回来能续上） | 移动端常态是抖动 | M |
| P3 | 部署降到一条命令（中继打包 + 扫码配对） | 现在要求会 nginx + ssh -R，会流失一半人 | M |
| P3 | 多机/多入口管理 | 用户迟早不止一台电脑 | L |
| P4 | 安全硬化：票据跨进程严格一次性、设备列表与撤销、访问审计 | 「写入口等于终端」，安全就是产品的一部分 | M |
| P4 | 危险动作二次确认（删除/推送/发布类命令在手机上确认） | 手机误触的代价是生产事故 | M |
| P5 | 输入效率：语音转文字、常用短语、相机直发 | 手机打字慢是硬约束 | S |
| P5 | 并行视图：多会话/子代理同屏追踪 | 真实任务是并行的 | M |
| P6 | 分发与留存：英文 README、Release note 自动化 | 开源要的是可发现性，不是 star | S |
| P6 | 可移植到别的 agent 宿主（仅调研） | 天花板被 DSH 用户量卡住 | L |

**明确不做**：原生 App、自造隧道、多人协作/多租户、云端托管中继、复刻 GUI 功能。

## 待决（需要用户拍板后才动手）

### 1. 远端看不到电脑上本地产出的 PDF / 图片（用户 2026-10-29 提）

现象：手机上能看到消息里提到 `out/xxx.pdf`，但打不开、也不显示图。

**根因（已定位）**：宿主侧文件路由只服务两个根：`~/.dsh/attachments` 与 `~/.dsh/outbox`；
其他路径一律 `403 outside-roots`（`D:\Projects\...` 实测就是这样被拒的）。所以问题不在「云存储」，
而在**宿主愿不愿意把工作目录里的文件交给这个页面**。

三条路：

| 方案 | 做法 | 代价 / 风险 | 我的看法 |
|---|---|---|---|
| A. 会话引用白名单（推荐） | 宿主记录每个会话在工具输出里**引用过的**绝对路径，只放行这些路径 | 要维护一份路径索引；路径穿越仍需防 | 信任面最小，且正好覆盖「交付物」这个场景 |
| B. 交付物自动入 outbox | 让 agent/钩子把最终交付物复制到 `~/.dsh/outbox` | 依赖 agent 自觉；文件会多一份 | 可作为 A 的补充，不能单独依赖 |
| C. 云存储/对象存储 | 上传到云端再生链接 | 用户文件离开本机 → 最大信任点；成本与合规 | **不做**。「云端」这件事只允许**中转不落盘**，不能变成归档 |

配套（与 A 一起做，不单独做）：宿主侧按需生成缩略图/首屏预览（PDF 首页、图片压缩），
省手机流量、也避免把整份文件先拉下来。

**决定（2026-10-29，用户拍板）：走 A。** 用户明确接受「放宽到被会话引用过的路径」，并确认 `DSH_TASKWATCH_ROOTS` 的其他限制保持原样。

A 的实现边界（做的时候按此执行，只放宽到这一层）：

1. **来源限定**：只认「本会话里工具输出中出现过的绝对路径」（从工具结果文本里抓取，记录 session → path 集合），不接受客户端传任意路径。
2. **必须是文件、必须存在**：`realpath` 后再校验，拒绝符号链接逃逸、拒绝目录、拒绝 `..`。
3. **只读不列目录**：只能取单个文件，不提供目录列举、不提供通配。
4. **会话隔离**：只能取本会话记录过的路径；跨会话一律 403。
5. **上限**：单文件 ≤ 50 MB，超出回 413 并给原路径提示；不缓存、不落副本。
6. **TTL**：记录随会话存活，会话结束即失效。
7. **审计**：每次放行记一行（session、路径、大小、时间），只记路径摘要不记内容。
8. **默认仍拒绝**：未命中白名单的路径回 `403 outside-roots`，行为与现在一致。

> 这条属于**经用户明确授权的安全边界放宽**，与「不擅自扩大信任面」并不冲突；实现时要单独 commit，消息里写明授权来源与日期。

### 2026-10-29（收工）

- **完成**：**P0 落地并发布 v1.8.0** —— 手机端可「批准一次 / 拒绝」，四个失败语义全部交还桌面（离线立刻 next、120 秒超时 next、桌面已处理立即交还、内部异常 next），审计写 `~/.dsh/taskwatch-audit.log`（只记 toolName + reason 摘要）。
- **证据**：`2b8fe59` / tag `v1.8.0` / npm 1.8.0；`npm run check` 退出 0（新增 `check-approval.mjs`：50ms 超时、离线、abort、400/404/409/410、审计；手机端排版 40/40）。
- **未验证**：真机点击；SSE 断线但未收到 close 时可能等满 120 秒（安全回落，不会卡死 agent）。
- **（同日完成）文件可见性 A 已落地并发布 v1.8.1**：会话引用白名单（`lib/files.js`），只放行本会话消息里出现过、真实存在、是普通文件、≤50 MB 的单个路径；跨会话与符号链接逃逸一律 403；未命中照旧 `403 outside-roots`；每次放行写审计（`via:'session-ref'`）。`check-files.mjs` 75/75，`npm run check` 0。
- **（同日完成）P1 首页改造已落地并发布 v1.8.2**：默认视图从对话改成概览 —— 「在等你 N 件」+ 首屏可直接批准的第一张待办卡（实测 top=113px，390×844 不滚就能点）、在跑区最多 3 条、一行计数、底部「继续上次会话 / 全部会话」；会话退为第二层（`#session/<id>`，pushState + 返回手势 + 顶部返回）。审批复用 v1.8.0 同一套处理函数（断言 fetch 仍打 `/taskwatch/approve`）。`check-home.mjs` 12 条，`npm run check` 0。
- **踩坑记录**：SVG 上 `el.hidden = true` 只是 expando，必须 `setAttribute`，否则图标不换。
- **（同日完成）P0 补齐并发布 v1.8.3**：手机端可回答**选项式提问与计划审批**（`POST /taskwatch/answer`）——复用审批的 broker/超时/审计/在线判定，服务端校验「答案覆盖全部题目、selected 只能取 options.label、单选≤1、custom≤2000」，违规 400 带 field；失败语义与审批一致（离线/超时/abort/异常全部 `next()`）。`check-answer.mjs` 23 项，`npm run check` 0。README 过时说法「手机页只能对话，不能审批」已改。
- **P0 到此完整**：批准/拒绝 + 选项式回答 + 计划审批，三类决定都能在手机上做完，且失败一律交还桌面。
- **（同日完成）P2 断线重连落地并发布 v1.8.4**：SSE 指数退避（1→2→5→10→30 秒 + ±20% 抖动）、隐藏时暂停/可见时立即重连、`online` 立刻拉快照、陈旧检测显示「连接已断开 · 正在重试」并保留旧内容、重连与 tick 共用 in-flight 保护（无请求风暴）；连接三态（稳定/重连中/离线）。`check-reconnect.mjs` 16 项，`npm run check` 0。另修 CI `42563c7`。
- **（同日完成）P3 前半落地并发布 v1.8.5**：`docs/deploy/` 四件套 —— 三步指南、systemd 单元（`Restart=always`、`NoNewPrivileges`、`ProtectSystem=strict`、独立用户）、nginx 模板（含 **SSE 关缓冲** 三行，这是自建反代最容易踩的坑）、幂等安装脚本（令牌 `openssl rand -base64 32` + 600）、只读自检脚本（绝不回显令牌）。验证：`bash -n` 两个脚本 OK、`systemd-analyze verify` OK、最小独立 nginx `-t` OK；**生产配置零改动**。
- **（同日完成）P4 之一落地并发布 v1.8.6**：票据升到 v3 = `v3.<expMs>.<nonce>.<aud>.<hmac>`，**受众绑定**（`lan` 只给插件、`remote` 只给中继）+ **严格一次性**（解析→受众→验签→时效→claim 在同一次同步调用里完成，中间无 await）。修复的真缺口：局域网票据此前可在 60 秒内被拿到公网中继兑换。
- **兼容是这个改动的核心**：插件探测入口是否声明支持 v3，未声明/探测失败/超时 → 继续签 v2；v2 过渡截止 2027-01-01。旧中继 + 新插件、新中继 + 旧插件都不锁门。
- **交付过程教训**：中继目录原本不是 git 仓库，子代理自行 `git init`（无 remote、只放行 `server.mjs`）做本地提交 —— 未来这类目录都按此处理。推送前扫密钥/真实 IP/`--stat` 已写进任务书，本次三项全过。
- **（同日完成）P4 的另一半落地并发布 v1.8.7**：设备列表与撤销。首次访问签发 HttpOnly 的 `twd` cookie（随机 UUID、SameSite=Lax、30 天），老会话下次访问自动补绑；内存账本 `{firstSeen,lastSeen,ua,via,sessions,revoked}` 上限 50、30 天清理，`ua` 只存 ≤80 字摘要、不存 IP / 完整 UA；撤销后该设备下一次请求 401，页面显示「此设备已被撤销，请重新配对」，撤销自己走二次确认。审计只写 `{at,kind:'device-revoke',deviceId:<摘要>,via,self}`。`check-devices.mjs` 35 项，`npm run check` 0；四张真实渲染截图在 `_ui-review/round15/`。
- **P4 到此完整**：票据受众绑定 + 严格一次性（v1.8.6）、设备列表与撤销 + 撤销审计（v1.8.7）。仍然不做账号体系 —— 撤销是「把这一台踢掉」的止损，不是登录。

### 2. P0 可行性 —— **已确认可行（2026-10-29，只读调研，未改代码）**

用运行时 inspect（host Event provider）查到两个决策口的真实契约，都是 **waterfall 且可认领**：

```
approval/request        waterfall
  (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>
  "Return an outcome to claim the request or call next() to delegate."
  ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  ApprovalRequestEvent = { agent, toolName, callId?, reason?, displayReason?, signal? }

user-questions/request  waterfall
  (request: AskUserQuestionRequestEvent, next) => Promise<AskUserQuestionAnswer>
  AskUserQuestionAnswer = { answers: [{ id, selected: string[], custom?: string }] }
  其中 item.intent.kind = 'plan-review' —— 计划审批也走这条路
```

**结论**：插件自己就能「认领」请求 —— 不调 `next()`、先挂起，等手机答复后返回
`allowed-once` / `rejected`，或返回 `{answers:[…]}`。**不需要宿主暴露新接口**，也不用改 GUI。

**实现要点（做的时候必须遵守）**：

1. **失败必须交还**：超时（建议 120 秒）、页面断线、用户关闭 → 一律回落到 `next()`，
   绝不把 agent 悬在半空。宁可手机上没批到，也不能让任务卡死。
2. **只给 `allowed-once`**，不做「always allow」——那等于在手机上永久放宽权限。
3. 监听 `req.signal` 的 abort（桌面端先取消了，手机上要立刻收起按钮）。
4. 手机端只展示 `toolName` + `reason`（`displayReason` 优先，便于本地化），**不展示完整命令**，
   避免把长命令塞进手机窄屏；需要细节的跳二级页。
5. 所有决定写审计：时间、会话、工具、结果、来源（手机/桌面）。

**超时口径（2026-10-29 用户确认）**：120 秒无响应即回落到桌面，作为 `approvalTimeoutMs` 默认值。

**下一步**：先做最小闭环（只支持 `allowed-once` / `rejected` 两个按钮 + 超时回落），
再补 `user-questions` 选项式回答。

## 日志

### 2026-10-29

- **完成**：确立每日推进模式，建立本文件（路线图 + 待决 + 日志）。
- **背景**：v1.7.9 已发布（manifest 落文件、文档截图按 1.7.8 界面重拍、截图索引表）；README 首屏恢复为用户自备两张真机图（`phone-home.png` + `gui-taskwatch-entry.png`）。
- **卡点**：无。
- **明天第一件事**：按「待决 2」的结论做 P0 最小闭环（llowed-once / ejected + 超时回落），先只做审批、不动问答。
- **补充（同日完成）**：P0 只读调研已做完 —— 两个决策口都是可认领的 waterfall，插件侧即可决定，**无需改宿主**；结论与实现要点见「待决 2」。
- **需要用户决定**：~~文件可见性方案 A / 维持现状~~ → **已定：走 A**；超时口径 **已定：120 秒**。
- **排队**：P0（手机端审批，进行中）落地后再做 A（两者都改 `lib/index.js`，避免同文件冲突）。

### 2026-10-29（v1.8.4，P2）

- **完成**：断线自动重连与陈旧提示 —— 页面自管快照与两条 SSE 的生命周期；
  1s → 30s 退避、隐藏暂停、`online` / `visible` 立即续上；断线保留旧内容并显示页脚提示。
- **自检**：`scripts/check-reconnect.mjs` 16 项全过；`npm run check` 退出 0；
  三张 DPR2 验收图在 `D:\Projects\_ui-review\round14\`。
- **未验证**：真机 Wi‑Fi ↔ 4G、iOS 锁屏后的后台定时器节流，只做了真 Chrome + CDP 模拟。

- **（同日完成）P4 另一半落地并发布 v1.8.7**：设备账本（随机 UUID + HttpOnly cookie、50 台上限、30 天清理）+ `#devices` 页 + 一键撤销（撤销即销毁该设备全部会话，下一次请求 401）；「撤销这台设备」需二次确认；**不存 IP、不存完整 UA**，审计只写设备摘要。`check-devices.mjs` 35 项，`npm run check` 0。
- **P4 进度**：票据受众绑定 + 严格一次性 ✓、设备列表与撤销 ✓；剩「危险动作二次确认」（P4 第二条）未做。
- **（同日完成）P4 收尾落地并发布 v1.8.8**：`assessRisk()` 在**宿主侧**判定危险动作（默认 19 条模式，匹配 `toolName+reason+displayReason`，可配置 `highRiskPatterns`），pending 下发 `risk:'high'`；页面只渲染宿主给的字段，高危卡片点「批准一次」后**卡内展开确认层**，只有点「确认执行」才真正 `POST /taskwatch/approve`（CDP 网络日志断言过）。拒绝路径不加确认。`check-risk.mjs` 86 项，`npm run check` 0。
- **P4 全部完成**：票据受众绑定 + 严格一次性 ✓ / 设备列表与撤销 ✓ / 高危两步确认 ✓。
- **（同日完成）P5 相机直发落地并发布 v1.8.9**：原生 `input[accept="image/*"][capture="environment"]` 唤起系统相机（不用 `getUserMedia`）；客户端压缩长边 1600 / JPEG 0.82（>2.5MB 降 0.7 重试一次）、`createImageBitmap` 的 `imageOrientation:'from-image'` 保方向；**复用唯一上传端点** `/taskwatch/chat/upload`（页面只有一处 fetch），`lib/index.js` 与 `lib/client.js` 未动。取消不发请求、失败保留缩略图可重试。`check-camera.mjs` 36 项，`npm run check` 0。
- **（同日完成）P5 并行视图落地并发布 v1.8.10**：`#parallel` 整屏，排序固定为 **需要你 > 失败 > 运行中 > 空闲**（同组按最后活动倒序），失败行永远置顶并带 ≤60 字原因；子代理折叠复用 `data.subagents`；状态更新用 `insertBefore` 搬行、**不整屏重建**（MutationObserver 断言其他行未被重建）。`check-parallel.mjs` 14 项，`npm run check` 0。
- **P5 收尾说明**：语音转文字**不做** —— 移动端可用方案的普通话识别质量与延迟都不稳定，做了大概率是负资产；已在 PLAN 记为「明确不做」。
- **（同日完成）P6 英文 README 落地并发布 v1.8.11**：新增 `README.en.md`（定位 / 安装 / 安全 / 诚实限制四段），两份 README 顶部互相切换；`check-bundle` 现在同时校验两份 README 的图片、互链与「英文无中文残留」。同时**修正中文 README 一处事实错误**：原文称「刻意不声明 `engines.dsh`」，但 `package.json` 实际声明了 `>=0.2.1-rc.2 <0.3.0`，且正文写的是实测 0.2.0-rc.2 —— 已改成与代码一致的表述。
- **已知小瑕疵（未修）**：中文 README 第 101 行夹了一句英文，属美观问题，下次顺手清。
- **（同日完成）P2「中继用户级自愈」只读调研结论：机制已具备，只缺操作说明。**
  - 现状：中继已由看门狗 `DSH Services` 托管（`services-watchdog.ps1` 的 `Get-LaunchSpec` 里有 `taskwatch-relay`：端口 3099、健康检查 `/healthz`、脚本 `server.mjs`、`RELAY_UPSTREAM=3080`）。
  - 关键发现：**3099 是高位端口，绑定不需要管理员**（当前 shell 未提权）；而**重启看门狗任务本身也不需要管理员**（`Stop-ScheduledTask` / `Start-ScheduledTask 'DSH Services'` 之前实测可用）。真正需要管理员的只有「直接杀正在跑的那个 PID」。
  - 所以「改中继要提权」这个结论**不成立**：改完 `server.mjs`，重启一次看门狗任务即可让新代码生效。
  - 未做的验证：**没有实际重启生产中继**（按约定不动生产进程）；等用户某次方便时执行一次，确认 v3 票据在生产中生效。
  - 附注：中继目录里堆了大量一次性探查脚本与截图（`probe-*.mjs`、`wb-*.json`、`patch-*.mjs` 等）。已 `git init` 且 `.gitignore` 只放行 `server.mjs`，所以不会外泄；但建议以后清理。
- **（同日完成）P3 多入口切换器落地并发布 v1.8.12**：`#entries` 保存一份**地址清单**（`{label,url}`，最多 8 条、同 origin 去重、URL 规范化、仅 http/https）；切换＝跳到另一个源的 `/taskwatch`，认证仍靠**各源各自的 cookie**，**手机端不存任何令牌**（测试断言整份存储无 token/cookie 痕迹）。「本机」仅在首次且清单不存在时生成。`check-entries.mjs` 16 项，`npm run check` 0。
- **顺带发现**：`check-entries.mjs` 原本已存在（宿主 routes 契约测试），本次是**追加**而非新建同名文件——避免了两个同名测试并存。
- **明天第一件事**：**P6 Release note 自动化**（从 CHANGELOG 生成 GitHub Release 正文，减少每次手写；只在本地脚本 + 文档，不动 CI 流程）。
- **仍未决**：离屏通知通道（只做 Web Push / Web Push + webhook）；生产环境重启中继让 v3 生效（等用户方便）。
- **仍未决**：离屏通知通道（只做 Web Push / Web Push + webhook）。
- **仍未决**：离屏通知通道（只做 Web Push / Web Push + webhook）。
- **仍未决**：离屏通知通道（只做 Web Push / Web Push + webhook）。
- **仍未决**：离屏通知通道（只做 Web Push / Web Push + webhook）。
- **仍未决**：离屏通知的通道选择（只做 Web Push / Web Push + webhook），等用户一句话。

### 2026-10-29（v1.8.8，P4 收尾）

- **完成**：危险动作二次确认 —— 判定在宿主（`assessRisk` 扫 `toolName + reason + displayReason`，默认 19 条命令 / 路径模式，`highRiskPatterns` 最多 64 条、每条 ≤120 字符，越界裁剪并 warn）；`pending[].risk` 下发，页面只画红色「高危」徽标 + 卡片内确认层（只有「确认执行」才 POST），取消 / Esc / 遮罩都只收层；`riskConfirm:false` 只留徽标；审计追加 `risk`；SW `taskwatch-v26`。
- **自检**：`scripts/check-risk.mjs` 86 项全过（含真 Chrome + CDP 的网络日志断言）；`npm run check` 退出 0；`npm run demo` 已同步（演示里一条 high 待办）；四张 DPR2 验收图在 `D:\Projects\_ui-review\round16\`，仓库里 `docs/screenshots/current/risk-*.png` 引用其中两张。
- **未验证**：真机两步之间的误触概率、`format` 这类短词误报的实际烦感度，只在 Chrome 模拟里点过。
- **P4 进度**：票据受众绑定 + 严格一次性 ✓、设备列表与撤销 ✓、危险动作二次确认 ✓ —— P4 全部落地。