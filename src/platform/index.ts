import type { Config } from '../config';
import { GiteeReleaser } from './gitee';
import { GitCodeReleaser } from './gitcode';
import { GitHubReleaser } from './github';
import type { Releaser } from './types';

/**
 * 按配置创建对应平台的 Releaser。
 * 新增平台只需在这里加一个分支，并实现 `Releaser` 接口。
 */
export const createReleaser = (config: Config): Releaser => {
  switch (config.platform) {
    case 'gitee':
      return new GiteeReleaser(config.api_base, config.web_base, config.token);
    case 'gitcode':
      return new GitCodeReleaser(config.api_base, config.web_base, config.token);
    case 'github':
      return new GitHubReleaser(config.api_base, config.web_base, config.token);
    default: {
      const exhaustive: never = config.platform;
      throw new Error(`⚠️ Unsupported platform: ${String(exhaustive)}`);
    }
  }
};

export type { Releaser } from './types';
export * from './types';
