import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GiteeReleaser } from '../src/platform/gitee';
import {
  emptyResponse,
  installFetch,
  jsonBodyOf,
  jsonResponse,
  pathOf,
  queryParam,
} from './helpers';

const API = 'https://gitee.com/api/v5';
const WEB = 'https://gitee.com';
const TOKEN = 'gitee-secret';
const REF = { owner: 'acme', repo: 'widget' };

const makeReleaser = () => new GiteeReleaser(API, WEB, TOKEN);

/** 实测到的 Gitee release 结构：没有 html_url、没有 upload_url、没有 draft。 */
const RAW_RELEASE = {
  id: 316160,
  tag_name: 'v1.0.0',
  target_commitish: '6ca3efba016f40cb1333a9fb8f57d73802440aef',
  prerelease: false,
  name: 'version 1.0.0',
  body: 'Version 1.0.0',
  created_at: '2023-06-28T10:12:54+08:00',
  assets: [
    {
      name: 'v1.0.0.zip',
      browser_download_url: 'https://gitee.com/acme/widget/archive/v1.0.0.zip',
    },
  ],
};

let artifactPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'git-release-'));
  artifactPath = join(dir, 'artifact.zip');
  writeFileSync(artifactPath, 'binary-ish payload');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GiteeReleaser.getReleaseByTag', () => {
  it('404 时返回 undefined 而不是抛错或返回错误体', async () => {
    installFetch(() => jsonResponse({ message: 'Not Found' }, 404));
    await expect(makeReleaser().getReleaseByTag({ ...REF, tag: 'v9' })).resolves.toBeUndefined();
  });

  it('拼接 API 缺失的 html_url，并把内嵌的源码包排除在 assets 之外', async () => {
    const requests = installFetch((req) =>
      req.url.includes('attach_files')
        ? jsonResponse([
            {
              id: 11,
              name: 'artifact.zip',
              size: 2048,
              browser_download_url: 'https://gitee.com/dl/artifact.zip',
            },
          ])
        : jsonResponse(RAW_RELEASE),
    );

    const release = await makeReleaser().getReleaseByTag({ ...REF, tag: 'v1.0.0' });

    expect(release?.id).toBe('316160');
    expect(release?.htmlUrl).toBe('https://gitee.com/acme/widget/releases/tag/v1.0.0');
    expect(release?.uploadUrl).toBe('');
    // 没有草稿态，draft 恒为 false
    expect(release?.draft).toBe(false);
    expect(release?.assets).toEqual([
      {
        id: '11',
        name: 'artifact.zip',
        size: 2048,
        downloadUrl: 'https://gitee.com/dl/artifact.zip',
      },
    ]);
    expect(requests.filter((r) => r.url.includes('attach_files'))).toHaveLength(1);
  });

  it('access_token 通过查询参数传递', async () => {
    const requests = installFetch((req) =>
      req.url.includes('attach_files') ? jsonResponse([]) : jsonResponse(RAW_RELEASE),
    );
    await makeReleaser().getReleaseByTag({ ...REF, tag: 'v1.0.0' });
    expect(queryParam(requests[0].url, 'access_token')).toBe(TOKEN);
  });
});

