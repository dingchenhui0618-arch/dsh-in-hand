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
