// extension/bilibili/gateway-core.ts
// gateway 传输叶（arch-slim-2/04 拆叶，ADR-0003「拆静态边」的正版执行）：
// isBiliUrl / bgFetchJson / JsonTransport 三成员自 bilibili/gateway.ts 原样迁出
// （实现逐字不动，仅归属变化）。
//
// 存在理由：MV3 service worker 只需要 isBiliUrl + bgFetchJson 两个零内部依赖的
// 函数，但 gateway.ts 静态 import state/video-probe/selection→cache→cache-lru
// （≈44KB raw）把字幕缓存机器整链拖进了 SW。本模块是叶子——不 import 任何
// extension/ 模块（URL/Headers/fetch 全是平台全局），叶子约束由
// tests/bilibili/gateway-core.test.js 源码扫描锁住，防缓存链经此回内联
// （scripts/build.js 的 BACKGROUND_JS_MAX_KB 守卫防的正是这条链）。
//
// 消费方：entry/background.ts（fetch-json 消息处理器）、ai/context-resolver.ts
// （无页面场景的传输层）、bilibili/gateway.ts（fetchJson 的 isBiliUrl 判定；
// 并 re-export 三成员保持既有 import 面兼容）。

export type JsonTransport = (url: string) => Promise<unknown>;

// True for B站 request hosts (API + subtitle/CDN) that need the B站 request headers
// and should be routed through the background fetch handler. Shared by the transports.
export function isBiliUrl(url: unknown): boolean {
  try {
    const parsed = new URL(String(url || ""));
    const host = parsed.hostname;
    return host === "api.bilibili.com" || host.endsWith(".hdslb.com");
  } catch {
    return false;
  }
}

// ===== transports =====

export async function bgFetchJson<T = unknown>(url: string): Promise<T> {
  const headers = new Headers();
  const isBiliRequest = isBiliUrl(url);
  if (isBiliRequest) {
    headers.set("Accept", "application/json, text/plain, */*");
    headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    headers.set("Cache-Control", "no-cache");
    headers.set("Pragma", "no-cache");
  }

  const options: RequestInit = {
    method: "GET",
    credentials: "include",
    cache: "no-store"
  };
  if ((headers as unknown as { size: number }).size > 0) {
    options.headers = headers;
  }
  if (isBiliRequest) {
    options.referrer = "https://www.bilibili.com/";
    options.referrerPolicy = "strict-origin-when-cross-origin";
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
