import { describe, expect, it } from 'vitest';
import { parseConfig, resolvePlatform } from '../src/config';

const baseEnv = {
  INPUT_TOKEN: 'tok',
  INPUT_REPOSITORY: 'acme/widget',
} as Record<string, string | undefined>;

describe('resolvePlatform', () => {
  it('显式 platform 输入优先级最高', () => {
    expect(
      resolvePlatform(
        { INPUT_PLATFORM: 'gitee', GITHUB_ACTIONS: 'true', GITEE_TOKEN: 'x' },
        undefined,
      ),
    ).toBe('gitee');
  });

  it('拒绝非法的 platform 值', () => {
    expect(() => resolvePlatform({ INPUT_PLATFORM: 'gitlab' }, undefined)).toThrow(
      /Invalid 'platform' input/,
    );
  });

  it('api_url 中的主机名可推断平台', () => {
    expect(resolvePlatform({}, 'https://api.gitcode.com/api/v5')).toBe('gitcode');
    expect(resolvePlatform({}, 'https://gitee.com/api/v5')).toBe('gitee');
    expect(resolvePlatform({}, 'https://api.github.com')).toBe('github');
  });

  it('平台专属 token 环境变量可推断平台', () => {
    expect(resolvePlatform({ GITCODE_TOKEN: 'x' }, undefined)).toBe('gitcode');
    expect(resolvePlatform({ GITEE_ACCESS_TOKEN: 'x' }, undefined)).toBe('gitee');
  });

  it('gitcode 优先于 gitee（两者同时存在时）', () => {
    expect(resolvePlatform({ GITEE_TOKEN: 'a', GITCODE_TOKEN: 'b' }, undefined)).toBe('gitcode');
  });

  it('无任何信号时，GitHub Actions 环境回退到 github', () => {
    expect(resolvePlatform({ GITHUB_ACTIONS: 'true' }, undefined)).toBe('github');
  });

  it('完全无法判断时报错并给出可操作的提示', () => {
    expect(() => resolvePlatform({}, undefined)).toThrow(/Unable to determine the target platform/);
  });

  it('platform: auto 等同于未指定', () => {
    expect(
      resolvePlatform(
        { INPUT_PLATFORM: 'auto', GITHUB_ACTIONS: 'true', GITEE_TOKEN: 'x' },
        undefined,
      ),
    ).toBe('gitee');
  });
});

describe('parseConfig token 解析', () => {
  it('token 输入优先于环境变量', () => {
    const config = parseConfig({ ...baseEnv, INPUT_PLATFORM: 'gitee', GITEE_TOKEN: 'env-tok' });
    expect(config.token).toBe('tok');
  });

  it('token 为空时按平台回退到环境变量', () => {
    const config = parseConfig({
      INPUT_PLATFORM: 'gitee',
      INPUT_REPOSITORY: 'acme/widget',
      GITEE_TOKEN: 'gitee-env',
    });
    expect(config.token).toBe('gitee-env');
  });

  it('gitcode 回退到 GITCODE_TOKEN', () => {
    const config = parseConfig({
      INPUT_PLATFORM: 'gitcode',
      INPUT_REPOSITORY: 'acme/widget',
      GITCODE_TOKEN: 'gitcode-env',
    });
    expect(config.token).toBe('gitcode-env');
  });

  it('没有任何 token 时报错并列出可用的环境变量', () => {
    expect(() => parseConfig({ INPUT_PLATFORM: 'gitee', INPUT_REPOSITORY: 'acme/widget' })).toThrow(
      /No token available for platform "gitee".*GITEE_TOKEN/s,
    );
  });
});

describe('parseConfig repository 解析', () => {
  it('repository 输入优先', () => {
    const config = parseConfig({
      ...baseEnv,
      INPUT_PLATFORM: 'gitee',
      INPUT_REPOSITORY: 'mirror/widget',
      GITHUB_REPOSITORY: 'acme/widget',
    });
    expect(config.repository).toBe('mirror/widget');
  });

  it('其次回退到 GITHUB_REPOSITORY', () => {
    const config = parseConfig({
      INPUT_PLATFORM: 'gitee',
      INPUT_TOKEN: 't',
      GITHUB_REPOSITORY: 'acme/widget',
    });
    expect(config.repository).toBe('acme/widget');
  });

  it('最后回退到平台专属变量', () => {
    const config = parseConfig({
      INPUT_PLATFORM: 'gitee',
      INPUT_TOKEN: 't',
      GITEE_REPOSITORY: 'onsite/widget',
    });
    expect(config.repository).toBe('onsite/widget');
  });

  it('都没有时报错', () => {
    expect(() => parseConfig({ INPUT_PLATFORM: 'gitee', INPUT_TOKEN: 't' })).toThrow(
      /No repository specified/,
    );
  });
});

