# action-git-release

在 GitHub Actions 上把 release 发布到 **Gitee**、**GitCode** 或 **GitHub**。

输入输出与 [softprops/action-gh-release](https://github.com/softprops/action-gh-release) 同名同义，
只额外增加了 `platform` 和 `api_url` 两项。既有的 workflow 基本不用改，把 `uses:` 换掉即可：

```diff
- uses: softprops/action-gh-release@v3
+ uses: space-ast/action-git-release@v1
  with:
    files: dist/*.zip
+   platform: gitee
+   token: ${{ secrets.GITEE_TOKEN }}
```

[English](README.en.md)

---

## 为什么需要它

softprops 的 action 只能发布到 GitHub Releases。而很多项目是在 GitHub 上构建、
却需要把构件同步发布到 Gitee / GitCode 的镜像仓库。现有的替代方案（如
`action-gitee-release`）用的是 `gitee_*` 前缀的自定义输入，接口和 softprops 完全不同，
迁移等于重写一遍 workflow。

这个 action 把「发布到哪个平台」抽象成 provider，接口保持不变，
所以两边都能用同一份 workflow 配置。

## 快速开始

### 发布到 Gitee

```yaml
name: Release

on:
  push:
    tags: ['v*.*.*']

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: 构建
        run: |
          mkdir -p dist
          echo "artifact" > dist/app.zip

      - name: 发布到 Gitee
        uses: space-ast/action-git-release@v1
        with:
          platform: gitee
          token: ${{ secrets.GITEE_TOKEN }}
          files: dist/*.zip
          fail_on_unmatched_files: 'true'
```

### 发布到 GitCode

```yaml
      - name: 发布到 GitCode
        uses: space-ast/action-git-release@v1
        with:
          platform: gitcode
          token: ${{ secrets.GITCODE_TOKEN }}
          files: dist/*.zip
```

### 同时发布到多个平台

矩阵构建下每个平台跑一个 job，互不干扰：

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - platform: gitee
            token: GITEE_TOKEN
          - platform: gitcode
            token: GITCODE_TOKEN
    steps:
      - uses: actions/checkout@v4
      - uses: space-ast/action-git-release@v1
        with:
          platform: ${{ matrix.platform }}
          token: ${{ secrets[matrix.token] }}
          files: dist/*.zip
```

### 省略 platform，靠环境变量自动推断

```yaml
      - uses: space-ast/action-git-release@v1
        env:
          GITEE_TOKEN: ${{ secrets.GITEE_TOKEN }}
        with:
          files: dist/*.zip
```

## 平台是怎么推断出来的

`platform` 默认为 `auto`，按以下顺序判定：

1. 显式传入的 `platform` 输入（`gitee` / `gitcode` / `github`）
2. `api_url` 的主机名里包含 `gitcode` / `gitee` / `github`
3. 存在平台专属的 token 环境变量：`GITCODE_TOKEN`、`GITCODE_ACCESS_TOKEN`、
   `GITEE_TOKEN`、`GITEE_ACCESS_TOKEN`
4. 在 GitHub Actions 环境下（`GITHUB_ACTIONS=true`）判定为 `github`

第 4 条保证了：不传任何新增输入时，本 action 就是 softprops 的直接替代。
实在判断不出来时会明确报错，并列出三种显式指定的方式。

### token 与 repository 的兜底

| 输入 | 取值顺序 |
| --- | --- |
| `token` | `token` 输入 → `GITEE_TOKEN` / `GITEE_ACCESS_TOKEN` (gitee)；`GITCODE_TOKEN` / `GITCODE_ACCESS_TOKEN` (gitcode)；`GITHUB_TOKEN` / `GH_TOKEN` (github) |
| `repository` | `repository` 输入 → `GITHUB_REPOSITORY` → `GITEE_REPOSITORY` / `GITCODE_REPOSITORY` |
| `tag_name` | `tag_name` 输入 → `GITHUB_REF`（仅 `refs/tags/*`）→ `GITHUB_REF_NAME`（仅 `GITHUB_REF_TYPE=tag`）→ `GITEE_REF_NAME` / `GITCODE_REF_NAME` |

> `action.yml` 里**故意没有给 `token` 设默认值**。如果设成 `${{ github.token }}`，
> GitHub 会始终把它填进 `INPUT_TOKEN`，环境变量兜底就永远不会生效了。

若 Gitee 上的仓库路径和 GitHub 不同，显式传 `repository: gitee-org/repo`。

## 输入

与 softprops 同名的输入行为一致，不再赘述，见其文档。下面只列新增与有差异的部分。

| 输入 | 说明 |
| --- | --- |
| `platform` | `gitee` \| `gitcode` \| `github` \| `auto`，默认 `auto` |
| `api_url` | 覆盖 API 根地址，例如自建的 Gitea 或 GitHub 企业版 |

其余输入：`body`、`body_path`、`name`、`tag_name`、`draft`、`prerelease`、`preserve_order`、
`files`、`working_directory`、`overwrite_files`（默认 `true`）、`fail_on_unmatched_files`、
`repository`、`token`、`target_commitish`、`discussion_category_name`、
`generate_release_notes`、`previous_tag`、`append_body`、`make_latest`。

## 输出

| 名称 | 说明 |
| --- | --- |
| `url` | release 页面地址 |
| `id` | release ID。**GitCode 以 tag 作标识，此处即 tag** |
| `upload_url` | 上传地址。**Gitee 没有这个概念，为空字符串** |
| `assets` | 本次上传/覆盖的附件，JSON 数组，元素形如 `{id, name, size, browser_download_url}` |

`assets` 沿用了上游的 `browser_download_url` 字段名，所以这种既有写法可以照用：

```yaml
- run: echo ${{ fromJSON(steps.release.outputs.assets)[0].browser_download_url }}
```

## 平台能力差异

Gitee 和 GitCode 并不具备 GitHub 的全部 release 能力。本 action 的做法是：
**不支持的能力打印告警后忽略，而不是中断构建**——迁移过来的 workflow 里往往还留着
GitHub 专用的输入，直接失败会让迁移寸步难行。

| 能力 | Gitee | GitCode | GitHub |
| --- | :---: | :---: | :---: |
| `draft` 草稿 | ❌ | ❌ | ✅ |
| `make_latest` | ❌ | ⚠️ 映射为 `release_status` | ✅ |
| `generate_release_notes` | ❌ | ❌ | ✅ |
| `discussion_category_name` | ❌ | ❌ | ❌（本实现未接入） |
| release 标识符 | `id` | `tag` | `id` |
| `html_url` 由 API 返回 | ❌ 本地拼接 | ❌ 本地拼接 | ✅ |
| `upload_url` 由 API 返回 | ❌ | ✅ 对象存储预签名 | ✅ |
| 附件上传方式 | `{id}/attach_files` multipart | `upload_url` → PUT | `{upload_url}?name=` |
| 删除 release | ✅ | ❌ 无此接口 | ✅ |

## 已知限制

- **Gitee / GitCode 没有草稿态**。`draft: true` 会打印
  `⚠️ platform 'gitee' does not support drafts; the release will be published immediately.`
  然后直接创建一个已发布的 release。这里**不会伪造**「先草稿后发布」的行为——
  那两个平台上的 release 一旦创建就对外可见，假装有草稿只会让人误判。
- **Gitee 的 `make_latest`、`generate_release_notes`、`discussion_category_name` 均不可用**，
  只告警不生效。需要 release notes 请用 `body_path` 自己生成。
- **Gitee 创建 release 时 `target_commitish` 实际是必填的**，尽管其 API 文档把它描述成
  「默认是当前默认分支」——漏传会直接返回 400 `target_commitish is missing`（实测确认）。
  未显式指定时，本 action 会先查一次仓库默认分支补上，结果按仓库缓存。
- **GitCode 没有删除 release 的公开接口**，只有删除单个附件。因此 `deleteRelease`
  会明确报错而不是静默失败。
- **GitCode 的 release 对象文档里没有顶层 `id`**（尽管部分英文文档又暗示有）。
  本实现统一以 tag 作为标识符——GitCode 的更新与删除接口本来就按 tag 寻址，
  所以这个不一致不影响功能，但会让 `id` 输出等于 tag。
- **GitCode 附件上传是两步（换取预签名地址 → PUT）**，文档说用 PUT，
  但社区示例里出现过 multipart POST。实现以 PUT 为主，遇到 405/400 会自动回退成 POST。
- **Gitee 单个附件上限 100MB**（GVP 项目 200MB）。超过 200MB 会在上传前直接报错，
  100MB～200MB 之间会告警提示只有 GVP 仓库能传成功。
- **GitCode 的 release 对象里 `assets` 混着自动生成的源码包和上传的附件**。
  本实现按「有 `id` 且下载地址不含 `/-/archive/`」两条判据筛出真正的附件；
  覆盖写时也只按文件名精确匹配删除，避免误删源码包。
- **GitHub provider 是简化实现**。它用原生 fetch 覆盖了核心路径，但没有移植上游的
  节流插件、资产标签回滚重试与竞态处理。需要那些行为时请继续使用
  softprops/action-gh-release；本 action 的 GitHub 支持定位是「不改 workflow 也能跑」。

## 从 softprops 迁移

1. 换掉 `uses:`。
2. 加上 `platform` 与对应的 `token`。
3. 如果目标仓库路径和 GitHub 不同，加上 `repository: <owner>/<repo>`。
4. 删掉或保留 GitHub 专用输入都行——不支持的会被告警忽略。
5. `GITHUB_TOKEN` 不够用：Gitee 需要私人令牌（勾选 `projects` 权限），
   GitCode 需要访问令牌。

## 开发

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run fmt           # prettier
npm run build         # esbuild 打包到 dist/index.js
```

`dist/index.js` **必须提交进仓库**——GitHub 直接执行它，不会现场构建。
CI 里有一道 `npm run build && git diff --exit-code dist/` 的检查，
改了 `src` 却忘记重新构建会直接失败。

### 测试策略

| 层次 | 覆盖内容 |
| --- | --- |
| 单元测试 `__tests__/` | 配置推断与兜底优先级；两个 provider 的**请求契约**（方法、路径、请求体字段），特别是 Gitee 的 PATCH 必须回传 `tag_name`/`name`/`body`、GitCode 按 tag 而非 id 寻址、预签名 PUT 不带平台 token；`run.ts` 的能力降级、覆盖写、并发冲突兜底 |
| 只读冒烟 `scripts/smoke.mjs` | 拿**平台真实响应**跑 provider 的归一化逻辑，验证单测里的 fixture 没有和实际行为脱节。不做任何写操作 |
| 端到端 `.github/workflows/e2e.yml` | 在专用测试仓库里真的创建 release、上传附件、重跑验证覆盖写与 draft 降级。需手动触发 |

```bash
npm run smoke:gitee     # 匿名即可跑
npm run smoke:gitcode   # 需要 GITCODE_TOKEN（GitCode 匿名访问返回 403）
```

E2E 需要配置 secrets：`E2E_GITEE_TOKEN`、`E2E_GITCODE_TOKEN`，以及测试仓库
`E2E_GITEE_REPOSITORY` / `E2E_GITCODE_REPOSITORY`（两个平台路径相同时只配 `E2E_REPOSITORY` 即可）。

一次运行就会依次走完创建、更新 + 覆盖写、draft 降级三条路径，不需要重复触发。
测试仓库必须是**已有的、至少含一个提交**的仓库，且建议专用——E2E 会在里面真实打 tag、建 release。

## 许可证

MIT。本项目的 `src/util.ts` 及整体接口设计移植自
[softprops/action-gh-release](https://github.com/softprops/action-gh-release)，
版权署名见 [LICENSE](LICENSE)。
