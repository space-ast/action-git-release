import { isTag, normalizeTagName, parseInputFiles } from './util';
import type { PlatformName } from './platform/types';

type Env = { [key: string]: string | undefined };

export const PLATFORMS: PlatformName[] = ['gitee', 'gitcode', 'github'];

export const DEFAULT_API_BASE: Record<PlatformName, string> = {
  gitee: 'https://gitee.com/api/v5',
  gitcode: 'https://api.gitcode.com/api/v5',
  github: 'https://api.github.com',
};

export const DEFAULT_WEB_BASE: Record<PlatformName, string> = {
  gitee: 'https://gitee.com',
  gitcode: 'https://gitcode.com',
  github: 'https://github.com',
};

/** 各平台按优先级依次查找的 token 环境变量。 */
const TOKEN_ENV: Record<PlatformName, string[]> = {
  gitee: ['GITEE_TOKEN', 'GITEE_ACCESS_TOKEN', 'GITEE_API_TOKEN'],
  gitcode: ['GITCODE_TOKEN', 'GITCODE_ACCESS_TOKEN', 'GITCODE_API_TOKEN'],
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
};

/** 当用户既没传 `repository` 也没跑在 GitHub Actions 上时的兜底环境变量。 */
const REPOSITORY_ENV: Record<PlatformName, string[]> = {
  gitee: ['GITEE_REPOSITORY'],
  gitcode: ['GITCODE_REPOSITORY'],
  github: [],
};

const REF_NAME_ENV: Record<PlatformName, string[]> = {
  gitee: ['GITEE_REF_NAME', 'GITEE_TAG_NAME'],
  gitcode: ['GITCODE_REF_NAME', 'GITCODE_TAG_NAME'],
  github: [],
};

export interface Config {
  platform: PlatformName;
  api_base: string;
  web_base: string;
  token: string;
  /** 目标平台上的 `<owner>/<repo>`。 */
  repository: string;
  /** 解析出的 tag；工作流不是由 tag 触发时为 undefined。 */
  tag_name: string | undefined;
  github_ref: string;

  input_name?: string;
  input_body?: string;
  input_body_path?: string;
  input_files?: string[];
  input_working_directory?: string;
  input_overwrite_files?: boolean;
  input_draft?: boolean;
  input_preserve_order?: boolean;
  input_prerelease?: boolean;
  input_fail_on_unmatched_files?: boolean;
  input_target_commitish?: string;
  input_discussion_category_name?: string;
  input_generate_release_notes?: boolean;
  input_previous_tag?: string;
  input_append_body?: boolean;
  input_make_latest: 'true' | 'false' | 'legacy' | undefined;
}

const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined || value === '') {
    return undefined;
  }
  return value === 'true';
};

const parseMakeLatest = (value: string | undefined): 'true' | 'false' | 'legacy' | undefined => {
  if (value === 'true' || value === 'false' || value === 'legacy') {
    return value;
  }
  return undefined;
};

const firstNonEmpty = (env: Env, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
};

const safeHost = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

/**
 * 判定要发布到哪个平台。
 *
 * 顺序很重要：显式 `platform` 输入优先级最高，其次是可识别的 `api_url`，再其次是平台专属
 * token 环境变量；都没有时，认为这是一次普通的 GitHub Actions 运行、目标是 GitHub——
 * 这样在不使用任何新增输入的情况下，本 action 就是 softprops/action-gh-release 的直接替代。
 */
export const resolvePlatform = (env: Env, apiUrl: string | undefined): PlatformName => {
  const explicit = env.INPUT_PLATFORM?.trim();
  if (explicit && explicit !== 'auto') {
    if (!PLATFORMS.includes(explicit as PlatformName)) {
      throw new Error(
        `⚠️ Invalid 'platform' input: "${explicit}". Expected one of: ${PLATFORMS.join(', ')}, auto.`,
      );
    }
    return explicit as PlatformName;
  }

  if (apiUrl) {
    const host = safeHost(apiUrl);
    if (host.includes('gitcode')) return 'gitcode';
    if (host.includes('gitee')) return 'gitee';
    if (host.includes('github')) return 'github';
  }

  // 平台专属 token 的存在本身就是最可靠的信号：用户不会无缘无故配一个 GITEE_TOKEN。
  for (const platform of ['gitcode', 'gitee'] as const) {
    if (firstNonEmpty(env, TOKEN_ENV[platform])) {
      return platform;
    }
  }

  if (env.GITHUB_ACTIONS === 'true') {
    return 'github';
  }

  throw new Error(
    '⚠️ Unable to determine the target platform. Set one of:\n' +
      "  - the 'platform' input (gitee | gitcode | github)\n" +
      "  - the 'api_url' input pointing at the target API\n" +
      '  - a GITEE_TOKEN / GITCODE_TOKEN environment variable',
  );
};

