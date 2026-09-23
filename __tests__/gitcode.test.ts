import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GitCodeReleaser } from '../src/platform/gitcode';
import {
  emptyResponse,
  installFetch,
  jsonBodyOf,
  jsonResponse,
  pathOf,
  queryParam,
} from './helpers';

const API = 'https://api.gitcode.com/api/v5';
const WEB = 'https://gitcode.com';
const TOKEN = 'gitcode-secret';
const REF = { owner: 'acme', repo: 'widget' };

const makeReleaser = () => new GitCodeReleaser(API, WEB, TOKEN);

const release = {
  id: 'v1.0.0',
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

/** 真实响应里 assets 混着自动生成的源码包和上传的附件。 */
const RAW_WITH_MIXED_ASSETS = {
  tag_name: 'v1.0.0',
  target_commitish: '930401b0',
  prerelease: false,
  name: 'v1.0.0',
  body: 'notes',
  release_status: 'latest',
  assets: [
    {
      name: 'widget-v1.0.0.zip',
      browser_download_url: 'https://gitcode.com/acme/widget/-/archive/v1.0.0/widget-v1.0.0.zip',
    },
    {
      id: 77,
      name: 'artifact.zip',
      browser_download_url: 'https://gitcode.com/acme/widget/releases/download/v1.0.0/artifact.zip',
    },
  ],
};

let artifactPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'git-release-gc-'));
  artifactPath = join(dir, 'artifact.zip');
  writeFileSync(artifactPath, 'binary-ish payload');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GitCodeReleaser.getReleaseByTag', () => {
  it('404 时返回 undefined', async () => {
    installFetch(() => jsonResponse({ error_message: 'not found' }, 404));
    await expect(makeReleaser().getReleaseByTag({ ...REF, tag: 'v9' })).resolves.toBeUndefined();
  });

  it('只保留上传的附件，自动生成的源码包被排除', async () => {
    installFetch(() => jsonResponse(RAW_WITH_MIXED_ASSETS));
    const result = await makeReleaser().getReleaseByTag({ ...REF, tag: 'v1.0.0' });

    expect(result?.assets).toEqual([
      {
        id: '77',
        name: 'artifact.zip',
        downloadUrl: 'https://gitcode.com/acme/widget/releases/download/v1.0.0/artifact.zip',
      },
    ]);
  });

  it('文档未给出顶层 id 时用 tag 作为标识符', async () => {
    installFetch(() => jsonResponse(RAW_WITH_MIXED_ASSETS));
    const result = await makeReleaser().getReleaseByTag({ ...REF, tag: 'v1.0.0' });
    expect(result?.id).toBe('v1.0.0');
    expect(result?.htmlUrl).toBe('https://gitcode.com/acme/widget/releases/tag/v1.0.0');
  });

  it('release_status=pre 被视为预发布', async () => {
    installFetch(() =>
      jsonResponse({ ...RAW_WITH_MIXED_ASSETS, release_status: 'pre', prerelease: undefined }),
    );
    const result = await makeReleaser().getReleaseByTag({ ...REF, tag: 'v1.0.0' });
    expect(result?.prerelease).toBe(true);
  });
});

describe('GitCodeReleaser 的 tag 寻址', () => {
  it('createRelease 用 JSON body 并带上 release_status', async () => {
    const requests = installFetch(() => jsonResponse(RAW_WITH_MIXED_ASSETS));
    await makeReleaser().createRelease({
      ...REF,
      tagName: 'v1.0.0',
      name: 'v1.0.0',
      body: 'notes',
      draft: true,
      prerelease: true,
      targetCommitish: 'main',
      makeLatest: undefined,
    });

    const req = requests[0];
    expect(req.method).toBe('POST');
    expect(pathOf(req.url)).toBe('/api/v5/repos/acme/widget/releases');
    const body = jsonBodyOf(req);
    expect(body.tag_name).toBe('v1.0.0');
    // 预发布映射到 release_status，且优先于 make_latest
    expect(body.release_status).toBe('pre');
    expect(body).not.toHaveProperty('draft');
  });

  it('updateRelease 走 /releases/{tag} 而不是数字 id', async () => {
    const requests = installFetch(() => jsonResponse(RAW_WITH_MIXED_ASSETS));
    await makeReleaser().updateRelease({
      ...REF,
      release,
      tagName: 'v1.0.0',
      name: '',
      body: 'new body',
      draft: undefined,
      prerelease: undefined,
      targetCommitish: undefined,
      makeLatest: undefined,
    });

    const req = requests[0];
    expect(req.method).toBe('PATCH');
    expect(pathOf(req.url)).toBe('/api/v5/repos/acme/widget/releases/v1.0.0');
    // 更新接口把 name/body 标为必填，缺失时要回传原值
    expect(jsonBodyOf(req).body).toBe('new body');
    expect(jsonBodyOf(req).name).toBe('v1.0.0');
  });

  it('deleteReleaseAsset 走 /releases/{tag}/attach_files/{id}', async () => {
    const requests = installFetch(() => emptyResponse());
    await makeReleaser().deleteReleaseAsset({ ...REF, release, assetId: '77' });
    expect(pathOf(requests[0].url)).toBe(
      '/api/v5/repos/acme/widget/releases/v1.0.0/attach_files/77',
    );
  });

  it('deleteRelease 明确报错，因为 GitCode 没有该接口', async () => {
    await expect(makeReleaser().deleteRelease({ ...REF, release })).rejects.toThrow(
      /does not expose an API to delete a release/,
    );
  });
});

