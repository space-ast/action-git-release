# Changelog

## 0.1.0

首个版本。运行时是 GitHub Actions，发布目标是 Gitee / GitCode / GitHub。

### 输入输出对标 softprops/action-gh-release

- `body`、`body_path`、`name`、`tag_name`、`draft`、`prerelease`、`preserve_order`、
  `files`、`working_directory`、`overwrite_files`、`fail_on_unmatched_files`、
  `repository`、`token`、`target_commitish`、`discussion_category_name`、
  `generate_release_notes`、`previous_tag`、`append_body`、`make_latest` 全部同名同义。
- 输出 `url`、`id`、`upload_url`、`assets` 保持不变，`assets` 沿用
  `browser_download_url` 字段名。
- `src/util.ts` 从上游移植，保留 MIT 署名。

### 新增

- `platform` 输入：`gitee` | `gitcode` | `github` | `auto`，默认 `auto`。
  按「显式输入 → api_url 主机名 → 平台专属 token 环境变量 → GitHub Actions 环境」四级推断。
- `api_url` 输入：覆盖 API 根地址。
- `token` / `repository` / `tag_name` 按平台回退到环境变量。
- provider 抽象层（`src/platform/`），新增平台只需实现 `Releaser` 接口并注册一个分支。

### 平台适配

- **Gitee**：查询走 `releases/tags/{tag}`；创建与更新补齐 Gitee 标为必填的
  `tag_name`/`name`/`body`；附件走 `{id}/attach_files`；`html_url` 本地拼接
  （API 不返回）；上传前按 100MB / 200MB 两档检查体积。
- **GitCode**：全部操作以 tag 为标识符；`prerelease`/`make_latest` 映射到
  `release_status`；附件两步上传（换取预签名地址 → PUT，405/400 回退 multipart POST）；
  从 `assets` 中按「有 id 且下载地址不含 `/-/archive/`」筛出真正的附件。
- **GitHub**：原生 fetch 的简化实现，作为不改 workflow 也能跑的兼容兜底。

### 降级策略

不支持的能力一律告警后忽略，不中断构建：`draft`（Gitee/GitCode）、
`make_latest`（Gitee）、`generate_release_notes`（Gitee/GitCode）、
`discussion_category_name`（非 GitHub）。
