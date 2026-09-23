import { readFile } from 'fs/promises';
import { statSync } from 'fs';
import { basename } from 'path';
import { lookup } from 'mime-types';
import { request, requestJson, withQuery } from './http';
import { isNotFound } from './errors';
import { uploadUrl } from '../util';
import type {
  Asset,
  Capabilities,
  PlatformName,
  Release,
  ReleaseMutation,
  Releaser,
  RepositoryRef,
} from './types';

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 3;

interface GitHubAsset {
  id: number;
  name: string;
  label?: string | null;
  size?: number;
  browser_download_url?: string;
}

interface GitHubRelease {
  id: number;
  tag_name: string;
  target_commitish?: string;
  draft?: boolean;
  prerelease?: boolean;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  upload_url?: string;
  assets?: GitHubAsset[];
}

/**
 * GitHub 的 provider。
 *
 * 定位是「兼容兜底」：让本 action 在毫不改动 workflow 的情况下也能继续发布到 GitHub。
 * 这里用原生 fetch 实现核心路径，**没有**移植上游的节流插件、资产标签回滚重试与竞态处理——
 * 需要那些行为时请继续使用 softprops/action-gh-release。
 */
export class GitHubReleaser implements Releaser {
  readonly platform: PlatformName = 'github';
  readonly capabilities: Capabilities = {
    draft: true,
    makeLatest: true,
    generateReleaseNotes: true,
    discussions: false,
  };

