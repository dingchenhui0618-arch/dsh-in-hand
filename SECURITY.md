# 安全模型 / Security model

这份文档说明 **dsh-in-hand**（本地目录 `dsh-taskwatch`）信任什么、接受什么输入、会把什么送到哪里去。
它从实现里读出来：`lib/index.js`（26 条路由与对话驱动）、`lib/files.js`（交付文件白名单）、
`lib/ticket.js`（跨进程换路票据）、`lib/page.html`（手机页渲染）、`lib/sw.js`（离线壳）。
**如果文档和代码不一致，以代码为准——那说明这份文档是个 bug。**

> 一句话：这是「把 DSH 的会话控制搬到手机」的插件，**插件自己的路由一条都不做鉴权**，
> 安全边界不在这个仓库里，而在它前面那层中继（`dsh-in-hand-relay`，另一个项目）上。
> 所以：**不要把 DSH 的端口直接暴露到公网**；手机能连到那个端口，就能读会话、发消息、让 agent 干活。

## 信任边界

插件跑在 DSH 的**宿主进程**里（`lib/index.js` 的 `export const inject = ['webServer']`），
把路由注册到 DSH 自己的 web server 上——所以手机页与 DSH Web GUI **同源**。

| 表面 | 谁连得进来 | 谁在做鉴权 |
| --- | --- | --- |
| `http(s)://<DSH 地址>/taskwatch*`（26 条 `kind: 'exact'` 路由） | 任何能连到 DSH 那个端口的人 | **插件不做**。DSH Web GUI 本身也没有认证；门在部署侧（中继的 TLS + 应用层令牌 + 白名单转发） |
| 局域网直连入口（`GET /taskwatch/entries` 里那条 `http://<内网 IP>:<port>/taskwatch`） | 同网段任何人 | **没有任何门**，就是宿主端口本身 |
| 中继的公网入口（`publicUrl` / `lanUrl`） | 公网 | 中继那一层；它的代码不在本仓库，能力不在这里承诺 |

**视为不可信输入的：**

- 手机上发来的一切：查询参数、JSON 请求体（`readJson` 上限 **32 KiB**）、原始上传字节（上限 **32 MiB**）；
- **模型产出与宿主数据**：消息正文、工具名、工具提示、会话标题、文件名字、任务名——它们只作为文本渲染（见下面「输入处理」）；
- **被读出来的文件内容**：`~/.dsh/attachments`、`~/.dsh/outbox` 下的任意字节（可被 `DSH_TASKWATCH_ROOTS` 换成别的目录）；
- **票据字符串**：`?t=`、`POST /taskwatch/ticket` 的请求体；
- 宿主服务的返回值：`attachments`、`fileUploads`、`sessionController` 的回包，一律当数据用，不当命令用。

## 鉴权现状（照实写）

**插件层：没有令牌、没有 basic auth、没有 `remoteAddress` 检查。** `lib/index.js` 里搜不到
任何 `isLoopback` / `Authorization` / cookie 校验；`/taskwatch/chat/*` 这些**写**入口和
`/taskwatch/data` 这类只读入口在鉴权上一视同仁。这是有意的分工（见 `lib/index.js` 第 855 行
起的注释：TLS + 令牌由中继承担），代价是：**谁能连上宿主端口，谁就能驱动 agent。**

「看起来像门禁、其实不是」的四处，写清免得误判：

1. **换路票据**（`lib/ticket.js`）：`v2.<exp>.<nonce>.<hmac>`，HMAC-SHA256，密钥在
   `<家目录>/.dsh/taskwatch-ticket.key`（`TASKWATCH_TICKET_SECRET` 可覆盖；没有就生成 32 字节随机值，
   POSIX 下 `chmod 600`，Windows 下 `icacls /inheritance:r /grant:r <user>:F`）。TTL **60 秒**，
   最大跨度 180 秒。它证明「这张票是本机签的、没被改过、还没过期」，**不是**「这张票只能用一次」：
   跨进程无法共享已用状态，只在各进程内做 nonce 去重（上限 1024 条）。窗口期内理论可重放一次——
   代码注释里自己写明白了。
2. **跨站门禁**（`isCrossSite`）：只加在 `POST /taskwatch/ticket` 一条上，看 `Sec-Fetch-Site` 与
   `Origin` 是否与 `Host` 同源。**`curl` 或任何非浏览器客户端不带 `Origin` 就直接放行**——
   它挡的是浏览器里的第三方页面，不是人。
3. **`POST + application/json` 要求**：`requirePost` 用于 `/chat/upload`、`/chat/send`、
   `/chat/queue/reorder`。它防的是「跨站表单顺手 POST」，不是身份。
4. **入口清单里的 `current` 字段**：按 `Host` 头与配置的公网域名比对算出来的**展示用**标记，
   不参与任何放行判断。

## 输入处理

- **交付文件读取**（`lib/files.js`，36 项边界测试）：只服务白名单根之下的文件，默认
  `~/.dsh/attachments` 与 `~/.dsh/outbox`；先判边界（不碰磁盘）→ 判类型 → **`realpathSync` 复查一次**
  （字符串检查挡不住根目录里的符号链接）→ 最后看大小（**32 MiB**）。类型是扩展名白名单，
  `.svg`/`.html`/`.js`/`.css`/`.xml` 一律拒绝；没有扩展名（宿主附件库是内容寻址，名字就是哈希）时
  按文件头魔数判 PNG/JPEG/GIF/PDF/ZIP/WebP/MP4。**这是「按内容识别」，不是「按内容放行」。**
