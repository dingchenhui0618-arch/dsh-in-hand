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
- **（同日完成）P6 Release note 生成器落地并发布 v1.8.13**：`scripts/release-notes.mjs [--version|--out|--check]` 从 CHANGELOG 取该版本段落，输出「标题 + 正文 + 安装命令 + changelog 链接」；`--check` 能发现「CHANGELOG 段落缺失」与「段落版本与 package.json 不一致」；段落边界只认 `## ` 级别（`###` 子标题与代码围栏内的 `## ` 都不截断）；输出 UTF-8 无 BOM、LF。`check-release-notes.mjs` 25 项，`npm run check` 0。新增 `docs/RELEASING.md`（发版四步）。
- **发现**：仓库自 v1.5.2 起**没有 GitHub Release 记录**（只有 tag）。要不要补，等用户决定。
- **（同日完成）P6 Release 补档脚本落地并发布 v1.8.14**（**只读**）：`scripts/publish-releases.mjs` 默认 dry-run，列出「哪些 tag 还没有 Release / 将用哪段正文」；要 `--apply` + `--yes` + 交互终端三道闸才会真的 `gh release create`；幂等（已存在的跳过）、区间按语义化版本比较、任一 tag 缺 CHANGELOG 段落则 dry-run 退出 2、apply 直接中止零创建。测试 5 组全过，`gh` 全用假二进制，零网络写。
- **实测清单（需要用户决定）**：仓库共 34 个 tag，其中 **26 个可补、8 个已有 Release、0 个缺正文** —— 比我先前估的 12 个多得多。补档是对外发布动作，**等用户点头**，脚本已就绪（一条命令）。
- **（同日完成）P6 可移植性调研落地**（`docs/PORTABILITY.md`，45 行，只读结论）：**页面、`sw.js`/manifest、`ticket.js`、中继、设备账本、审计、高危确认、并行视图、相机、多入口全部宿主无关**；真正绑死 DSH 的只有 `lib/index.js` 的**服务层**（读会话/消息、状态推送、两个决策 waterfall、内容读取）。要支持第二个宿主，适配层只需四件事：列会话与消息、推状态变化、两个决策入口、读取内容。
- **结论：现在不做**——用户都在 DSH 上；第二个宿主的真实差异（很可能没有"审批"概念）未知，过早抽象大概率设计错；各宿主权限模型不同，等于把 P4 重做一遍。保持"DSH 深度集成 + 页面与中继保持宿主无关"。
- **顺手记下的小事（未做，不单独发版）**：给 `lib/index.js` 用注释分出「服务层 / 路由与页面契约」两个区，方便将来写适配层的人看清边界。
- **（同日完成）P6 最后一件小事：`lib/index.js` 注释分区**（commit `6c0eb36`，+34 行注释、0 删除、**非注释改动行 = 0**，`node --check` 与 `npm run check` 均 0，未发新版）。13 个分区：入口/换路票据/设备账本/决策桥/请求门禁/apply 装配/快照与首页事实/HTTP 与文件出口/状态页面契约/对话远程控制/双入口/设备撤销/外壳与静态资源。

## 当前状态：清单已走完，等用户决定

P0–P6 里**没有剩下我能独立推进、且有验收标准的工作**。以下四件都卡在用户侧：

1. **离屏通知通道**（P1 唯一未做项）：只做 Web Push，还是 Web Push + webhook 兜底（Bark/飞书/企业微信）。
2. **补 26 个 GitHub Release**：脚本就绪（`node scripts/publish-releases.mjs --from 1.1.0 --to 1.8.14 --apply --yes`，需交互终端），`missing 0`。需用户点头；可只补 v1.8.0 之后。
3. **重启一次看门狗任务**（`Stop-ScheduledTask`/`Start-ScheduledTask 'DSH Services'`）让中继 v3 票据在生产生效。
4. **重启一次 DSH 客户端**，让 1.8.0–1.8.14 的宿主代码生效；之后真机试一次审批（唯一未被自动化覆盖的环节）。

**后续每轮的行为约定**：只检查用户是否给了新指令或表态；有则执行；没有就**短报当前状态，不编造新活**。若用户给出上述任何一项决定，下一轮立即开工。
- **仍未决**：①离屏通知通道；②补 26 个 GitHub Release；③生产环境重启中继让 v3 生效；④重启 DSH 让宿主新代码生效。
- **仍未决**：①离屏通知通道；②补 26 个 GitHub Release；③生产环境重启中继让 v3 生效。
- **仍未决**：①离屏通知通道；②是否补建 GitHub Release；③生产环境重启中继让 v3 生效。
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
### 2026-10-29（补充）