const resolveToken = (env: Env, platform: PlatformName): string => {
  const input = env.INPUT_TOKEN?.trim();
  if (input) {
    return input;
  }
  const fallback = firstNonEmpty(env, TOKEN_ENV[platform]);
  if (fallback) {
    return fallback;
  }
  throw new Error(
    `⚠️ No token available for platform "${platform}". Pass the 'token' input, ` +
      `or set one of: ${TOKEN_ENV[platform].join(', ')}.`,
  );
};

const resolveRepository = (env: Env, platform: PlatformName): string => {
  const input = env.INPUT_REPOSITORY?.trim();
  if (input) {
    return input;
  }
  const githubRepo = env.GITHUB_REPOSITORY?.trim();
  if (githubRepo) {
    return githubRepo;
  }
  const fallback = firstNonEmpty(env, REPOSITORY_ENV[platform]);
  if (fallback) {
    return fallback;
  }
  const extra = REPOSITORY_ENV[platform].length ? `, ${REPOSITORY_ENV[platform].join(', ')}` : '';
  throw new Error(
    `⚠️ No repository specified. Pass the 'repository' input in <owner>/<repo> format, ` +
      `or set one of: GITHUB_REPOSITORY${extra}.`,
  );
};

/**
 * 与上游一致的 tag 判定：只有 `refs/tags/*` 才算 tag，
 * 避免分支推送被误当成「以分支名命名的 tag」。
 */
const resolveTagName = (env: Env, platform: PlatformName): string | undefined => {
  const input = normalizeTagName(env.INPUT_TAG_NAME?.trim());
  if (input) {
    return input;
  }
  if (isTag(env.GITHUB_REF ?? '')) {
    return normalizeTagName(env.GITHUB_REF);
  }
  if (env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME) {
    return env.GITHUB_REF_NAME;
  }
  return firstNonEmpty(env, REF_NAME_ENV[platform]);
};

export const parseConfig = (env: Env): Config => {
  const apiUrl = env.INPUT_API_URL?.trim() || undefined;
  const platform = resolvePlatform(env, apiUrl);

  return {
    platform,
    api_base: apiUrl ? apiUrl.replace(/\/$/, '') : DEFAULT_API_BASE[platform],
    web_base: DEFAULT_WEB_BASE[platform],
    token: resolveToken(env, platform),
    repository: resolveRepository(env, platform),
    tag_name: resolveTagName(env, platform),
    github_ref: env.GITHUB_REF || '',

    input_name: env.INPUT_NAME,
    input_body: env.INPUT_BODY,
    input_body_path: env.INPUT_BODY_PATH,
    input_files: parseInputFiles(env.INPUT_FILES || ''),
    input_working_directory: env.INPUT_WORKING_DIRECTORY || undefined,
    input_overwrite_files: parseBoolean(env.INPUT_OVERWRITE_FILES),
    input_draft: parseBoolean(env.INPUT_DRAFT),
    input_preserve_order: parseBoolean(env.INPUT_PRESERVE_ORDER),
    input_prerelease: parseBoolean(env.INPUT_PRERELEASE),
    input_fail_on_unmatched_files: env.INPUT_FAIL_ON_UNMATCHED_FILES === 'true',
    input_target_commitish: env.INPUT_TARGET_COMMITISH || undefined,
    input_discussion_category_name: env.INPUT_DISCUSSION_CATEGORY_NAME || undefined,
    input_generate_release_notes: env.INPUT_GENERATE_RELEASE_NOTES === 'true',
    input_previous_tag: env.INPUT_PREVIOUS_TAG?.trim() || undefined,
    input_append_body: env.INPUT_APPEND_BODY === 'true',
    input_make_latest: parseMakeLatest(env.INPUT_MAKE_LATEST),
  };
};
