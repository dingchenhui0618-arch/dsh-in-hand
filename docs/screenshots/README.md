# 文档截图索引

**旧图仅作历史留存，README 只引用 `current/`。** 本目录里的截图分成两代：

- `current/`：v1.8.0 发布时补拍手机端审批 4 张；其余 7 张仍是 v1.7.9 按 v1.7.8 界面重拍的，README 唯一引用的一组。
- 根目录其它 PNG：v1.7.6 / v1.7.7 / v1.7.8 及更早的对比图与成品图，**不再被 README 引用**，
  保留只为查历史问题时能对上当时的界面。

## current/（README 引用）

所有图都是 `docs/demo.html` 的真实渲染（`npm run shots`：真 Chrome + CDP、DPR2、
390×844；`wide-360.png` 为 360×844），数据来自演示会话，图上保留
「演示数据 · 非真实状态」标记；图内那张退避曲线也写着「演示数据 · 非真实图表」。
审批 4 张同样是真 Chrome 渲染，但**审批状态是注入的**：没有在真实手机上点过，
`approval-expired.png` 的「已退回桌面」是把 `expiresAt` 设成过去后由页面自己的
倒计时逻辑收起，不是等满 120 秒。

| 文件名 | 体现的界面状态 | 对应版本 | 是否 demo 数据 |
| --- | --- | --- | --- |
| `current/chat-light.png` | 亮色主对话：折叠工具卡「4 个步骤 · 全部完成」、助手正文、底部指标行与状态条 | v1.7.8 界面（v1.7.9 重拍） | 是 |
| `current/chat-dark.png` | 暗色同一屏：主题、状态条与输入框都走暗色令牌 | v1.7.8 界面（v1.7.9 重拍） | 是 |
| `current/code-block.png` | 长代码块：右上角「可横滑」，`pre` 内部横滚（362 / 911），页面本身不溢宽 | v1.7.8 界面（v1.7.9 重拍） | 是 |
| `current/subagents.png` | 子代理二级页：2 个，运行中 / 空闲，标注父会话，从主对话独立进入 | v1.7.8 界面（v1.7.9 重拍） | 是 |
| `current/drawer.png` | 会话抽屉：字号三档（小 / 中 / 大）、只看对话、运行中 / 最近、子代理入口 | v1.7.8 界面（v1.7.9 重拍） | 是 |
| `current/empty.png` | 空状态：虎鲸标、三句快捷提问；上方仍有「子代理 2」入口 | v1.7.8 界面（v1.7.9 重拍） | 是 |
| `current/wide-360.png` | 360 宽：真表格 + 超长 URL 断行，页面级无横向溢出（360 / 360） | v1.7.8 界面（v1.7.9 重拍） | 是 |
| `current/approval-card.png` | 手机端待批准卡片：「批准一次」主按钮 + 红色描边「拒绝」、`mm:ss` 倒计时、120 秒说明 | v1.8.0 | 是（审批状态注入） |
| `current/approval-confirm.png` | 批准二次确认层：「确认允许一次？」+ 取消 / 允许一次（拒绝不弹） | v1.8.0 | 是（审批状态注入） |
| `current/approval-done.png` | 提交成功：按钮收起，徽标「已处理」，状态「已提交 · 允许一次」 | v1.8.0 | 是（approve 打桩成功） |
| `current/approval-expired.png` | 倒计时归零：按钮收起，徽标「已退回」，状态「已退回桌面」 | v1.8.0 | 是（`expiresAt` 设为过去） |

重拍脚本：`npm run shots`（`scripts/make-shots.mjs`）。它会对每张图断言
`documentElement.scrollWidth <= innerWidth`、`body.scrollWidth <= innerWidth` 且没有破图；
任一失败就退出非 0，不留下“看起来能用”的图。

## 历史版本截图（勿引用）

| 文件名 | 当时的界面 / 用途 | 对应版本 | 是否 demo 数据 |
| --- | --- | --- | --- |
| `screenshot-1.png` | 最早一代的手机对话页 | v1.3 之前 | 是 |
| `screenshot-2.png` | 最早一代的会话抽屉 | v1.3 之前 | 是 |
| `phone-home.png` | 手机首屏，顶部「远端」胶囊 + 子代理 27 | v1.5.x | 未记录 |
| `phone-chat-steps.png` | 真实会话把 19 个步骤折成一行 | v1.5.x | 否（真实会话） |
| `gui-taskwatch-entry.png` | DSH 桌面端侧边栏里的「掌上 DSH」入口 | v1.5.x | 否 |
| `v1.7.6-before.png` | 表格还是竖线文本（改前） | v1.7.5 | 是 |
| `v1.7.6-light.png` | 真表格 / 可横滑代码（改后） | v1.7.6 | 是 |
| `v1.7.6-dark.png` | 暗色排版 | v1.7.6 | 是 |
| `v1.7.6-subagents.png` | 子代理列表（首次有二级页时） | v1.7.6 | 是 |
| `v1.7.7-broken-before.png` | 63px ERR 占位卡（改前） | v1.7.6 | 是 |
| `v1.7.7-broken-after.png` | 36px 坏图提示条（改后） | v1.7.7 | 是 |
| `v1.7.7-subagents-icon.png` | 会话抽屉里的子代理入口图标 | v1.7.7 | 是 |
| `v1.7.8-flash-before.png` | 整屏流光把页面撑到 601（改前） | v1.7.7 | 是 |
| `v1.7.8-flash-after.png` | 流光关进图片盒，390 静止（改后） | v1.7.8 | 是 |
| `route-entries-390.png` | 双入口菜单（远端 / 局域网） | v1.7.5 | 否（真实渲染） |

> 版本号按当时发布说明回溯；早期几张没有逐张记录精确小版本，写的是大致的代际。
> 若要引用其中某张，请先确认它仍然代表当前界面，否则按 `current/` 的方式重拍。
