// 本文件移植自 softprops/action-gh-release（MIT 协议，见 LICENSE）。
// 这些工具函数是「与原 action 接口兼容」的契约所在，除非有明确理由，否则不要改动行为。
import { globSync } from 'glob';
import { statSync, readFileSync } from 'fs';
import { homedir } from 'os';
import * as pathLib from 'path';

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  if (error === null || error === undefined) {
    return 'Unknown error';
  }
  return String(error);
};

/** 去掉 GitHub 上传地址尾部的 RFC-6570 模板后缀，例如 `...{?name,label}`。 */
export const uploadUrl = (url: string): string => {
  const templateMarkerPos = url.indexOf('{');
  if (templateMarkerPos > -1) {
    return url.substring(0, templateMarkerPos);
  }
  return url;
};

/** 读取 `body_path` 指定的文件；读不到时回退到内联的 `body` 输入。 */
export const releaseBody = (config: {
  input_body_path?: string;
  input_body?: string;
}): string | undefined => {
  if (config.input_body_path) {
    try {
      const contents = readFileSync(config.input_body_path, 'utf8');
      return contents;
    } catch (err: any) {
      console.warn(
        `⚠️ Failed to read body_path "${config.input_body_path}" (${err?.code ?? 'ERR'}). Falling back to 'body' input.`,
      );
    }
  }
  return config.input_body;
};

/** 按逗号切分，但忽略花括号内部的逗号（glob 的 `{a,b}` 展开写法）。 */
const smartSplit = (input: string): string[] => {
  const result: string[] = [];
  let current = '';
  let braceDepth = 0;

  for (const ch of input) {
    if (ch === '{') {
      braceDepth++;
    }
    if (ch === '}') {
      braceDepth--;
    }
    if (ch === ',' && braceDepth === 0) {
      if (current.trim()) {
        result.push(current.trim());
      }
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    result.push(current.trim());
  }
  return result;
};

/** 解析 `files` 输入：支持换行分隔，也支持同一行内用逗号分隔多个 glob。 */
export const parseInputFiles = (files: string): string[] => {
  return files
    .split(/\r?\n/)
    .flatMap((line) => smartSplit(line))
    .filter((pat) => pat.trim() !== '');
};

export const normalizeGlobPattern = (
  pattern: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform === 'win32') {
    return pattern.replace(/\\/g, '/');
  }
  return pattern;
};

export const expandHomePattern = (pattern: string, homeDirectory: string = homedir()): string => {
  if (pattern === '~') {
    return homeDirectory;
  }
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) {
    return pathLib.join(homeDirectory, pattern.slice(2));
  }
  return pattern;
};

export const normalizeFilePattern = (
  pattern: string,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
): string => {
  return normalizeGlobPattern(expandHomePattern(pattern, homeDirectory), platform);
};

/** 把一组 glob 展开成实际存在的文件路径列表。 */
export const paths = (patterns: string[], cwd?: string): string[] => {
  return patterns.reduce((acc: string[], pattern: string): string[] => {
    const matches = globSync(normalizeFilePattern(pattern), { cwd, dot: true, absolute: false });
    const resolved = matches
      .map((p) => (cwd && !pathLib.isAbsolute(p) ? pathLib.join(cwd, p) : p))
      .filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });
    return acc.concat(resolved);
  }, []);
};

/** 找出一个文件都没匹配上的 glob，用于 `fail_on_unmatched_files` 的预检。 */
export const unmatchedPatterns = (patterns: string[], cwd?: string): string[] => {
  return patterns.reduce((acc: string[], pattern: string): string[] => {
    const matches = globSync(normalizeFilePattern(pattern), { cwd, dot: true, absolute: false });
    const files = matches.filter((p) => {
      try {
        const full = cwd && !pathLib.isAbsolute(p) ? pathLib.join(cwd, p) : p;
        return statSync(full).isFile();
      } catch {
        return false;
      }
    });
    return acc.concat(files.length == 0 ? [pattern] : []);
  }, []);
};

export const isTag = (ref: string): boolean => {
  return ref.startsWith('refs/tags/');
};

export const normalizeTagName = (tag: string | undefined): string | undefined => {
  if (!tag) {
    return tag;
  }
  return isTag(tag) ? tag.replace('refs/tags/', '') : tag;
};

/**
 * GitHub 会把上传文件名里的空格改写成点号。这里保留该规则是为了与上游行为一致——
 * 即便某些平台不会改名，这样也能保证 `overwrite_files` 的匹配逻辑在两边一样。
 */
export const alignAssetName = (assetName: string): string => {
  return assetName.replace(/ /g, '.');
};

/**
 * 判断某个已存在的附件是否就是待上传的同名文件。
 * GitHub 可能改写过文件名，所以原始名与改写后的名字都要能匹配上。
 */
export const assetMatchesName = (name: string, asset: { name: string }): boolean =>
  asset.name === name || asset.name === alignAssetName(name);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
