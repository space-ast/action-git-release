import { sleep } from '../util';
import { PlatformError, redactUrl } from './errors';
import type { PlatformName } from './types';

/** 默认总尝试次数（首次 + 重试）。 */
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;

/**
 * FormData 和 Blob 这类 body 会被 `fetch` 消费掉，重试时必须重新构造。
 * 因此 provider 传进来的是一个工厂函数，它基于已读入内存的 Blob 现场重建 body。
 */
export type BodySource = BodyInit | (() => BodyInit | Promise<BodyInit>) | null | undefined;

export interface HttpRequest {
  method: string;
  url: string;
  platform: PlatformName;
  headers?: Record<string, string>;
  body?: BodySource;
  /** 这些状态码不抛错，原样返回给调用方（例如查 release 时的 404）。 */
  allowStatuses?: number[];
  /** 设为 1 可关闭重试，用于重复执行可能造成副作用的调用。 */
  maxAttempts?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** 解析 `Retry-After`，它可能是秒数，也可能是 HTTP 日期格式。 */
const retryAfterMs = (headers: Headers): number | undefined => {
  const raw = headers.get('retry-after');
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(raw);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, date - Date.now());
};

/** 指数退避，附加一点随机抖动以避免多个矩阵任务同时重试。 */
const backoffMs = (attempt: number): number =>
  Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS) + Math.floor(Math.random() * 250);

const resolveBody = async (body: BodySource): Promise<BodyInit | undefined> => {
  if (body === null || body === undefined) {
    return undefined;
  }
  return typeof body === 'function' ? await body() : body;
};

const truncate = (text: string, limit = 2000): string =>
  text.length > limit ? `${text.slice(0, limit)}… (truncated)` : text;

/**
 * 发起一次平台 API 调用，对网络异常、429 与 5xx 做有限次重试。
 * `allowStatuses` 中列出的状态码会原样返回；其余非 2xx 一律抛出带响应体的 `PlatformError`。
 */
export async function request(req: HttpRequest): Promise<HttpResponse> {
  const maxAttempts = Math.max(1, req.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const label = `${req.platform} API ${req.method} ${redactUrl(req.url)}`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: await resolveBody(req.body),
      });
    } catch (error: unknown) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw new PlatformError({
          platform: req.platform,
          method: req.method,
          url: req.url,
          message: `${label} failed after ${attempt} attempt(s): ${String(error)}`,
          cause: error,
        });
      }
      console.warn(`⚠️ ${label} failed (${String(error)}), retrying…`);
      await sleep(backoffMs(attempt));
      continue;
    }

    const text = await response.text();

    if (response.ok || req.allowStatuses?.includes(response.status)) {
      return { status: response.status, headers: response.headers, text };
    }

    if (isRetryableStatus(response.status) && attempt < maxAttempts) {
      const delay = retryAfterMs(response.headers) ?? backoffMs(attempt);
      console.warn(
        `⚠️ ${label} returned ${response.status}, retrying in ${delay}ms… (${attempt}/${maxAttempts})`,
      );
      await sleep(delay);
      continue;
    }

    throw new PlatformError({
      platform: req.platform,
      method: req.method,
      url: req.url,
      status: response.status,
      responseBody: truncate(text),
    });
  }

  // 理论上不可达：循环要么 return，要么在最后一次尝试时 throw。
  throw new PlatformError({
    platform: req.platform,
    method: req.method,
    url: req.url,
    message: `${label} failed: ${String(lastError)}`,
    cause: lastError,
  });
}

/**
 * 与 `request` 相同，但把响应体解析成 JSON。
 *
 * 命中 `allowStatuses` 的非成功状态一律返回 undefined——这类状态表示「查无此物」，
 * 其响应体通常是错误描述，绝不能被当成有效数据返回给调用方。
 * 响应体为空时同样返回 undefined。
 */
export async function requestJson<T>(req: HttpRequest): Promise<T> {
  const { status, text } = await request(req);
  if (status < 200 || status >= 300) {
    return undefined as T;
  }
  if (!text.trim()) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error: unknown) {
    throw new PlatformError({
      platform: req.platform,
      method: req.method,
      url: req.url,
      message: `${req.platform} API ${req.method} ${redactUrl(req.url)} returned a non-JSON body: ${truncate(text)}`,
      cause: error,
    });
  }
}

/** 拼接查询串，跳过 undefined 与空值，且不会留下多余的 `?`。 */
export const withQuery = (
  url: string,
  params: Record<string, string | number | undefined>,
): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
};
