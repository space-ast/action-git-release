import type { PlatformName } from './types';

/**
 * 把 URL 里携带凭据的查询参数替换成 `***`，避免 token 泄漏到 CI 日志里。
 * 本 action 打印或写进错误的每一个 URL 都会先过这个函数。
 */
export const redactUrl = (url: string): string =>
  url.replace(/([?&](?:access_token|token|private_token|private-token)=)[^&#\s]*/gi, '$1***');

export class PlatformError extends Error {
  readonly platform: PlatformName;
  readonly method: string;
  readonly url: string;
  readonly status: number | undefined;
  readonly responseBody: string | undefined;

  constructor(options: {
    platform: PlatformName;
    method: string;
    url: string;
    status?: number;
    responseBody?: string;
    message?: string;
    cause?: unknown;
  }) {
    const redacted = redactUrl(options.url);
    const detail = options.responseBody ? `\n${options.responseBody}` : '';
    const statusPart = options.status ? ` returned ${options.status}` : ' failed';
    super(
      options.message ??
        `${options.platform} API ${options.method} ${redacted}${statusPart}${detail}`,
      { cause: options.cause },
    );
    this.name = 'PlatformError';
    this.platform = options.platform;
    this.method = options.method;
    this.url = redacted;
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}

/** 判断某个错误是否代表平台 API 返回了 404。 */
export const isNotFound = (error: unknown): boolean =>
  error instanceof PlatformError && error.status === 404;
