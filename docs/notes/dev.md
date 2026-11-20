# 开发与测试

> 仓库里没有构建步骤，但检查脚本不少：这一篇写清每个 check 脚本在证明什么、为什么宿主那一半也必须钉住。
>
> 这一篇是从 [README](../../README.md) 拆出来的：内容与当时实装一致，只搬了容器、修了相对路径，没有改写。

[回到 README](../../README.md) · [文档索引](../../README.md#文档)

## 开发

```sh
npm run check                   # bundle、文件边界、上传路由、页面契约与票据 HMAC 互认测试
node scripts/make-icons.mjs     # 重新生成图标（自实现 PNG 编码，零依赖）
node scripts/make-demo.mjs      # 生成 docs/demo.html（假数据，供截图与预览）
```

（`check` / `icons` / `demo` 也都有对应的 npm script。）

`check-bundle.mjs` 不只检查客户端：它还**真的 import 宿主半边**，断言
`name` / `apply` / `inject` 三个导出都在，并把 `cordis.patch.yml`、`exports`、
`dsh` 元数据一并核对。

`check-uploads.mjs` 会起一个本地 `node:http` 测试服务器，覆盖混合附件发送、会话隔离、
失败重试、数量 / 总大小限制、错误的请求方法与类型，以及宿主缺少上传服务时的错误提示；
测试只使用内存 fake 服务，不会连接真实模型。

`check-ticket-hmac.mjs` 覆盖跨进程票据：宿主签 → 中继实例验、中继签 → 宿主验、篡改签名、
过期 / 超长跨度、老格式随机票仍走原 Map、以及密钥文件自动生成（只断言存在与长度，
从不打印内容）。中继那一侧在本机存在时是**真的 spawn 一个临时端口实例**（临时令牌、
不碰 3099 生产进程，测完杀掉）；中继目录不在本机时这两条明确 SKIP，公开仓库的 CI 不会
因此变红。

为什么宿主也要钉住：Cordis 的 `inject` 决定框架等哪些服务就绪后才调用 `apply`。
`webServer` 的服务是在启动阶段之后才发布的，而 `apply` 在组合期就会被调用——
只写 `ctx.get('webServer')` 软读会在那一刻拿到 `undefined`，于是整段路由注册被
静默跳过。现象是插件"装好了、也不报错，但 `/taskwatch` 一律 404"，极难定位。
（v1.0.0 正是踩了这个坑。）同理 `kind:'prefix'` 与 `kind:'exact'` 都合法，但
重复的 `(kind, path)` 会让 `register()` 抛错——所以路由路径也纳入断言。

`scripts/make-icons.mjs` 是手写 PNG 编码（Node 内置 zlib + 自实现 CRC32），满幅不透明
方形，图形落在中心 80% 安全区内，因此同一个文件既能当普通图标也能当 maskable。

`scripts/make-demo.mjs` 从 `lib/page.html` **生成**演示页，只把取数逻辑换成一份固定
假数据。之所以是生成而不是手写：手写就意味着 CSS 与结构有两份副本，必然漂移，截图会
慢慢变成一张不像当前 UI 的图。README 里那两张图就是从生成物截的，所以只要 `page.html`
变了，重跑脚本再截一次就与实现一致。