- 复查了 README 引用的 19 张截图：全部存在，15 张 `current/*` 与各自功能同一天入库，用户提供的两张首屏图未被替换。
- 复查了 npm 包内容（`npm pack dsh-in-hand@1.8.14`）：16 个文件，运行时必需文件齐全，`docs/`/`scripts/`/测试/截图**均未夹带**；`CHANGELOG.md` 不在包内属预期（`files` 白名单）。
- 新增 README 说明：**升级插件后要重启一次 DSH 客户端** —— 页面是读盘的即时生效，但审批/问答/文件白名单在宿主启动时注册，不重启会出现"界面新、按钮没了"的错位。
### 2026-10-30（v1.8.15，P1 离屏通知）

- **完成**：离屏通知 —— 宿主在 `approval/request` / `user-questions/request` 进入等待时推一条：飞书群机器人优先，另收通用 webhook（JSON / form，Server 酱这类）。同一时间多件**合并成一条**（1.2 秒窗口），一次等待只推一次；通道全关时模块完全静默（不排定时器、不发请求、不写日志）。正文只给工具名 + 说明前 30 字，多条列前 3 条 + 「还有 N 件」，不含完整命令 / 对话正文 / 路径。
- **安全**：webhook 地址只能由用户在手机 `#notify` 页粘贴，存 `~/.dsh/taskwatch-notify.json` 并立刻收紧权限（POSIX 0600 / Windows `icacls` best-effort）；插件配置里的 `notify.channels` 被明确忽略并 warn。五条路由全在设备闸门内；列表只回 `masked`，错误文案固定串，日志与审计都不含地址。只收 `https://`，`http://` 仅本机 / 内网。
- **自检**：新增 `scripts/check-notify.mjs` 七组（假 webhook 服务器收真请求、三件合并、全关零请求、掩码、公网 http 拒绝、500 不抛错 + 审计 `notify failed`、文件权限），`npm run check` 退出 0；`check-bundle` 五条新路由显式归类；SW `taskwatch-v30`；`npm run demo` 已同步（一条掩码假通道 + 一条关闭的 form 通道）。四张 DPR2 图在 `D:\Projects\_ui-review\round20\`，`docs/screenshots/current/notify.png` 已入库。
- **未验证**：真实飞书机器人的消息外观、真实 Server 酱转发到微信的效果（无凭据，只用假服务器校验了请求体）；Windows `icacls` 之后的实际 ACL 只断言了命令参数。
- **仍未决**：①补 26 个历史 GitHub Release（脚本已就绪，等用户点头）；②生产环境重启中继让 v3 生效。
### 2026-10-30（用户已表态，恢复推进）

- **用户决定**：①离屏通知**走飞书 webhook**（微信无官方个人 webhook，若要微信走 Server酱 这类通用通道；用户尚未给 SendKey）；②**授权补 26 个 GitHub Release**。
- **补档已执行**：26 个 Release 全部建成（v1.6.0、v1.7.0–v1.7.9、v1.8.0–v1.8.14），现在 `gh release list` = 34 ≡ tag 总数；v1.1.0–v1.5.2 原本就有 Release、且其 CHANGELOG 段落不在仓库里，未动。
- **v1.8.15 离屏通知已发布**：飞书 / 通用 webhook 两通道；触发用 `onPending`/`onRelease` 打点 + 1.2 秒窗口合并（多件只推一条「N 件事等你」）；正文口径「工具名 · 原因前 30 字」，不含完整命令与路径；webhook 地址只由用户在手机设置页粘贴、只落 `~/.dsh/taskwatch-notify.json`、出参一律走掩码，插件配置文件里的 channels 被忽略。`check-notify.mjs` 7 组（假服务器真请求）全过，`npm run check` 0；v1.8.15 的 GitHub Release 同时建好。
- **待用户**：①飞书群机器人 URL 由用户在手机「通知」设置页粘贴并点测试（我不经手密钥）；②若要微信，给 Server酱 SendKey；③是否由我代跑看门狗任务重启（需授权，会短暂中断远端）；④重启 DSH 后真机验证审批。
### 2026-10-30（下午·主线变更）

- **用户变更主线**：微信推送才是他要看的，飞书只留开关不验证；目标已改为「微信推送走通」。
- **v1.8.16 已发布**：新增 **Server酱通道**（`type:'serverchan'`）—— 用户只粘 **SendKey**（`^[A-Za-z0-9_-]{10,64}$`），内部拼 `https://sctapi.ftqq.com/<key>.send`，form 提交 `title`（≤32 字，超长截 31+…）与 `desp`；存储**只存 key 不存 URL**，出参一律 `maskNotifyKey` → `SCT…abcd`；失败审计只写 `notify failed`。飞书通道行为未改。
- **个人微信的现实边界**（写进 README）：微信**没有**官方个人推送 API，这条走 Server酱的公众号消息，**摘要会经过第三方**；完全私有的替代是企业微信应用消息（未实现，按需再做）。
- `check-notify` 原 17 组 + 新增 5 组（serverchan 请求形状、key 校验、掩码、忽略 url、关闭零请求）全过；`npm run check` 0；grep 无真实 SCT key。
- **待用户**：①在 sct.ftqq.com 微信扫码拿 SendKey → 手机「通知」页粘贴 → 点「发一条测试消息」（**这一步才算真正走通**，我无法代做：需要他的微信）；②是否要企业微信那条完全私有的路（要注册企业微信 + 应用 + 可信 IP，我可以代做 API 部分，注册要他扫码）。
### 2026-10-30（下午·通知改走 Web Push）

