// 段缓存 SW 端消息 handler（arch-review-2026-09/05）：storage 真实宿主是 SW，
// offscreen（Map-Reduce / 追问链）的段缓存读写经 runtime 消息落到此处，
// 直调 ./segment-cache.js 单源——键位装配（segmentCacheKeyFields → 族键）也在
// SW 完成，offscreen 侧不 import segment-cache（ladder chunk 不含 cache-lru）。
// handler 工厂形态照 core/provider-handlers.ts 的 withOkResponse 先例。

import { withOkResponse } from "../core/provider-handlers.js";
import {
  getSegmentSummaryKey,
  getRawSegmentKey,
  loadSegmentSummary,
  saveSegmentSummary,
  saveRawSegments,
  loadStoredRawSegments,
  segmentCacheKeyFields
} from "./segment-cache.js";
import type { SegmentCacheMessage, SendResponse } from "../shared/messaging-protocol.js";

export function createSegmentCacheHandler(): (
  message: SegmentCacheMessage,
  sender: unknown,
  sendResponse: SendResponse
) => boolean {
  return function handleSegmentCache(
    message: SegmentCacheMessage,
    _sender: unknown,
    sendResponse: SendResponse
  ): boolean {
    withOkResponse(
      (async () => {
        const fields = segmentCacheKeyFields(message.context || {});
        if (message.op === "load-summary" || message.op === "save-summary") {
          const key = getSegmentSummaryKey({
            ...fields,
            segmentIndex: message.segmentIndex,
            budgetScale: message.budgetScale
          });
          if (message.op === "load-summary") {
            return { ok: true, summary: await loadSegmentSummary(key) };
          }
          const result = await saveSegmentSummary(key, String(message.summary ?? ""));
          return result.ok ? { ok: true } : { ok: false, error: String(result.error || "段缓存小结写入失败") };
        }
        if (message.op === "save-raw") {
          const key = getRawSegmentKey({
            ...fields,
            segmentIndex: message.segmentIndex,
            budgetScale: message.budgetScale
          });
          const result = await saveRawSegments(key, Array.isArray(message.segments) ? message.segments : []);
          return result.ok ? { ok: true } : { ok: false, error: String(result.error || "段缓存原始段写入失败") };
        }
        if (message.op === "load-stored-raw") {
          // String 归一与迁移前 followup-router 调用点的口径逐字一致
          const stored = await loadStoredRawSegments({
            bvid: String(fields.bvid || ""),
            cid: String(fields.cid || ""),
            subtitleId: String(fields.subtitleId || ""),
            subtitleUrl: String(fields.subtitleUrl || ""),
            lang: String(fields.lang || "")
          });
          return { ok: true, storedSegments: stored };
        }
        throw new Error("不支持的段缓存操作：" + String((message as { op?: unknown }).op));
      })(),
      sendResponse
    );
    return true;
  };
}
