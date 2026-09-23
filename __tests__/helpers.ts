import { vi } from 'vitest';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (req: RecordedRequest) => Response | Promise<Response>;

const normalizeHeaders = (headers: unknown): Record<string, string> => {
  if (!headers || typeof headers !== 'object') {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    result[key.toLowerCase()] = String(value);
  }
  return result;
};

/**
 * 用桩替换全局 fetch，并记录下每一次请求，方便断言请求契约
 * （方法、路径、请求体字段）而不是只断言最终结果。
 */
export const installFetch = (responder: Responder): RecordedRequest[] => {
  const requests: RecordedRequest[] = [];
  const mock = vi.fn(async (input: unknown, init: Record<string, unknown> = {}) => {
    const url = typeof input === 'string' ? input : String((input as { url: string }).url);
    const req: RecordedRequest = {
      url,
      method: String(init.method ?? 'GET').toUpperCase(),
      headers: normalizeHeaders(init.headers),
      body: init.body,
    };
    requests.push(req);
    return responder(req);
  });
  vi.stubGlobal('fetch', mock);
  return requests;
};

export const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const textResponse = (body: string, status = 200): Response =>
  new Response(body, { status });

export const emptyResponse = (status = 204): Response => new Response(null, { status });

/** 只取 URL 的 path。查询参数单独用 `queryParam` 断言，避免路径断言被 access_token 干扰。 */
export const pathOf = (url: string): string => new URL(url).pathname;

export const queryParam = (url: string, name: string): string | null =>
  new URL(url).searchParams.get(name);

/** 解析 JSON 请求体；不是 JSON 时返回 undefined。 */
export const jsonBodyOf = (req: RecordedRequest): any => {
  if (typeof req.body !== 'string') {
    return undefined;
  }
  try {
    return JSON.parse(req.body);
  } catch {
    return undefined;
  }
};
