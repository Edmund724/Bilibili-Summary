// eval/lib/timing-fetch.ts
// 全局 fetch 计时包装：把 globalThis.fetch 换成转发包装器，记录每次请求的
// url / method / status / 往返耗时（到响应体读完）。status 在响应体真正读完
// 才稳定——用 response.clone() 把副本读到空来测"读完"时刻，返回给调用方的
// 仍是原 response。全部跑完后用还原函数恢复全局，保证脚本可重复运行。

export interface RequestTiming {
  requestIndex: number;
  url: string;
  method: string;
  status: number; // 响应状态码；网络错误时 -1
  durationMs: number; // 从发出请求到响应体读完
}

export function installTimingFetch(
  realFetch: typeof fetch,
  onRecord: (t: RequestTiming) => void
): () => void {
  const original = globalThis.fetch;
  let requestIndex = 0;

  const timedFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const index = requestIndex++;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const startedAt = Date.now();

    return realFetch(input, init).then(
      (response) => {
        // 克隆副本读到空测"响应体读完"，原 response 原样返回给调用方
        response
          .clone()
          .arrayBuffer()
          .then(
            () => {
              onRecord({
                requestIndex: index,
                url,
                method,
                status: response.status,
                durationMs: Date.now() - startedAt
              });
            },
            () => {
              // 副本读取失败不影响调用方，但耗时已过，按当前状态记录
              onRecord({
                requestIndex: index,
                url,
                method,
                status: response.status,
                durationMs: Date.now() - startedAt
              });
            }
          );
        return response;
      },
      (error) => {
        onRecord({
          requestIndex: index,
          url,
          method,
          status: -1,
          durationMs: Date.now() - startedAt
        });
        throw error;
      }
    );
  }) as typeof fetch;

  globalThis.fetch = timedFetch;

  return () => {
    globalThis.fetch = original;
  };
}