- **上传**：`kind=image` 只收 `image/png|jpeg|webp|gif`，先由宿主 `attachments.saveImage` 做图像准入，
  再由一次性 token 交接（`randomUUID`，30 分钟 TTL，全局 128 个、每会话 16 个、并发 8 个）；
  文件走宿主 `fileUploads.uploadStream`，字节数按实际流长度核对（不信任 `Content-Length`）。
- **对话驱动**：`/chat/send`、`/chat/create`、`/chat/cancel`、`/chat/model`、`/chat/queue/reorder`
  只做参数整形与转调 `sessionController`；插件自己**不碰 LLM、不解析流式协议**。
- **工作区选择**（`/chat/create`）：客户端发来的目录字符串必须**逐字命中**
  `GET /taskwatch/chat/workspaces` 的候选清单才写进 `cwd`，否则报错。候选来自现有会话 `cwd`、
  `DSH_TASKWATCH_WORKSPACES`（`;` 分隔，**默认写死 `D:\Projects`**）、固定候选，不存在的目录用
  `statSync` 过滤。手机选不了任意目录。
- **渲染**（`lib/page.html`）：模型正文、工具名、工具提示、会话标题走 `textContent` 或 `esc()`；
  `innerHTML` 的十余处要么是文件内常量（图标 SVG），要么先过 `esc()`/`pkEsc()`。
  契约测试盯住已知的四个入口——它证明的是「这四个入口没漏」，**不等于「整页无 XSS」**。

## 数据与副作用

- **写**：插件只写一个文件——票据密钥 `<家目录>/.dsh/taskwatch-ticket.key`（见上）。
  它不写会话、不写配置、不做存档；状态全在内存（`pendingUploads`、票据 Map、ETag 缓存）。
- **读**：自己的 `lib/` 资源（`page.html`、`sw.js`、manifest、图标）；白名单根下的交付文件；
  通过宿主服务读会话、附件、任务、子代理、目标。不列目录。
- **网络**：`lib/` 里**没有任何对外请求**（无 `fetch`、无 `node:http` 客户端）。所有网络行为都是
  「响应手机/中继发来的请求」。
- **遥测**：无。不上传对局、不上报使用情况、不带账号信息。
- **真正的重副作用是「替你在宿主上点按钮」**：`/chat/send` 等于用宿主权限驱动 agent，
  而 DSH 默认 preset 往往是 `danger-full-access`——这条是设计，也是本插件最该被认真对待的能力。

## 已知限制（都是真实取舍，不是 bug——但你应该知道）

1. **没有鉴权、没有限速、没有连接数上限**。手机页与 DSH Web GUI 同源，后端能执行任意命令；
   安全完全取决于前面有没有一层会验令牌的东西。
2. **局域网直连那条路没有令牌门**。`entries` 会同时列出直连入口，它就是宿主端口；
   建议把 `lanUrl` 指到有鉴权的中继，别指回插件宿主。
3. **页面还没有 CSP**。任何一次漏转义都等于一台能执行任意命令的机器的入口；加一层
   `Content-Security-Policy`（脚本用 sha256 hash）是最值得做的下一步加固。
4. **明文 HTTP**：局域网直连时同网段可抓包看到会话内容与附件。
5. **票据不是严格一次性**：只在进程内按 nonce 去重，窗口期内理论可重放一次（见上）。
6. **只读路由不校验 HTTP 方法**：`/taskwatch/file`、`/taskwatch/data` 等直接响应 GET 语义，
   没有 `POST → 405` 的强制（写路由才有）。不改行为，只是别把它当成"方法白名单"。
7. **`/taskwatch/session` 只覆盖内存里的活跃会话**；冷会话读不到，插件显式报错而不是假装没消息。
8. **单条消息文本超过 4000 字符会被截断**；会话、任务、子代理列表各最多 40 条。
9. **手机页只能对话，不能审批**：批准/回答仍只能在桌面上做。
10. **工作区默认值是硬编码的 `D:\Projects`**（`DSH_TASKWATCH_WORKSPACES` 可改），装到别的机器上要改。
11. **中继不在本仓库**：它是不是只转发白名单、令牌怎么比较、会不会把令牌转发给上游，
    都不由这里承诺；本仓库只保证「宿主这层的语义」和「票据能互认」。
12. **子代理会话不出现在手机列表里**（宿主内部干活会话，混进来只会让人点错）。

## 明确不算漏洞的

- 同网段的人打开 `/taskwatch` 就能看、能发消息（这是部署问题，见上面第 1、2 条）；
- 手机页把会话 id 显示成前 10 位加省略号（**只是排版**，完整 id 在 `data-sid` 属性里）；
- 你自己在 devtools / `~/.dsh` 里看到自己的数据；
- 模型产出的文本以 markdown 渲染、超长被截断；
- 文件名、会话标题含奇怪字符——它们只被当文本文本渲染，命名规范化不是内容审查；
- `DSH_TASKWATCH_ROOTS` 配错了导致能读到意料之外的目录（那是运维配置，不是代码缺陷）。

## 报告漏洞

用 GitHub 的私密渠道：<https://github.com/dingchenhui0618-arch/dsh-in-hand/security/advisories/new>

这是个人维护的项目，**我不承诺响应时限**；但我会读、会修，修完会在
[CHANGELOG](CHANGELOG.md) 里写清影响范围与修复版本。请不要把还在生效的问题直接发到公开 issue 里。

## 支持范围

只维护最新版 `1.7.x`（`npm view dsh-in-hand version` 当前为 `1.7.9`）。更早的版本不回补，
升级到最新版即可。