- **用户决策**：不做 Server酱（不想给第三方付费引流），选 **Web Push** —— 自家中继推系统通知，零成本、零第三方。Server酱/飞书保留为备用开关。
- **v1.8.17 已发布**：新增 `lib/webpush.js`（ECDH P-256 + HKDF-SHA256 + AES-128-GCM，自己实现、**零新运行时依赖**），**与 RFC 8291 附录 A 测试向量逐字节一致**；VAPID ES256（`aud`=endpoint origin、`exp` 12h、`TTL 300`）；订阅存 `~/.dsh/taskwatch-push.json`（0600，绑设备，上限 20/单设备 5），VAPID 私钥存 `~/.dsh/taskwatch-vapid.json`；四条路由 state/subscribe/unsubscribe/test 均在设备闸门内、出参只掩码；`404/410` 删订阅；SW 新增 `push`→`showNotification` 与 `notificationclick`，`CACHE` → v32；设置页有「开启系统通知 / 发一条测试通知 / 关闭此设备」，**iOS 未添加到主屏幕时改走三步引导（16.4+）**，权限被拒给恢复路径且不再弹窗。
- `check-webpush.mjs` 13 组（含 RFC 向量、往返、假 push 服务的请求头与正文解密、410 删订阅、掩码、权限）全过；`npm run check` 0。
- **唯一未验证**：真实手机能否收到（安卓直接开、iOS 需 16.4+ 且添加到主屏幕）—— 必须用户点一次「发一条测试通知」才算走通。
### 2026-10-30（傍晚·远端通路的三个坑）

- **坑 1：中继白名单缺 15 条路由**。宿主的决策/设备/通知/推送接口在中继里从未放行，**远端模式下批准、问答、设备、通知一律 404**（此前只在局域网路径验证过）。已补齐（`/taskwatch/approve`、`/answer`、`/decisions`、`/approvals/stream`、`/devices`、`/devices/revoke`、`/notify*`、`/push/*`），提交 `e5fbabd`。
- **坑 2：中继是提权进程**。普通权限杀不掉也替换不掉，`Stop-ScheduledTask` 只重启任务框架、带不动它 —— 我先前的判断是错的。正确做法：`restart-relay-admin.ps1`（已放在中继目录）用管理员结束进程，看门狗按磁盘上的新代码拉起。
- **坑 3（我造成的一次短故障）**：给运行中的中继加崩溃取证代码时只跑了 `node --check`（只查语法），没验证**能否启动** —— 补丁里 `fs` 未导入，进程一启动就抛错，导致 17:21–17:32 约 10 分钟不可用（3099/3098 都 000、公网 502）。已回退，中继与隧道均恢复（3099=200、3098=200、公网 healthz=200）。
- **教训（写进流程）**：改常驻服务必须先**在旁路端口试启动一次**（`node server.mjs` 跑 3 秒看输出），再让它替换生产进程；`node --check` 通过不等于能启动。
- **前端缓存坑**：改版后手机上仍是旧页面，是 Service Worker 的 cache-first；`?v=<版本>` 加参数可绕过缓存命中，或关标签页重开两轮（`skipWaiting` 要两轮才落到眼前）。