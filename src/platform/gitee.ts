import { readFile } from 'fs/promises';
import { statSync } from 'fs';
import { basename } from 'path';
import { request, requestJson, UPLOAD_MAX_ATTEMPTS, UPLOAD_TIMEOUT_MS, withQuery } from './http';
import { isNotFound } from './errors';
import type {
  Asset,
  Capabilities,
  PlatformName,
  Release,
  ReleaseMutation,
  Releaser,
  RepositoryRef,
} from './types';

/** Gitee 单个附件上限 100MB；GVP 项目放宽到 200MB。 */
const GITEE_ASSET_LIMIT_BYTES = 100 * 1024 * 1024;
const GITEE_GVP_ASSET_LIMIT_BYTES = 200 * 1024 * 1024;

/** Gitee 的 release 列表接口默认升序，翻页取太多也没意义，限制在 3 页。 */
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 3;

interface GiteeAsset {
  id?: number;
  name: string;
  size?: number;
  browser_download_url?: string;
}

interface GiteeRelease {
  id?: number;
  tag_name: string;
  target_commitish?: string;
  prerelease?: boolean;
  name?: string;
  body?: string;
  html_url?: string;
  /** 注意：这里只包含自动生成的源码包，不含上传的附件。 */
  assets?: GiteeAsset[];
}

interface GiteeAttachFile {
  id?: number;
  name: string;
  size?: number;
  browser_download_url?: string;
}

/**
 * Gitee 的 provider。
 *
 * 与 GitHub 的三处关键差异，决定了这里的实现方式：
 *  1. release 对象没有 `html_url`、没有 `upload_url`、也没有草稿态；
 *  2. 内嵌的 `assets` 只有自动生成的源码包，上传的附件必须单独查 `attach_files`；
 *  3. 创建与更新接口把 `tag_name`/`name`/`body` 都标为必填，更新时必须原样回传。
 */
export class GiteeReleaser implements Releaser {
  readonly platform: PlatformName = 'gitee';
  readonly capabilities: Capabilities = {
    draft: false,
    makeLatest: false,
    generateReleaseNotes: false,
    discussions: false,
  };

  /** 默认分支的缓存，按实例复用（一个实例只服务一个仓库）。 */
  private defaultBranchCache?: string;

  constructor(
    private readonly apiBase: string,
    readonly webBaseUrl: string,
    private readonly token: string,
  ) {}

