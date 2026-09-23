import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyResponse, installFetch, jsonResponse, pathOf, textResponse } from './helpers';

const setOutput = vi.fn();
const setFailed = vi.fn();

// vi.mock 会被 vitest 提升到文件顶部，因此这里用普通静态导入即可拿到被打桩的模块。
vi.mock('@actions/core', () => ({
  setOutput: (...args: unknown[]) => setOutput(...args),
  setFailed: (...args: unknown[]) => setFailed(...args),
}));

import { run } from '../src/run';

const RAW_RELEASE = {
  id: 316160,
  tag_name: 'v1.0.0',
  target_commitish: 'main',
  prerelease: false,
  name: 'v1.0.0',
  body: 'notes',
  assets: [],
};

let artifactPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'git-release-run-'));
  artifactPath = join(dir, 'artifact.zip');
  writeFileSync(artifactPath, 'payload');
});

const setEnv = (overrides: Record<string, string>): void => {
  for (const key of Object.keys(process.env)) {
    if (/^(INPUT_|GITEE_|GITCODE_|GITHUB_)/.test(key)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, overrides);
};

beforeEach(() => {
  setOutput.mockClear();
  setFailed.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('能力降级', () => {
  it('Gitee 上 draft:true 只告警，release 仍然被创建', async () => {
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((msg: string) => void warns.push(String(msg)));

    const requests = installFetch((req) => {
      if (req.url.includes('/tags/')) return jsonResponse({ message: 'Not Found' }, 404);
      if (req.method === 'POST') return jsonResponse(RAW_RELEASE);
      return jsonResponse([]);
    });

    setEnv({
      INPUT_PLATFORM: 'gitee',
      INPUT_TOKEN: 't',
      INPUT_REPOSITORY: 'acme/widget',
      INPUT_TAG_NAME: 'v1.0.0',
      INPUT_DRAFT: 'true',
    });

    await run();

    expect(setFailed).not.toHaveBeenCalled();
    expect(warns.some((w) => /does not support drafts/.test(w))).toBe(true);
    // 没有草稿能力的平台不能走「先建草稿再发布」，必须直接创建
    expect(requests.some((r) => r.method === 'POST')).toBe(true);
  });

  it('Gitee 上 generate_release_notes 被告警忽略，不会去调生成接口', async () => {
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((msg: string) => void warns.push(String(msg)));

    const requests = installFetch((req) => {
      if (req.url.includes('/tags/')) return jsonResponse({ message: 'Not Found' }, 404);
      if (req.method === 'POST') return jsonResponse(RAW_RELEASE);
      return jsonResponse([]);
    });

    setEnv({
      INPUT_PLATFORM: 'gitee',
      INPUT_TOKEN: 't',
      INPUT_REPOSITORY: 'acme/widget',
      INPUT_TAG_NAME: 'v1.0.0',
      INPUT_GENERATE_RELEASE_NOTES: 'true',
    });

    await run();

    expect(warns.some((w) => /does not support `generate_release_notes`/.test(w))).toBe(true);
    expect(requests.some((r) => r.url.includes('generate-notes'))).toBe(false);
    expect(setFailed).not.toHaveBeenCalled();
  });
});

describe('files 预检', () => {
  it('fail_on_unmatched_files 命中空 glob 时失败，且不创建 release', async () => {
    const requests = installFetch(() => jsonResponse(RAW_RELEASE));
    setEnv({
      INPUT_PLATFORM: 'gitee',
      INPUT_TOKEN: 't',
      INPUT_REPOSITORY: 'acme/widget',
      INPUT_TAG_NAME: 'v1.0.0',
      INPUT_FILES: 'definitely-missing-*.zip',
      INPUT_FAIL_ON_UNMATCHED_FILES: 'true',
    });

    await run();

    expect(setFailed).toHaveBeenCalledWith(expect.stringMatching(/does not match any files/));
    expect(requests).toHaveLength(0);
  });
});

describe('overwrite_files', () => {
  const existingRelease = {
    ...RAW_RELEASE,
    assets: [
      {
        id: 5,
        name: 'artifact.zip',
        browser_download_url: 'https://gitee.com/dl/artifact.zip',
      },
    ],
  };

  const responder = (req: { url: string; method: string }) => {
    if (req.url.includes('/tags/')) return jsonResponse(existingRelease);
    if (req.url.includes('/attach_files') && req.method === 'GET') {
      return jsonResponse(existingRelease.assets);
    }
    if (req.method === 'DELETE') return emptyResponse();
    if (req.url.includes('/attach_files')) {
      return jsonResponse({
        id: 9,
        name: 'artifact.zip',
        size: 7,
        browser_download_url: 'https://gitee.com/dl/new',
      });
    }
    return jsonResponse(existingRelease);
  };

  it('默认覆盖：先删同名附件再上传', async () => {
    const requests = installFetch(responder);
    setEnv({
      INPUT_PLATFORM: 'gitee',
      INPUT_TOKEN: 't',
      INPUT_REPOSITORY: 'acme/widget',
      INPUT_TAG_NAME: 'v1.0.0',
      INPUT_FILES: artifactPath,
    });

    await run();

    const deleted = requests.findIndex((r) => r.method === 'DELETE');
    const uploaded = requests.findIndex(
      (r) => r.method === 'POST' && r.url.includes('/attach_files'),
    );
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(uploaded).toBeGreaterThan(deleted);
    expect(setFailed).not.toHaveBeenCalled();
  });

  it('overwrite_files=false 时跳过，既不上传也不删除', async () => {
    const requests = installFetch(responder);
    setEnv({
      INPUT_PLATFORM: 'gitee',
      INPUT_TOKEN: 't',
      INPUT_REPOSITORY: 'acme/widget',
      INPUT_TAG_NAME: 'v1.0.0',
      INPUT_FILES: artifactPath,
      INPUT_OVERWRITE_FILES: 'false',
    });

    await run();

    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    expect(requests.some((r) => r.method === 'POST' && r.url.includes('/attach_files'))).toBe(
      false,
    );
    expect(setOutput).toHaveBeenCalledWith('assets', []);
  });
});

describe('输出', () => {
  it('输出 url / id / upload_url / assets，附件字段沿用上游的 browser_download_url', async () => {
    installFetch((req) => {
      if (req.url.includes('/tags/')) return jsonResponse({ message: 'Not Found' }, 404);
      if (req.method === 'POST' && pathOf(req.url).endsWith('/releases')) {
        return jsonResponse(RAW_RELEASE);
      }
      if (req.method === 'POST') {
        return jsonResponse({
          id: 9,
          name: 'artifact.zip',
          size: 7,
          browser_download_url: 'https://gitee.com/dl/artifact.zip',
        });
      }
      return jsonResponse([
        {
          id: 9,
          name: 'artifact.zip',
          size: 7,
          browser_download_url: 'https://gitee.com/dl/artifact.zip',
        },
      ]);
    });

    setEnv({
      INPUT_PLATFORM: 'gitee',
      INPUT_TOKEN: 't',
      INPUT_REPOSITORY: 'acme/widget',
      INPUT_TAG_NAME: 'v1.0.0',
      INPUT_FILES: artifactPath,
    });

    await run();

    expect(setOutput).toHaveBeenCalledWith(
      'url',
      'https://gitee.com/acme/widget/releases/tag/v1.0.0',
    );
    expect(setOutput).toHaveBeenCalledWith('id', '316160');
    expect(setOutput).toHaveBeenCalledWith('upload_url', '');
    expect(setOutput).toHaveBeenCalledWith('assets', [
      {
        id: '9',
        name: 'artifact.zip',
        size: 7,
        browser_download_url: 'https://gitee.com/dl/artifact.zip',
      },
    ]);
  });
});

describe('并发冲突兜底', () => {
  it('创建时撞上已存在的 release，回查后改走更新', async () => {
    let createAttempted = false;
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((msg: string) => void warns.push(String(msg)));

    const requests = installFetch((req) => {
      const path = pathOf(req.url);
      if (req.method === 'POST' && path.endsWith('/releases')) {
        createAttempted = true;
        return textResponse('{"message":"Release 已存在"}', 422);
      }
      if (req.method === 'PATCH') return jsonResponse(RAW_RELEASE);
      if (path.includes('/attach_files')) return jsonResponse([]);
      // 冲突之前查不到，冲突之后回查才拿到——模拟并发 workflow 抢先建好了 release
      return createAttempted
        ? jsonResponse(RAW_RELEASE)
        : jsonResponse({ message: 'Not Found' }, 404);
    });

    setEnv({
      INPUT_PLATFORM: 'gitee',
      INPUT_TOKEN: 't',
      INPUT_REPOSITORY: 'acme/widget',
      INPUT_TAG_NAME: 'v1.0.0',
    });

    await run();

    expect(setFailed).not.toHaveBeenCalled();
    expect(warns.some((w) => /already exists/.test(w))).toBe(true);
    expect(requests.some((r) => r.method === 'PATCH')).toBe(true);
  });
});
