# Changelog

## Unreleased

### 修复

- **大附件跨境上传必定失败。** Node 内置 fetch（undici）的 `headersTimeout` 默认 300 秒，
  且实测这条计时**从请求发出就开始跑、不等 body 发完**，因此 34MB 的产物会稳定在 301 秒
  被掐断（Gitee 上实测只有 20–90 KB/s）。现在通过全局 dispatcher 把它放宽到 31 分钟，
  并由每个请求自己的 `AbortSignal` 做真正的超时控制：普通 API 调用 60 秒，
  上传附件 30 分钟、最多 2 次尝试。超时后报错会写明等了多久，而不是只抛一个 `TimeoutError`。
- **上传失败只剩一句 `TypeError: fetch failed`。** fetch 把真正的原因（`ECONNRESET`、对端
  关闭、TLS 握手失败……）藏在 `cause` 链里，之前只打最外层，跨境上传连续失败时日志里没有
  任何可供排查的线索。现在整条原因链都会展开，并带上 `code`/`errno`/`syscall`；同时补上
  本次尝试实际耗掉的墙钟时间——它能区分「刚连上就挂」和「传完几十 MB 才挂」。

### 变更

- 新增 `undici` 依赖（dist 686KB → 1.2MB），`engines.node` 相应提升到 `>=22.19.0`。

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