  constructor(
    private readonly apiBase: string,
    readonly webBaseUrl: string,
    private readonly token: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': '2022-11-28',
    };
  }

  private api(path: string, params: Record<string, string | number | undefined> = {}): string {
    return withQuery(`${this.apiBase}${path}`, params);
  }

  private repoPath({ owner, repo }: RepositoryRef): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private toRelease(raw: GitHubRelease): Release {
    return {
      id: String(raw.id),
      tagName: raw.tag_name,
      name: raw.name ?? '',
      body: raw.body ?? '',
      targetCommitish: raw.target_commitish ?? '',
      draft: Boolean(raw.draft),
      prerelease: Boolean(raw.prerelease),
      htmlUrl: raw.html_url ?? '',
      uploadUrl: raw.upload_url ?? '',
      assets: (raw.assets ?? []).map((item) => this.toAsset(item)),
    };
  }

  private toAsset(raw: GitHubAsset): Asset {
    return {
      id: String(raw.id),
      name: raw.name,
      size: raw.size,
      downloadUrl: raw.browser_download_url ?? '',
    };
  }

  async getReleaseByTag({
    owner,
    repo,
    tag,
  }: RepositoryRef & { tag: string }): Promise<Release | undefined> {
    const raw = await requestJson<GitHubRelease | undefined>({
      method: 'GET',
      url: this.api(`${this.repoPath({ owner, repo })}/releases/tags/${encodeURIComponent(tag)}`),
      platform: this.platform,
      headers: this.headers,
      allowStatuses: [404],
    });
    return raw ? this.toRelease(raw) : undefined;
  }

  async createRelease(params: ReleaseMutation): Promise<Release> {
    // 与上游保持一致：先建草稿、传完附件再发布，避免 release 事件在附件就绪前触发。
    const draft = params.prerelease === true ? params.draft === true : true;
    const body = this.mutationBody(params);
    body.draft = draft;

    const raw = await requestJson<GitHubRelease>({
      method: 'POST',
      url: this.api(`${this.repoPath(params)}/releases`),
      platform: this.platform,
      headers: { ...this.headers, 'content-type': 'application/json' },
      maxAttempts: 1,
      body: JSON.stringify(body),
    });
    return this.toRelease(raw);
  }

  async updateRelease(params: ReleaseMutation & { release: Release }): Promise<Release> {
    const body = this.mutationBody(params);
    // 更新时不改草稿状态，除非用户在输入里明确要求。
    if (params.draft !== undefined) {
      body.draft = params.draft;
    }
    const raw = await requestJson<GitHubRelease>({
      method: 'PATCH',
      url: this.api(`${this.repoPath(params)}/releases/${params.release.id}`),
      platform: this.platform,
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.toRelease(raw);
  }

  async finalizeRelease({
    owner,
    repo,
    release,
    makeLatest,
  }: RepositoryRef & {
    release: Release;
    makeLatest: 'true' | 'false' | 'legacy' | undefined;
  }): Promise<Release> {
    const body: Record<string, unknown> = { draft: false };
    if (makeLatest !== undefined) {
      body.make_latest = makeLatest;
    }
    const raw = await requestJson<GitHubRelease>({
      method: 'PATCH',
      url: this.api(`${this.repoPath({ owner, repo })}/releases/${release.id}`),
      platform: this.platform,
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.toRelease(raw);
  }

  async generateReleaseNotes({
    owner,
    repo,
    tagName,
    targetCommitish,
    previousTag,
  }: {
    owner: string;
    repo: string;
    tagName: string;
    targetCommitish: string | undefined;
    previousTag: string | undefined;
  }): Promise<{ name: string; body: string }> {
    const raw = await requestJson<{ name?: string; body?: string }>({
      method: 'POST',
      url: this.api(`${this.repoPath({ owner, repo })}/releases/generate-notes`),
      platform: this.platform,
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: tagName,
        target_commitish: targetCommitish,
        previous_tag_name: previousTag,
      }),
    });
    return { name: raw?.name ?? '', body: raw?.body ?? '' };
  }

  async listReleases({ owner, repo }: RepositoryRef): Promise<Release[]> {
    const collected: Release[] = [];
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const raw = await requestJson<GitHubRelease[]>({
        method: 'GET',
        url: this.api(`${this.repoPath({ owner, repo })}/releases`, {
          page,
          per_page: LIST_PAGE_SIZE,
        }),
        platform: this.platform,
        headers: this.headers,
      });
      const batch = raw ?? [];
      collected.push(...batch.map((item) => this.toRelease(item)));
      if (batch.length < LIST_PAGE_SIZE) {
        break;
      }
    }
    return collected;
  }

  async deleteRelease({
    owner,
    repo,
    release,
  }: RepositoryRef & { release: Release }): Promise<void> {
    await request({
      method: 'DELETE',
      url: this.api(`${this.repoPath({ owner, repo })}/releases/${release.id}`),
      platform: this.platform,
      headers: this.headers,
    });
  }

  async listReleaseAssets({
    owner,
    repo,
    release,
  }: RepositoryRef & { release: Release }): Promise<Asset[]> {
    const collected: Asset[] = [];
    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const raw = await requestJson<GitHubAsset[]>({
        method: 'GET',
        url: this.api(`${this.repoPath({ owner, repo })}/releases/${release.id}/assets`, {
          page,
          per_page: LIST_PAGE_SIZE,
        }),
        platform: this.platform,
        headers: this.headers,
      });
      const batch = raw ?? [];
      collected.push(...batch.map((item) => this.toAsset(item)));
      if (batch.length < LIST_PAGE_SIZE) {
        break;
      }
    }
    return collected;
  }

  async uploadReleaseAsset({
    owner,
    repo,
    release,
    path,
  }: RepositoryRef & { release: Release; path: string }): Promise<Asset> {
    const name = basename(path);
    const mime = lookup(path) || 'application/octet-stream';
    const endpoint = withQuery(uploadUrl(release.uploadUrl), { name });
    const blob = new Blob([await readFile(path)]);

    const raw = await requestJson<GitHubAsset>({
      method: 'POST',
      url: endpoint,
      platform: this.platform,
      headers: {
        ...this.headers,
        'content-type': String(mime),
        'content-length': String(statSync(path).size),
      },
      body: () => blob,
    });

    // GitHub 会把文件名里的特殊字符改写掉，上传后按需把原始名字补回 label。
    if (raw?.name && raw.name !== name && raw.id) {
      try {
        const updated = await requestJson<GitHubAsset>({
          method: 'PATCH',
          url: this.api(`${this.repoPath({ owner, repo })}/releases/assets/${raw.id}`),
          platform: this.platform,
          headers: { ...this.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ name: raw.name, label: name }),
        });
        return this.toAsset(updated);
      } catch (error: unknown) {
        console.warn(`⚠️ Could not restore asset label for ${name}: ${String(error)}`);
      }
    }

    return this.toAsset(raw);
  }

  async deleteReleaseAsset({
    owner,
    repo,
    assetId,
  }: RepositoryRef & { release: Release; assetId: string }): Promise<void> {
    try {
      await request({
        method: 'DELETE',
        url: this.api(`${this.repoPath({ owner, repo })}/releases/assets/${assetId}`),
        platform: this.platform,
        headers: this.headers,
      });
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error;
      }
      console.warn(`⚠️ Asset ${assetId} was already gone on GitHub; continuing.`);
    }
  }

  private mutationBody(params: ReleaseMutation): Record<string, unknown> {
    const body: Record<string, unknown> = {
      tag_name: params.tagName,
      name: params.name || params.tagName,
      body: params.body ?? '',
    };
    if (params.prerelease !== undefined) {
      body.prerelease = params.prerelease;
    }
    if (params.targetCommitish) {
      body.target_commitish = params.targetCommitish;
    }
    if (params.makeLatest !== undefined) {
      body.make_latest = params.makeLatest;
    }
    return body;
  }
}