describe('GitCodeReleaser.release_status 映射', () => {
  const create = async (overrides: Record<string, unknown>) => {
    const requests = installFetch(() => jsonResponse(RAW_WITH_MIXED_ASSETS));
    await makeReleaser().createRelease({
      ...REF,
      tagName: 'v1.0.0',
      name: 'v1.0.0',
      body: 'x',
      draft: undefined,
      prerelease: undefined,
      targetCommitish: undefined,
      makeLatest: undefined,
      ...overrides,
    } as never);
    return jsonBodyOf(requests[0]);
  };

  it('prerelease=false 映射为 latest', async () => {
    expect((await create({ prerelease: false })).release_status).toBe('latest');
  });

  it('make_latest=true 映射为 latest', async () => {
    expect((await create({ makeLatest: 'true' })).release_status).toBe('latest');
  });

  it('make_latest=false 无法表达，省略字段', async () => {
    expect(await create({ makeLatest: 'false' })).not.toHaveProperty('release_status');
  });

  it('什么都没指定时省略字段，由平台自行决定', async () => {
    expect(await create({})).not.toHaveProperty('release_status');
  });
});

describe('GitCodeReleaser 两步上传', () => {
  it('先取 upload_url 再 PUT，且 PUT 不带平台 token', async () => {
    const uploaded = {
      id: 88,
      name: 'artifact.zip',
      browser_download_url: 'https://gitcode.com/acme/widget/releases/download/v1.0.0/artifact.zip',
    };
    const requests = installFetch((req) => {
      if (req.url.includes('/upload_url')) {
        return jsonResponse({
          url: 'https://obs.example.com/bucket/artifact.zip',
          headers: {
            'x-obs-meta-project-id': 'pid',
            'x-obs-acl': 'private',
            'Content-Type': 'application/octet-stream',
          },
        });
      }
      if (req.url.startsWith('https://obs.example.com')) {
        return textOk();
      }
      return jsonResponse({ ...RAW_WITH_MIXED_ASSETS, assets: [uploaded] });
    });

    const asset = await makeReleaser().uploadReleaseAsset({ ...REF, release, path: artifactPath });

    const ticketReq = requests.find((r) => r.url.includes('/upload_url'))!;
    expect(ticketReq.method).toBe('GET');
    expect(queryParam(ticketReq.url, 'file_name')).toBe('artifact.zip');

    const putReq = requests.find((r) => r.url.startsWith('https://obs.example.com'))!;
    expect(putReq.method).toBe('PUT');
    // 预签名地址由对象存储校验签名，带上平台 token 反而会让签名对不上
    expect(putReq.headers['authorization']).toBeUndefined();
    expect(putReq.headers['x-obs-meta-project-id']).toBe('pid');
    expect(putReq.body).toBeInstanceOf(Blob);

    expect(asset.id).toBe('88');
  });

  it('预签名地址拒绝 PUT 时回退为 multipart POST', async () => {
    let putAttempted = false;
    const requests = installFetch((req) => {
      if (req.url.includes('/upload_url')) {
        return jsonResponse({ url: 'https://obs.example.com/bucket/artifact.zip', headers: {} });
      }
      if (req.url.startsWith('https://obs.example.com')) {
        if (req.method === 'PUT') {
          putAttempted = true;
          return jsonResponse({ message: 'Method Not Allowed' }, 405);
        }
        return textOk();
      }
      return jsonResponse({
        ...RAW_WITH_MIXED_ASSETS,
        assets: [{ id: 88, name: 'artifact.zip', browser_download_url: 'https://gitcode.com/dl' }],
      });
    });

    const asset = await makeReleaser().uploadReleaseAsset({ ...REF, release, path: artifactPath });

    expect(putAttempted).toBe(true);
    const postReq = requests.find(
      (r) => r.url.startsWith('https://obs.example.com') && r.method === 'POST',
    )!;
    expect(postReq.body).toBeInstanceOf(FormData);
    expect(asset.id).toBe('88');
  });
});

const textOk = (): Response => new Response('', { status: 200 });