describe('parseConfig tag 解析', () => {
  it('tag_name 输入中的 refs/tags/ 前缀会被归一化', () => {
    const config = parseConfig({
      ...baseEnv,
      INPUT_PLATFORM: 'gitee',
      INPUT_TAG_NAME: 'refs/tags/v1.2.3',
    });
    expect(config.tag_name).toBe('v1.2.3');
  });

  it('从 GITHUB_REF 的 tag 引用中解析', () => {
    const config = parseConfig({
      ...baseEnv,
      INPUT_PLATFORM: 'gitee',
      GITHUB_REF: 'refs/tags/v2.0.0',
    });
    expect(config.tag_name).toBe('v2.0.0');
  });

  it('分支推送不会被误当成同名 tag', () => {
    const config = parseConfig({
      ...baseEnv,
      INPUT_PLATFORM: 'gitee',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      GITHUB_REF_TYPE: 'branch',
    });
    expect(config.tag_name).toBeUndefined();
  });

  it('GITHUB_REF_TYPE=tag 时认 GITHUB_REF_NAME', () => {
    const config = parseConfig({
      ...baseEnv,
      INPUT_PLATFORM: 'gitee',
      GITHUB_REF: 'refs/tags/v3.0.0',
      GITHUB_REF_NAME: 'v3.0.0',
      GITHUB_REF_TYPE: 'tag',
    });
    expect(config.tag_name).toBe('v3.0.0');
  });
});

describe('parseConfig 其它输入', () => {
  it('api_base 去掉尾部斜杠', () => {
    const config = parseConfig({
      ...baseEnv,
      INPUT_PLATFORM: 'gitee',
      INPUT_API_URL: 'https://example.com/api/v5/',
    });
    expect(config.api_base).toBe('https://example.com/api/v5');
  });

  it('未指定 api_url 时用平台默认值', () => {
    expect(parseConfig({ ...baseEnv, INPUT_PLATFORM: 'gitcode' }).api_base).toBe(
      'https://api.gitcode.com/api/v5',
    );
    expect(parseConfig({ ...baseEnv, INPUT_PLATFORM: 'gitee' }).api_base).toBe(
      'https://gitee.com/api/v5',
    );
  });

  it('overwrite_files 只有显式为 false 才是否定', () => {
    expect(
      parseConfig({ ...baseEnv, INPUT_PLATFORM: 'gitee', INPUT_OVERWRITE_FILES: 'false' })
        .input_overwrite_files,
    ).toBe(false);
    expect(
      parseConfig({ ...baseEnv, INPUT_PLATFORM: 'gitee', INPUT_OVERWRITE_FILES: 'true' })
        .input_overwrite_files,
    ).toBe(true);
    expect(
      parseConfig({ ...baseEnv, INPUT_PLATFORM: 'gitee' }).input_overwrite_files,
    ).toBeUndefined();
  });

  it('make_latest 只接受三个合法值', () => {
    expect(
      parseConfig({ ...baseEnv, INPUT_PLATFORM: 'gitee', INPUT_MAKE_LATEST: 'legacy' })
        .input_make_latest,
    ).toBe('legacy');
    expect(
      parseConfig({ ...baseEnv, INPUT_PLATFORM: 'gitee', INPUT_MAKE_LATEST: 'yes' })
        .input_make_latest,
    ).toBeUndefined();
  });

  it('files 支持换行与逗号分隔，且保留 glob 花括号内的逗号', () => {
    const config = parseConfig({
      ...baseEnv,
      INPUT_PLATFORM: 'gitee',
      INPUT_FILES: 'dist/*.zip, dist/*.tar.gz\n{a,b}.txt',
    });
    expect(config.input_files).toEqual(['dist/*.zip', 'dist/*.tar.gz', '{a,b}.txt']);
  });
});