describe('GiteeReleaser.createRelease', () => {
  it('POST 到 releases，并补齐 Gitee 标为必填的字段', async () => {
    const requests = installFetch(() => jsonResponse(RAW_RELEASE));
    await makeReleaser().createRelease({
      ...REF,
      tagName: 'v1.0.0',
      name: '',
      body: undefined,
      draft: undefined,
      prerelease: true,
      targetCommitish: 'main',
      makeLatest: undefined,
    });

    const req = requests[0];
    expect(req.method).toBe('POST');
    expect(pathOf(req.url)).toBe('/api/v5/repos/acme/widget/releases');

    const body = jsonBodyOf(req);
    expect(body.tag_name).toBe('v1.0.0');
    // name / body 在 Gitee 是必填，缺省时必须补上安全值而不是留空
    expect(body.name).toBe('v1.0.0');
    expect(body.body).toBe('');
    expect(body.prerelease).toBe(true);
    expect(body.target_commitish).toBe('main');
  });

  it('不传 target_commitish 时交由 Gitee 使用默认分支', async () => {
    const requests = installFetch(() => jsonResponse(RAW_RELEASE));
    await makeReleaser().createRelease({
      ...REF,
      tagName: 'v1.0.0',
      name: 'v1.0.0',
      body: 'notes',
      draft: undefined,
      prerelease: undefined,
      targetCommitish: undefined,
      makeLatest: undefined,
    });
    expect(jsonBodyOf(requests[0])).not.toHaveProperty('target_commitish');
  });
});

describe('GiteeReleaser.updateRelease', () => {
  it('PATCH 到 release id，且必须回传 tag_name/name/body', async () => {
    const requests = installFetch(() => jsonResponse(RAW_RELEASE));
    const existing = {
      id: '316160',
      tagName: 'v1.0.0',
      name: 'version 1.0.0',
      body: 'old body',
      targetCommitish: 'main',
      draft: false,
      prerelease: false,
      htmlUrl: '',
      uploadUrl: '',
      assets: [],
    };

    await makeReleaser().updateRelease({
      ...REF,
      release: existing,
      tagName: 'v1.0.0',
      name: '',
      body: 'new body',
      draft: undefined,
      prerelease: undefined,
      targetCommitish: 'main',
      makeLatest: undefined,
    });

    const req = requests[0];
    expect(req.method).toBe('PATCH');
    // 关键是按 id 寻址，且三个必填字段一个都不能少——漏传会被 Gitee 清空
    expect(pathOf(req.url)).toBe('/api/v5/repos/acme/widget/releases/316160');
    const body = jsonBodyOf(req);
    expect(body.tag_name).toBe('v1.0.0');
    expect(body.name).toBe('version 1.0.0');
    expect(body.body).toBe('new body');
  });
});

describe('GiteeReleaser 附件操作', () => {
  const release = {
    id: '316160',
    tagName: 'v1.0.0',
    name: '',
    body: '',
    targetCommitish: '',
    draft: false,
    prerelease: false,
    htmlUrl: '',
    uploadUrl: '',
    assets: [],
  };

  it('上传走 multipart，字段名为 file', async () => {
    const requests = installFetch(() =>
      jsonResponse({
        id: 12,
        name: 'artifact.zip',
        size: 18,
        browser_download_url: 'https://gitee.com/dl',
      }),
    );

    const asset = await makeReleaser().uploadReleaseAsset({ ...REF, release, path: artifactPath });

    const req = requests[0];
    expect(req.method).toBe('POST');
    expect(pathOf(req.url)).toBe('/api/v5/repos/acme/widget/releases/316160/attach_files');
    expect(req.body).toBeInstanceOf(FormData);
    const file = (req.body as FormData).get('file');
    expect((file as File).name).toBe('artifact.zip');
    // 不能手动指定 Content-Type，否则 fetch 写不进 multipart 的 boundary
    expect(req.headers['content-type']).toBeUndefined();
    expect(asset.id).toBe('12');
  });

  it('删除走 attach_files/{id}', async () => {
    const requests = installFetch(() => emptyResponse());
    await makeReleaser().deleteReleaseAsset({ ...REF, release, assetId: '12' });
    expect(requests[0].method).toBe('DELETE');
    expect(pathOf(requests[0].url)).toBe(
      '/api/v5/repos/acme/widget/releases/316160/attach_files/12',
    );
  });

  it('附件已经不存在时删除不报错', async () => {
    installFetch(() => jsonResponse({ message: 'Not Found' }, 404));
    await expect(
      makeReleaser().deleteReleaseAsset({ ...REF, release, assetId: '12' }),
    ).resolves.toBeUndefined();
  });
});
