# 发版

四步，一步一条命令。版本以 `1.8.13` 为例。

1. **改 CHANGELOG**：在 `CHANGELOG.md` 顶部加一段 `## v1.8.13 — 一句话标题`（里面可以有
   `###` 子标题），并把 `package.json` 的 `version` 改成同一个号 —— 生成器只读这两处，
   不需要别的清单。

2. **生成正文并自查**：`npm run release:notes` 打印正文，`npm run release:notes -- --check`
   校验 CHANGELOG 段落与 `package.json` 版本一致（不一致退出码 1 并点名两边版本），
   `npm run release:notes -- --out release.md` 落盘成 UTF-8 无 BOM、LF 的文件。
   ```sh
   npm run release:notes -- --check && npm run release:notes -- --out release.md
   ```

3. **打 tag 推送**：`git tag -a v1.8.13 -m "v1.8.13"`，推 main 与 tag；tag 会触发
   `publish.yml` 自动 `npm publish`（Trusted Publishing，无 token）。
   ```sh
   git push origin main && git push origin v1.8.13
   ```

4. **发 Release**：把 `release.md` 的内容贴成 GitHub Release 正文，标题用版本号即可。
   ```sh
   gh release create v1.8.13 --title "v1.8.13" --notes-file release.md
   ```

发完等 2–3 分钟，`npm view dsh-in-hand version` 应显示新版本。

## 补发历史 Release

v1.5.2 之后只打过 tag、没有建 Release，补档用一条命令。脚本默认只读，不会自己发布。

1. **先看清单（dry-run，只读）**：

   ```sh
   node scripts/publish-releases.mjs --from 1.8.0 --to 1.8.13
   ```

   每行一个 tag，状态是 `create` / `skip(已存在)` / `missing(无 CHANGELOG 段落)`，
   结尾一行汇总；有 `missing` 时退出码 2，先补 CHANGELOG 段落再继续。`--from/--to`
   含端点，按语义化版本比较；不给就用仓库里最旧/最新的 tag。

2. **确认后执行**：

   ```sh
   node scripts/publish-releases.mjs --from 1.8.0 --to 1.8.13 --apply --yes
   ```

   `--apply` 才真正调用 `gh release create <tag> --title "dsh-in-hand <tag>"
   --notes-file <临时文件> --verify-tag`；已有 Release 的 tag 会跳过，重复跑是安全的。
   没有 `--yes`、或者不在交互终端里（被脚本/CI 调起）时，脚本会拒绝执行并退出，什么都不建。

> **注意：这一步会对外发布。** 它会在 GitHub 上创建公开的 Release 页面，属于对外动作，
> 执行前必须先得到用户同意；不要自己跑 `--apply`。