  /** Gitee 全站用查询参数 `access_token` 认证，这里统一在 URL 上追加。 */
  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    return withQuery(`${this.apiBase}${path}`, { access_token: this.token, ...params });
  }

  private repoPath({ owner, repo }: RepositoryRef): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private toRelease(raw: GiteeRelease, { owner, repo }: RepositoryRef): Release {
    return {
      id: String(raw.id ?? raw.tag_name),
      tagName: raw.tag_name,
      name: raw.name ?? '',
      body: raw.body ?? '',
      targetCommitish: raw.target_commitish ?? '',
      // Gitee 没有草稿概念，创建即发布。
      draft: false,
      prerelease: Boolean(raw.prerelease),
      // API 目前不返回 html_url，按站点地址拼接，保证 url 输出可用。
      htmlUrl:
        raw.html_url ??
        `${this.webBaseUrl}/${owner}/${repo}/releases/tag/${encodeURIComponent(raw.tag_name)}`,
      // Gitee 没有「上传地址」这个概念，附件直接 POST 到 attach_files。
      uploadUrl: '',
      assets: [],
    };
  }

  private toAsset(raw: GiteeAttachFile): Asset {
    return {
      id: String(raw.id ?? raw.name),
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
    const path = `${this.repoPath({ owner, repo })}/releases/tags/${encodeURIComponent(tag)}`;
    const raw = await requestJson<GiteeRelease | undefined>({
      method: 'GET',
      url: this.url(path),
      platform: this.platform,
      allowStatuses: [404],
    });
    if (!raw) {
      return undefined;
    }
    const release = this.toRelease(raw, { owner, repo });
    return { ...release, assets: await this.listReleaseAssets({ owner, repo, release }) };
  }

  async createRelease(params: ReleaseMutation): Promise<Release> {
    const path = `${this.repoPath(params)}/releases`;
    const raw = await requestJson<GiteeRelease>({
      method: 'POST',
      url: this.url(path),
      platform: this.platform,
      headers: { 'content-type': 'application/json' },
      // 创建可能已经成功但响应丢失，重试有产生重复 release 的风险，
      // 交由 run.ts 在冲突时回退到「查找后更新」。
      maxAttempts: 1,
      body: JSON.stringify(await this.createBody(params)),
    });
    return this.toRelease(raw, params);
  }

  /**
   * 取仓库的默认分支。
   *
   * Gitee 的文档把 `target_commitish` 描述成「默认是当前默认分支」，但实测**它是必填的**——
   * 不传会直接返回 400 `target_commitish is missing`。所以这里必须自己把默认分支查出来补上。
   * 结果按仓库缓存，避免每个 release 都多打一次接口。
   */
  private async defaultBranch({ owner, repo }: RepositoryRef): Promise<string> {
    if (this.defaultBranchCache) {
      return this.defaultBranchCache;
    }
    const raw = await requestJson<{ default_branch?: string }>({
      method: 'GET',
      url: this.url(this.repoPath({ owner, repo })),
      platform: this.platform,
      // 查不到不代表不能用——令牌可能只有写 release 的权限。降级到兜底分支，
      // 真正的权限问题交给紧随其后的创建请求去报错，那里的信息更准确。
      allowStatuses: [404],
    });
    this.defaultBranchCache = raw?.default_branch || 'master';
    return this.defaultBranchCache;
  }

  /**
   * Gitee 的 PATCH 接口把 `tag_name`/`name`/`body` 标为必填 —— 漏传会把对应字段清空，
   * 因此这里始终把三者补齐后再提交。
   */
  async updateRelease(params: ReleaseMutation & { release: Release }): Promise<Release> {
    const { release } = params;
    const path = `${this.repoPath(params)}/releases/${encodeURIComponent(release.id)}`;
    const body: Record<string, unknown> = {
      tag_name: params.tagName,
      name: params.name || release.name || params.tagName,
      body: params.body ?? release.body ?? '',
    };
    if (params.prerelease !== undefined) {
      body.prerelease = params.prerelease;
    }
    const raw = await requestJson<GiteeRelease>({
      method: 'PATCH',
      url: this.url(path),
      platform: this.platform,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return this.toRelease(raw, params);
  }

  async listReleases({ owner, repo }: RepositoryRef): Promise<Release[]> {
    const path = `${this.repoPath({ owner, repo })}/releases`;
    const raw = await requestJson<GiteeRelease[]>({
      method: 'GET',
      url: this.url(path, { per_page: LIST_PAGE_SIZE, direction: 'desc' }),
      platform: this.platform,
    });
    return (raw ?? []).map((item) => this.toRelease(item, { owner, repo }));
  }

  async deleteRelease({
    owner,
    repo,
    release,
  }: RepositoryRef & { release: Release }): Promise<void> {
    const path = `${this.repoPath({ owner, repo })}/releases/${encodeURIComponent(release.id)}`;
    await request({ method: 'DELETE', url: this.url(path), platform: this.platform });
  }

  async listReleaseAssets({
    owner,
    repo,
    release,
  }: RepositoryRef & { release: Release }): Promise<Asset[]> {
    const path = `${this.repoPath({ owner, repo })}/releases/${encodeURIComponent(release.id)}/attach_files`;
    const collected: Asset[] = [];

    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const raw = await requestJson<GiteeAttachFile[]>({
        method: 'GET',
        url: this.url(path, { page, per_page: LIST_PAGE_SIZE }),
        platform: this.platform,
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
    this.assertAssetSize(name, path);

    // 先整个读进内存，这样重试时可以基于同一个 Blob 重建 FormData。
    const contents = await readFile(path);
    const blob = new Blob([contents]);

    const raw = await requestJson<GiteeAttachFile>({
      method: 'POST',
      url: this.url(
        `${this.repoPath({ owner, repo })}/releases/${encodeURIComponent(release.id)}/attach_files`,
      ),
      platform: this.platform,
      // 附件要跨境上传，60 秒的默认上限连 3MB 都不够。
      timeoutMs: UPLOAD_TIMEOUT_MS,
      maxAttempts: UPLOAD_MAX_ATTEMPTS,
      // 不要手动设置 Content-Type，fetch 需要自己写入 multipart 的 boundary。
      body: () => {
        const form = new FormData();
        form.append('file', blob, name);
        return form;
      },
    });
    return this.toAsset(raw);
  }

  async deleteReleaseAsset({
    owner,
    repo,
    release,
    assetId,
  }: RepositoryRef & { release: Release; assetId: string }): Promise<void> {
    const path =
      `${this.repoPath({ owner, repo })}/releases/${encodeURIComponent(release.id)}` +
      `/attach_files/${encodeURIComponent(assetId)}`;
    try {
      await request({ method: 'DELETE', url: this.url(path), platform: this.platform });
    } catch (error: unknown) {
      // 附件已经不存在了，对调用方而言目的已经达到。
      if (!isNotFound(error)) {
        throw error;
      }
      console.warn(`⚠️ Asset ${assetId} was already gone on Gitee; continuing.`);
    }
  }

  /**
   * Gitee 只在创建时接受这几个字段，`draft`/`make_latest` 等平台不支持的能力
   * 由 run.ts 提前告警，这里不做处理。
   */
  private async createBody(params: ReleaseMutation): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      tag_name: params.tagName,
      name: params.name || params.tagName,
      // Gitee 把 body 标为必填，空字符串是安全的兜底值。
      body: params.body ?? '',
      // 同样是必填，缺省时补上默认分支（见 defaultBranch 的说明）。
      target_commitish: params.targetCommitish || (await this.defaultBranch(params)),
    };
    if (params.prerelease !== undefined) {
      body.prerelease = params.prerelease;
    }
    return body;
  }

  /** 提前拦下必定失败的超大附件，而不是让用户等一次上传完再看到服务端报错。 */
  private assertAssetSize(name: string, path: string): void {
    const { size } = statSync(path);
    if (size > GITEE_GVP_ASSET_LIMIT_BYTES) {
      throw new Error(
        `⚠️ Asset ${name} is ${(size / 1024 / 1024).toFixed(1)}MB, which exceeds Gitee's 200MB limit ` +
          '(100MB for regular repositories). Split the artifact or upload it elsewhere.',
      );
    }
    if (size > GITEE_ASSET_LIMIT_BYTES) {
      console.warn(
        `⚠️ Asset ${name} is ${(size / 1024 / 1024).toFixed(1)}MB. Gitee only allows files over ` +
          '100MB in GVP repositories; this upload will fail otherwise.',
      );
    }
  }
}
