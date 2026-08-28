import { state } from "../core/state.js";

export function toReadableText(value, fallback = "") {
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

export function getErrorMessage(error, fallback = "未知错误") {
  const code = toReadableText(error?.code, "");
  const message = toReadableText(error?.message, "");
  if (message) {
    return code ? `${message} (code: ${code})` : message;
  }
  if (code) {
    return `code: ${code}`;
  }
  return toReadableText(error, fallback);
}

export function ensureRunActive(runId) {
  if (runId !== state.clip.fetchRunId) {
    const error = new Error("Stale refresh run");
    error.code = "STALE_RUN";
    throw error;
  }
}

export function isStaleRunError(error) {
  return error?.code === "STALE_RUN";
}

export function isRetryableNetworkError(error) {
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

// 中止标记错误工厂：AI 编排（map-reduce / merge / pool）统一用 e.aborted === true 收束
// 中止，避免各处手工 `new Error + err.aborted = true` 的重复形状。
export function makeAbortedError(message = "已停止生成") {
  const err = new Error(message);
  err.aborted = true;
  return err;
}
