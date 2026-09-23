import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, UPLOAD_TIMEOUT_MS } from '../src/platform/http';
import { installFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

const timeoutError = (): Error => {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
};

describe('请求超时', () => {
  // 单次尝试的墙钟上限由 AbortSignal.timeout 兜底。默认 60 秒只够发小体积 JSON，
  // 上传附件必须显式放宽——不然跨境传几十 MB 的产物必定被掐断。
  it('普通 API 调用默认 60 秒上限', async () => {
    installFetch(() => {
      throw timeoutError();
    });

    await expect(
      request({
        method: 'GET',
        url: 'https://gitee.com/api/v5/x',
        platform: 'gitee',
        maxAttempts: 1,
      }),
    ).rejects.toThrow(/timed out after 60s/);
  });

  it('上传会放宽到 UPLOAD_TIMEOUT_MS，报错里写明等了多久', async () => {
    installFetch(() => {
      throw timeoutError();
    });

    await expect(
      request({
        method: 'POST',
        url: 'https://gitee.com/api/v5/x/attach_files',
        platform: 'gitee',
        timeoutMs: UPLOAD_TIMEOUT_MS,
        maxAttempts: 1,
      }),
      // 断言跟着常量走：这个值按跨境实测反复调过（1800s → 3600s），写死就天天过期。
    ).rejects.toThrow(`timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`);
  });

  it('网络异常按原样带上，耗尽重试后如实抛错', async () => {
    let attempts = 0;
    installFetch(() => {
      attempts++;
      throw new TypeError('fetch failed');
    });

    await expect(
      request({
        method: 'GET',
        url: 'https://gitee.com/api/v5/x',
        platform: 'gitee',
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/failed after 2 attempt\(s\): TypeError: fetch failed/);
    expect(attempts).toBe(2);
  });

  // 跨境上传失败时，最外层永远只有一句 `TypeError: fetch failed`——只看这一层，分不清是
  // 「对端复位」「TLS 握手失败」还是别的什么。原因链和本次耗时必须一起带出来才有得排查。
  it('fetch 的 cause 链会整条展开，并补上本次尝试的耗时', async () => {
    installFetch(() => {
      const reset = Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
        errno: -4077,
        syscall: 'read',
      });
      throw new TypeError('fetch failed', { cause: reset });
    });

    await expect(
      request({
        method: 'POST',
        url: 'https://gitee.com/api/v5/x/attach_files',
        platform: 'gitee',
        maxAttempts: 1,
      }),
    ).rejects.toThrow(
      /failed after 1 attempt\(s\): TypeError: fetch failed ← Error: read ECONNRESET \[code=ECONNRESET errno=-4077 syscall=read\] \(waited \d+(\.\d+)?s\)/,
    );
  });

  // 上面几条用的是桩 fetch，桩会无条件抛错——就算 signal 压根没传给 fetch，它们也照样通过。
  // 这条真连一个「只收不回」的服务器，才能真正证明超时是接上了的。
  it('真实请求会在超时后中断，而不是一直挂着', async () => {
    const server = createServer(() => {
      // 收到请求但永不响应，模拟跨境上传时对端长时间不返回响应头
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const started = Date.now();
      await expect(
        request({
          method: 'POST',
          url: `http://127.0.0.1:${port}/attach_files`,
          platform: 'gitee',
          timeoutMs: 500,
          maxAttempts: 1,
        }),
      ).rejects.toThrow(/timed out after 1s/);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
