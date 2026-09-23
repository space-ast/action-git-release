export type PlatformName = 'gitee' | 'gitcode' | 'github';

/**
 * 平台能力声明。`run.ts` 依据它决定哪些输入可用，而不是默认套用 GitHub 的语义——
 * 不支持的能力会打印告警并降级，而不是抛出一个让人摸不着头脑的 API 错误。
 */
export interface Capabilities {
  /** 是否支持草稿 release。Gitee 与 GitCode 都是创建即发布，没有草稿态。 */
  draft: boolean;
  /** 能否把某个 release 标记为仓库的最新版本。 */
  makeLatest: boolean;
  /** 能否由服务端根据提交/PR 自动生成 release notes。 */
  generateReleaseNotes: boolean;
  /** 能否给 release 关联一个 discussion。 */
  discussions: boolean;
}

export interface Asset {
  id: string;
  name: string;
  size?: number;
  downloadUrl: string;
}

export interface Release {
  /** Gitee 与 GitHub 返回数字 id；GitCode 以 tag 为键，这里直接复用 tag。 */
  id: string;
  tagName: string;
  name: string;
  body: string;
  targetCommitish: string;
  draft: boolean;
  prerelease: boolean;
  htmlUrl: string;
  /** 平台相关的上传目标。Gitee 没有这个概念，为空字符串。 */
  uploadUrl: string;
  assets: Asset[];
}

export interface RepositoryRef {
  owner: string;
  repo: string;
}

export interface ReleaseMutation {
  owner: string;
  repo: string;
  tagName: string;
  name: string;
  body: string | undefined;
  draft: boolean | undefined;
  prerelease: boolean | undefined;
  targetCommitish: string | undefined;
  makeLatest: 'true' | 'false' | 'legacy' | undefined;
}

export interface Releaser {
  readonly platform: PlatformName;
  readonly capabilities: Capabilities;
  /** 站点根地址，用于在平台 API 不返回 html_url 时自行拼接 release 页面地址。 */
  readonly webBaseUrl: string;

  /** 按 tag 查 release，不存在时返回 undefined（而不是抛错）。 */
  getReleaseByTag(params: RepositoryRef & { tag: string }): Promise<Release | undefined>;
  createRelease(params: ReleaseMutation): Promise<Release>;
  updateRelease(params: ReleaseMutation & { release: Release }): Promise<Release>;
  listReleases(params: RepositoryRef): Promise<Release[]>;
  deleteRelease(params: RepositoryRef & { release: Release }): Promise<void>;

  listReleaseAssets(params: RepositoryRef & { release: Release }): Promise<Asset[]>;
  uploadReleaseAsset(params: RepositoryRef & { release: Release; path: string }): Promise<Asset>;
  deleteReleaseAsset(params: RepositoryRef & { release: Release; assetId: string }): Promise<void>;

  /**
   * 把草稿 release 正式发布出去。只有支持草稿的平台会实现；
   * 其余平台没有这一步，`run.ts` 会跳过。
   */
  finalizeRelease?(
    params: RepositoryRef & {
      release: Release;
      makeLatest: 'true' | 'false' | 'legacy' | undefined;
    },
  ): Promise<Release>;

  /** 由服务端生成 release notes。仅 GitHub 实现，对应 `capabilities.generateReleaseNotes`。 */
  generateReleaseNotes?(params: {
    owner: string;
    repo: string;
    tagName: string;
    targetCommitish: string | undefined;
    previousTag: string | undefined;
  }): Promise<{ name: string; body: string }>;
}
