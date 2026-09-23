import { readFile } from 'fs/promises';
import { basename } from 'path';
import { request, requestJson, UPLOAD_MAX_ATTEMPTS, UPLOAD_TIMEOUT_MS, withQuery } from './http';
import { isNotFound, PlatformError } from './errors';
import { sleep } from '../util';
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

/** 上传完成后附件不是立即可见的，轮询几次再放弃。 */
const ASSET_LOOKUP_ATTEMPTS = 3;
const ASSET_LOOKUP_DELAY_MS = 1000;

interface GitCodeAsset {
  id?: number | string;
  name: string;
  type?: string;
  browser_download_url?: string;
}

interface GitCodeRelease {
  id?: number | string;
  tag_name: string;
  target_commitish?: string;
  prerelease?: boolean;
  name?: string;
  body?: string;
  html_url?: string;
  /** 同时包含自动生成的源码包和上传的附件，靠 `id` 与下载地址区分。 */
  assets?: GitCodeAsset[];
  /** `pre` 表示预发布，`latest` 表示最新版本。 */
  release_status?: string;
}

interface UploadTicket {
  url: string;
  headers?: Record<string, string>;
}

/**
 * GitCode 的 provider。
 *
 * 与 GitHub 的两处关键差异：
 *  1. **以 tag 为标识符**：查询、更新、删除附件走的都是 `/releases/{tag}`，而不是数字 id；
 *  2. **附件走两步上传**：先向 `upload_url` 要一个对象存储预签名地址，再把文件 PUT 上去。
 */
export class GitCodeReleaser implements Releaser {
  readonly platform: PlatformName = 'gitcode';
  readonly capabilities: Capabilities = {
    draft: false,
    // GitCode 用 release_status 表达「预发布 / 最新版本」，可以近似覆盖 make_latest。
    makeLatest: true,
    generateReleaseNotes: false,
    discussions: false,
  };

