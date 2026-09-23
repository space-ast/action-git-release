# action-git-release

Publish releases to **Gitee**, **GitCode** or **GitHub** from GitHub Actions.

Inputs and outputs are named and behave the same as
[softprops/action-gh-release](https://github.com/softprops/action-gh-release).
Only two inputs are added: `platform` and `api_url`. Existing workflows need
almost no changes — swap the `uses:` line and point it at a platform:

```diff
- uses: softprops/action-gh-release@v3
+ uses: space-ast/action-git-release@v1
  with:
    files: dist/*.zip
+   platform: gitee
+   token: ${{ secrets.GITEE_TOKEN }}
```

[中文文档](README.md)

---

## Why

softprops' action only publishes to GitHub Releases, but plenty of projects build
on GitHub and still need to mirror artifacts to Gitee or GitCode. Existing
alternatives (e.g. `action-gitee-release`) use their own `gitee_*`-prefixed
inputs, so migrating means rewriting the workflow.

This action abstracts "which platform to publish to" behind a provider while
keeping the interface identical.

## Quick start

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

      - run: |
          mkdir -p dist
          echo "artifact" > dist/app.zip

      - uses: space-ast/action-git-release@v1
        with:
          platform: gitee            # or gitcode / github / auto
          token: ${{ secrets.GITEE_TOKEN }}
          files: dist/*.zip
          fail_on_unmatched_files: 'true'
```

`platform` defaults to `auto`, resolved in this order:

1. the `platform` input, when set to something other than `auto`
2. the host of `api_url`, when it contains `gitcode` / `gitee` / `github`
3. a platform-specific token env var: `GITCODE_TOKEN`, `GITCODE_ACCESS_TOKEN`,
   `GITEE_TOKEN`, `GITEE_ACCESS_TOKEN`
4. `github`, when running under GitHub Actions (`GITHUB_ACTIONS=true`)

Rule 4 means that with none of the new inputs set, this action is a drop-in
replacement for softprops. If none of the rules match, it fails with an
actionable error rather than guessing.

### Token and repository fallbacks

| Input | Resolution order |
| --- | --- |
| `token` | `token` input → `GITEE_TOKEN` / `GITEE_ACCESS_TOKEN` (gitee); `GITCODE_TOKEN` / `GITCODE_ACCESS_TOKEN` (gitcode); `GITHUB_TOKEN` / `GH_TOKEN` (github) |
| `repository` | `repository` input → `GITHUB_REPOSITORY` → `GITEE_REPOSITORY` / `GITCODE_REPOSITORY` |
| `tag_name` | `tag_name` input → `GITHUB_REF` (only `refs/tags/*`) → `GITHUB_REF_NAME` (only when `GITHUB_REF_TYPE=tag`) → `GITEE_REF_NAME` / `GITCODE_REF_NAME` |

> `action.yml` deliberately sets **no default** for `token`. A default of
> `${{ github.token }}` would always populate `INPUT_TOKEN`, which would make the
> environment-variable fallbacks dead code.

## Inputs

All softprops inputs behave identically: `body`, `body_path`, `name`, `tag_name`,
`draft`, `prerelease`, `preserve_order`, `files`, `working_directory`,
`overwrite_files` (default `true`), `fail_on_unmatched_files`, `repository`,
`token`, `target_commitish`, `discussion_category_name`,
`generate_release_notes`, `previous_tag`, `append_body`, `make_latest`.

Added:

| Input | Description |
| --- | --- |
| `platform` | `gitee` \| `gitcode` \| `github` \| `auto`, default `auto` |
| `api_url` | Override the API base (self-hosted Gitea, GitHub Enterprise) |

## Outputs

| Name | Description |
| --- | --- |
| `url` | Release page URL |
| `id` | Release ID. **On GitCode the tag is the identifier, so this equals the tag** |
| `upload_url` | Upload target. **Gitee has no such concept — empty string** |
| `assets` | JSON array of uploaded/overwritten assets: `{id, name, size, browser_download_url}` |

`assets` keeps upstream's `browser_download_url` field name, so this keeps working:

```yaml
- run: echo ${{ fromJSON(steps.release.outputs.assets)[0].browser_download_url }}
```

## Platform capability matrix

Gitee and GitCode do not have GitHub's full release feature set. Unsupported
capabilities are **warned about and ignored, never fatal** — migrated workflows
usually still carry GitHub-only inputs, and failing hard would make migration
painful.

| Capability | Gitee | GitCode | GitHub |
| --- | :---: | :---: | :---: |
| `draft` | ❌ | ❌ | ✅ |
| `make_latest` | ❌ | ⚠️ mapped to `release_status` | ✅ |
| `generate_release_notes` | ❌ | ❌ | ✅ |
| `discussion_category_name` | ❌ | ❌ | ❌ (not implemented) |
| Release identifier | `id` | `tag` | `id` |
| `html_url` from API | ❌ constructed | ❌ constructed | ✅ |
| `upload_url` from API | ❌ | ✅ presigned | ✅ |
| Asset upload | `{id}/attach_files` multipart | `upload_url` → PUT | `{upload_url}?name=` |
| Delete release | ✅ | ❌ no API | ✅ |

## Known limitations

- **No drafts on Gitee or GitCode.** `draft: true` logs
  `⚠️ platform 'gitee' does not support drafts; the release will be published immediately.`
  and creates a published release. This is *not* emulated: a release on those
  platforms is publicly visible the moment it exists, so pretending otherwise
  would only mislead.
- **`make_latest`, `generate_release_notes` and `discussion_category_name` are
  unavailable on Gitee.** Generate notes yourself and pass them via `body_path`.
- **GitCode exposes no API to delete a release**, only individual attachments.
  `deleteRelease` therefore throws an explicit error instead of failing silently.
- **GitCode's release object has no documented top-level `id`.** This
  implementation keys everything by tag, which is what GitCode's own update and
  delete endpoints use anyway. The practical effect is that the `id` output
  equals the tag.
- **GitCode asset upload is two-step** (fetch a presigned URL, then PUT). The docs
  say PUT; community examples have used multipart POST. PUT is tried first, with
  an automatic fallback to POST on 405/400.
- **Gitee caps single assets at 100MB** (200MB for GVP repositories). Above 200MB
  the upload fails before starting; between 100MB and 200MB it warns that only GVP
  repositories will accept it.
- **GitCode's `assets` array mixes auto-generated source archives with uploaded
  attachments.** They are separated by requiring both an `id` and a download URL
  that does not contain `/-/archive/`. Overwrite matching is by exact filename
  only, so source archives are never deleted.
- **The GitHub provider is a simplified implementation.** It covers the core paths
  with plain fetch but does not port upstream's throttling plugin, asset-label
  retry dance, or race handling. If you need those, keep using
  softprops/action-gh-release.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build         # bundles to dist/index.js
```

`dist/index.js` **must be committed** — GitHub runs it directly and never builds
on the fly. CI enforces this with `npm run build && git diff --exit-code dist/`.

### Testing

| Layer | Covers |
| --- | --- |
| Unit tests `__tests__/` | Config inference and fallback precedence; both providers' **request contracts** (method, path, body fields) — notably Gitee's PATCH carrying `tag_name`/`name`/`body`, GitCode addressing by tag rather than id, and the presigned PUT omitting the platform token; `run.ts` capability degradation, overwrite, and create-conflict fallback |
| Read-only smoke `scripts/smoke.mjs` | Runs the providers' normalisation against **live API responses**, proving the unit-test fixtures have not drifted from reality. Performs no writes |
| End-to-end `.github/workflows/e2e.yml` | Really creates a release and uploads assets to a scratch repo, then re-runs to verify overwrite and draft degradation. Manual trigger |

```bash
npm run smoke:gitee     # anonymous access works
npm run smoke:gitcode   # needs GITCODE_TOKEN (anonymous returns 403)
```

E2E requires `E2E_GITEE_TOKEN` and `E2E_GITCODE_TOKEN`, plus a scratch repository via
`E2E_GITEE_REPOSITORY` / `E2E_GITCODE_REPOSITORY` (or a single `E2E_REPOSITORY` when the
path is the same on both platforms).

A single run covers all three paths — create, update with overwrite, and draft
degradation — so there is no need to trigger it repeatedly. The scratch repository must
already exist and contain at least one commit; E2E really creates tags and releases in it.

## License

MIT. `src/util.ts` and the overall action interface are derived from
[softprops/action-gh-release](https://github.com/softprops/action-gh-release).
See [LICENSE](LICENSE) for attribution.
