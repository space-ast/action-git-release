import { Agent, setGlobalDispatcher } from 'undici';
import { sleep } from '../util';
import { PlatformError, redactUrl } from './errors';
import type { PlatformName } from './types';

/** 默认总尝试次数（首次 + 重试）。 */
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;

/** 普通 API 调用的单次尝试上限：只收发小体积 JSON，60 秒足够。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 上传附件的单次尝试上限。这个值必须按最坏情况倒推：
 * 从 GitHub runner 跨境传到 Gitee/GitCode 实测只有 20–90 KB/s，100MB 的附件理论上要跑一小时。
 * 放宽到 30 分钟能覆盖本项目 ~35MB 的产物（含两倍余量），再大就该考虑分卷了。
 */
export const UPLOAD_TIMEOUT_MS = 30 * 60_000;

/** 上传的重试次数。单次就要 30 分钟，次数再多只会让失败的 job 白等。 */
export const UPLOAD_MAX_ATTEMPTS = 2;

/**
 * Node 内置的 fetch 是 undici 实现的，它带两条默认 300 秒的计时器：`headersTimeout`（等响应头）
 * 与 `bodyTimeout`（等响应体分块）。实测这条计时**从请求发出就开始跑，不等 body 发完**，
 * 所以跨境上传几十 MB 的产物必定撞线被掐断——34MB 的包连传三次、每次都在 301 秒整失败。
 *
 * 改它们只能走全局 dispatcher：per-request 的 `dispatcher` 传 Node 内置 fetch 会抛
 * `UND_ERR_INVALID_ARG`（npm 版 undici 与内置版不是同一份实现）。这里把上限放宽到比任何
 * 单次请求都大，真正的超时控制交给每个请求自己的 `AbortSignal.timeout`，报错也更清楚。
 */
setGlobalDispatcher(
  new Agent({
    headersTimeout: UPLOAD_TIMEOUT_MS + 60_000,
    bodyTimeout: UPLOAD_TIMEOUT_MS + 60_000,
    connectTimeout: 30_000,
    // 默认 4 秒的 keep-alive 会让进程多挂 4 秒才退出，action 里没必要。
    keepAliveTimeout: 1000,
  }),
);

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
  /** 单次尝试的墙钟上限，默认 60 秒；上传附件要显式放宽。 */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** `AbortSignal.timeout` 抛出的错误只有光秃秃一个 `TimeoutError`，补上「等了多久」才好排查。 */
const describeFetchError = (error: unknown, timeoutMs: number): string =>
  error instanceof Error && error.name === 'TimeoutError'
    ? `timed out after ${Math.round(timeoutMs / 1000)}s`
    : String(error);

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
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = `${req.platform} API ${req.method} ${redactUrl(req.url)}`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: await resolveBody(req.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: unknown) {
      lastError = error;
      const reason = describeFetchError(error, timeoutMs);
      if (attempt === maxAttempts) {
        throw new PlatformError({
          platform: req.platform,
          method: req.method,
          url: req.url,
          message: `${label} failed after ${attempt} attempt(s): ${reason}`,
          cause: error,
        });
      }
      console.warn(`⚠️ ${label} failed (${reason}), retrying…`);
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