  constructor(
    private readonly apiBase: string,
    readonly webBaseUrl: string,
    private readonly token: string,
  ) {}

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    return withQuery(`${this.apiBase}${path}`, { access_token: this.token, ...params });
  }

  private repoPath({ owner, repo }: RepositoryRef): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private releasePath(ref: RepositoryRef, tag: string): string {
    return `${this.repoPath(ref)}/releases/${encodeURIComponent(tag)}`;
  }

  private toRelease(raw: GitCodeRelease, { owner, repo }: RepositoryRef): Release {
    return {
      // 文档里的 release 对象没有顶层 id，缺失时退回用 tag 作为标识符——
      // 反正 GitCode 的写操作本来就是按 tag 寻址的。
      id: String(raw.id ?? raw.tag_name),
      tagName: raw.tag_name,
      name: raw.name ?? '',
      body: raw.body ?? '',
      targetCommitish: raw.target_commitish ?? '',
      // 没有草稿态，创建即发布。
      draft: false,
      prerelease: raw.prerelease ?? raw.release_status === 'pre',
      htmlUrl:
        raw.html_url ??
        `${this.webBaseUrl}/${owner}/${repo}/releases/tag/${encodeURIComponent(raw.tag_name)}`,
      uploadUrl: '',
      assets: [],
    };
  }

  /**
   * 从 release 的 `assets` 里挑出「用户上传的附件」。
   *
   * 这个数组混了两类东西：自动生成的源码包（`{repo}-{tag}.zip` 之类）和上传的附件。
   * 用两个条件同时筛：附件有 `id`，且下载地址不属于源码包的 `/-/archive/` 路径。
   * 双重判据是为了避免把源码包当成附件删掉——误删是不可逆的。
   */
  private toUploadedAssets(raw: GitCodeRelease): Asset[] {
    return (raw.assets ?? [])
      .filter((item) => item.id !== undefined && item.id !== null)
      .filter((item) => !(item.browser_download_url ?? '').includes('/-/archive/'))
      .map((item) => ({
        id: String(item.id),
        name: item.name,
        downloadUrl: item.browser_download_url ?? '',
      }));
  }

  async getReleaseByTag({
    owner,
    repo,
    tag,
  }: RepositoryRef & { tag: string }): Promise<Release | undefined> {
    const ref = { owner, repo };
    const raw = await requestJson<GitCodeRelease | undefined>({
      method: 'GET',
      url: this.url(`${this.repoPath(ref)}/releases/tags/${encodeURIComponent(tag)}`),
      platform: this.platform,
      allowStatuses: [404],
    });
    if (!raw) {
      return undefined;
    }
    const release = this.toRelease(raw, ref);
    return { ...release, assets: this.toUploadedAssets(raw) };
  }

  async createRelease(params: ReleaseMutation): Promise<Release> {
    const raw = await requestJson<GitCodeRelease>({
      method: 'POST',
      url: this.url(`${this.repoPath(params)}/releases`),
      platform: this.platform,
      headers: { 'content-type': 'application/json' },
      // 重试可能产生重复 release，冲突场景交给 run.ts 回退到「查找后更新」。
      maxAttempts: 1,
      body: JSON.stringify(this.mutationBody(params)),
    });
    return { ...this.toRelease(raw, params), assets: this.toUploadedAssets(raw) };
  }

  async updateRelease(params: ReleaseMutation & { release: Release }): Promise<Release> {
    const { release } = params;
    const body: Record<string, unknown> = {
      // 更新接口同样把 name/body 标为必填，缺失时回传原值而不是留空。
      name: params.name || release.name || params.tagName,
      body: params.body ?? release.body ?? '',
    };
    const status = this.releaseStatus(params);
    if (status) {
      body.release_status = status;
    }

    const raw = await requestJson<GitCodeRelease>({
      method: 'PATCH',
      url: this.url(this.releasePath(params, params.tagName)),
      platform: this.platform,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ...this.toRelease(raw, params), assets: this.toUploadedAssets(raw) };
  }

  async listReleases({ owner, repo }: RepositoryRef): Promise<Release[]> {
    const ref = { owner, repo };
    const collected: Release[] = [];

    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const raw = await requestJson<GitCodeRelease[]>({
        method: 'GET',
        url: this.url(`${this.repoPath(ref)}/releases`, {
          page,
          per_page: LIST_PAGE_SIZE,
          direction: 'desc',
        }),
        platform: this.platform,
      });
      const batch = raw ?? [];
      collected.push(...batch.map((item) => this.toRelease(item, ref)));
      if (batch.length < LIST_PAGE_SIZE) {
        break;
      }
    }

    return collected;
  }

  /**
   * GitCode 没有公开的「删除 release」接口，只有删除单个附件。
   * 本 action 只在清理孤儿草稿时用到它，而 GitCode 根本没有草稿态，所以这里直接明确报错。
   */
  async deleteRelease({ release }: RepositoryRef & { release: Release }): Promise<void> {
    throw new Error(
      `⚠️ GitCode does not expose an API to delete a release (tried release ${release.tagName}). ` +
        'Delete it from the GitCode web UI instead.',
    );
  }

  /**
   * 每次实查。GitCode 没有独立的附件列表接口，只能从 release 对象里取，
   * 而上传后 `run.ts` 需要拿到最新结果，缓存一份旧数据只会让它读到过期状态。
   */
  async listReleaseAssets({
    owner,
    repo,
    release,
  }: RepositoryRef & { release: Release }): Promise<Asset[]> {
    const raw = await requestJson<GitCodeRelease | undefined>({
      method: 'GET',
      url: this.url(this.releasePath({ owner, repo }, release.tagName)),
      platform: this.platform,
      allowStatuses: [404],
    });
    return raw ? this.toUploadedAssets(raw) : [];
  }

  /**
   * 两步上传：先换取对象存储预签名地址，再 PUT 文件。
   *
   * 预签名请求由 OBS 校验签名，多带任何认证头都可能导致签名不匹配，
   * 因此这一步**不能**带上平台的 access_token。
   */
  async uploadReleaseAsset({
    owner,
    repo,
    release,
    path,
  }: RepositoryRef & { release: Release; path: string }): Promise<Asset> {
    const name = basename(path);
    const ref = { owner, repo };

    const ticket = await requestJson<UploadTicket>({
      method: 'GET',
      url: this.url(`${this.releasePath(ref, release.tagName)}/upload_url`, { file_name: name }),
      platform: this.platform,
    });
    if (!ticket?.url) {
      throw new Error(
        `⚠️ GitCode did not return an upload URL for ${name} on release ${release.tagName}.`,
      );
    }

    // 一次性读入内存，这样重试/回退时都能复用同一个 Blob。
    const blob = new Blob([await readFile(path)]);
    const headers = ticket.headers ?? {};
    await this.putAsset(ticket.url, headers, blob, name);

    const uploaded = await this.findAsset(ref, release.tagName, name);
    if (!uploaded) {
      throw new Error(
        `⚠️ Uploaded ${name} but it did not appear on release ${release.tagName} afterwards. ` +
          'The upload may have failed silently; check the GitCode release page.',
      );
    }
    return uploaded;
  }

  /**
   * 按文档走 PUT。文档与社区示例对此存在分歧（有示例用 multipart POST），
   * 所以 405/400 时回退到 POST 再试一次。
   */
  private async putAsset(
    url: string,
    headers: Record<string, string>,
    blob: Blob,
    name: string,
  ): Promise<void> {
    try {
      await request({
        method: 'PUT',
        url,
        platform: this.platform,
        headers,
        // 对象存储直传同样是跨境的慢链路，用与 attach_files 相同的宽限。
        timeoutMs: UPLOAD_TIMEOUT_MS,
        maxAttempts: UPLOAD_MAX_ATTEMPTS,
        body: () => blob,
      });
      return;
    } catch (error: unknown) {
      const status = error instanceof PlatformError ? error.status : undefined;
      if (status !== 405 && status !== 400) {
        throw error;
      }
      console.warn(
        `⚠️ GitCode upload endpoint rejected PUT (${status}); retrying ${name} as multipart POST…`,
      );
    }

    await request({
      method: 'POST',
      url,
      platform: this.platform,
      headers,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      maxAttempts: UPLOAD_MAX_ATTEMPTS,
      body: () => {
        const form = new FormData();
        form.append('file', blob, name);
        return form;
      },
    });
  }

  /** 上传接口本身不回传附件 id，只能回查 release 把它找出来。 */
  private async findAsset(
    ref: RepositoryRef,
    tag: string,
    name: string,
  ): Promise<Asset | undefined> {
    for (let attempt = 1; attempt <= ASSET_LOOKUP_ATTEMPTS; attempt++) {
      const raw = await requestJson<GitCodeRelease | undefined>({
        method: 'GET',
        url: this.url(this.releasePath(ref, tag)),
        platform: this.platform,
        allowStatuses: [404],
      });
      const found = raw
        ? this.toUploadedAssets(raw).find((asset) => asset.name === name)
        : undefined;
      if (found) {
        return found;
      }
      if (attempt < ASSET_LOOKUP_ATTEMPTS) {
        await sleep(ASSET_LOOKUP_DELAY_MS);
      }
    }
    return undefined;
  }

  async deleteReleaseAsset({
    owner,
    repo,
    release,
    assetId,
  }: RepositoryRef & { release: Release; assetId: string }): Promise<void> {
    const path =
      `${this.releasePath({ owner, repo }, release.tagName)}` +
      `/attach_files/${encodeURIComponent(assetId)}`;
    try {
      await request({ method: 'DELETE', url: this.url(path), platform: this.platform });
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error;
      }
      console.warn(`⚠️ Asset ${assetId} was already gone on GitCode; continuing.`);
    }
  }

  private mutationBody(params: ReleaseMutation): Record<string, unknown> {
    const body: Record<string, unknown> = {
      tag_name: params.tagName,
      name: params.name || params.tagName,
      body: params.body ?? '',
    };
    if (params.targetCommitish) {
      body.target_commitish = params.targetCommitish;
    }
    const status = this.releaseStatus(params);
    if (status) {
      body.release_status = status;
    }
    return body;
  }

  /**
   * 把 prerelease / make_latest 映射到 GitCode 的 `release_status`。
   *
   * 这个字段把「预发布」和「最新版本」压成了同一个枚举，所以无法表达
   * `make_latest: false`（「不要设为最新」）——那种情况只能省略字段，保持现状。
   * 预发布优先，与 GitHub「预发布不能同时是最新版」的语义一致。
   */
  private releaseStatus(params: ReleaseMutation): 'pre' | 'latest' | undefined {
    if (params.prerelease === true) {
      return 'pre';
    }
    if (params.prerelease === false || params.makeLatest === 'true') {
      return 'latest';
    }
    // make_latest: false / legacy 在 GitCode 上没有对应表达，交给平台自行决定。
    return undefined;
  }
}
