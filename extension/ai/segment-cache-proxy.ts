// 段缓存消息代理（arch-review-2026-09/05）：段缓存宿主是 SW（storage 所在），
// offscreen 的 Map-Reduce / 追问链经 runtime 消息调用（SW 端 handler 见
// ./segment-cache-handler.js，键位装配在 SW 的 segment-cache 单源完成）。
// 本模块是 offscreen 侧唯一出站点；容错口径与直连 segment-cache 一致——
// 读失败/无回执按未命中（null / []），写失败以 { ok:false } 上浮，全程不抛。

import type { SegmentCacheMessage, SegmentCacheResponse } from "../shared/messaging-protocol.js";

export interface SegmentCacheOps {
  loadSummary(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown }): Promise<string | null>;
  saveSummary(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown; summary: string }): Promise<{ ok: boolean; error?: unknown }>;
  saveRaw(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown; segments: unknown[] }): Promise<{ ok: boolean; error?: unknown }>;
  loadStoredRaw(input: { context?: Record<string, unknown> }): Promise<unknown[]>;
}

async function segmentCacheRequest(
  op: SegmentCacheMessage["op"],
  payload: Omit<SegmentCacheMessage, "type" | "op">
): Promise<SegmentCacheResponse> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: "segment-cache", op, ...payload })) as
      | SegmentCacheResponse
      | undefined;
    return response || { ok: false, error: "段缓存消息无回执" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const segmentCacheProxy: SegmentCacheOps = {
  async loadSummary({ context, segmentIndex, budgetScale }) {
    const response = await segmentCacheRequest("load-summary", { context, segmentIndex, budgetScale });
    if (!response.ok) {
      return null;
    }
    return typeof response.summary === "string" ? response.summary : null;
  },
  async saveSummary({ context, segmentIndex, budgetScale, summary }) {
    const response = await segmentCacheRequest("save-summary", { context, segmentIndex, budgetScale, summary });
    return response.ok ? { ok: true } : { ok: false, error: response.error };
  },
  async saveRaw({ context, segmentIndex, budgetScale, segments }) {
    const response = await segmentCacheRequest("save-raw", { context, segmentIndex, budgetScale, segments });
    return response.ok ? { ok: true } : { ok: false, error: response.error };
  },
  async loadStoredRaw({ context }) {
    const response = await segmentCacheRequest("load-stored-raw", { context });
    if (!response.ok || !Array.isArray(response.storedSegments)) {
      return [];
    }
    return response.storedSegments;
  }
};
