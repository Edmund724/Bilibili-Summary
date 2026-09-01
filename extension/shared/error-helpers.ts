import { state } from "../core/state.js";
import { sleep } from "./utils.js";
import { logInfo } from "./logging.js";

// Loose shape shared by the custom error objects this module creates/consumes.
// Kept internal; callers pass `unknown` and we cast only when reading optional
// diagnostic fields.
interface BocErrorLike {
  code?: unknown;
  retryable?: boolean;
  status?: unknown;
  message?: unknown;
  aborted?: boolean;
}

export function toReadableText(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "[object Object]") {
      return fallback;
    }
    return text;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json && json !== "{}") {
      return json;
    }
  } catch {
    // ignore
  }
  const text = String(value);
  if (!text || text === "[object Object]") {
    return fallback;
  }
  return text;
}

export function getErrorMessage(error: unknown, fallback = "未知错误"): string {
  const err = error as BocErrorLike;
  const code = toReadableText(err?.code, "");
  const message = toReadableText(err?.message, "");
  if (message) {
    return code ? `${message} (code: ${code})` : message;
  }
  if (code) {
    return `code: ${code}`;
  }
  return toReadableText(error, fallback);
}

export function ensureRunActive(runId: string | number): void {
  if (runId !== state.clip.fetchRunId) {
    const error = new Error("Stale refresh run") as Error & { code: string };
    error.code = "STALE_RUN";
    throw error;
  }
}

export function isStaleRunError(error: unknown): boolean {
  return (error as BocErrorLike)?.code === "STALE_RUN";
}

export function isRetryableNetworkError(error: unknown): boolean {
  // 显式 HTTP 状态码优先判定（err.status 为正数才视为真实状态码）：408（请求
  // 超时）/ 429（限流）/ >=500（服务端错误）可重试；其余 4xx（400/401/403/404…）
  // 是确定性失败，原样重发只会再次失败，不重试。status<=0 不是有效 HTTP 状态码
  // （ASR 适配器用 -1 表示响应体解析失败等自造哨兵）；无 status 的错误（如
  // bilibili 网关只把状态码写进消息文本）维持下方消息启发式不变。
  const err = error as BocErrorLike;
  const status = Number(err?.status);
  if (Number.isFinite(status) && status > 0) {
    return status === 408 || status === 429 || status >= 500;
  }

  const message = getErrorMessage(error, "").toLowerCase();
  if (!message) {
    return false;
  }

  if (message.includes("http ")) {
    return true;
  }

  return (
    message.includes("请求失败") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("networkerror") ||
    message.includes("net::") ||
    message.includes("background fetch failed") ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

export async function retryAsync<T>(task: () => Promise<T>, retries = 1, delayMs = 180): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const err = error as BocErrorLike;
      const isNetworkError = isRetryableNetworkError(error);
      const isRetryable = err?.retryable === true;
      if (!isNetworkError && !isRetryable) {
        throw error;
      }
      if (attempt >= retries) {
        throw error;
      }
      const backoffDelay = Math.min(delayMs * Math.pow(2, attempt - 1), 5000);
      logInfo(`[BOC] retrying after ${backoffDelay}ms, attempt ${attempt + 1}/${retries}`, {
        error: getErrorMessage(error),
        code: err?.code
      });
      await sleep(backoffDelay);
    }
  }
  throw lastError || new Error("Unknown retry error");
}

// 限时竞速：ms 内 promise 完成则透传其结果/异常；到点未完成时，传了
// timeoutError（Error）则以它拒绝（硬超时），否则以 undefined 兑现（软超时，
// 由调用方自行回退）。
// 定时器走全局 setTimeout 而非 window.setTimeout：本模块同时被 SW
//（ai/context-resolver.js）与页面/offscreen context 消费，MV3 service worker
// 全局无 window（回归测试 tests/shared/with-timeout.test.js 钉 node 环境）。
export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError?: null): Promise<T | undefined>;
export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: Error): Promise<T>;
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutError: Error | null = null
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<T | undefined>((resolve, reject) => {
    timer = setTimeout(() => {
      if (timeoutError) {
        reject(timeoutError);
      } else {
        resolve(undefined);
      }
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// 中止标记错误工厂：AI 编排（map-reduce / merge / pool）统一用 e.aborted === true 收束
// 中止，避免各处手工 `new Error + err.aborted = true` 的重复形状。
export function makeAbortedError(message = "已停止生成"): Error & { aborted: true } {
  const err = new Error(message) as Error & { aborted?: boolean };
  err.aborted = true;
  return err as Error & { aborted: true };
}

export function isExtensionContextInvalidated(error: unknown): boolean {
  const msg = String((error as BocErrorLike)?.message || "");
  return msg.includes("Extension context invalidated");
}
