// client.js — 预算内单次总结的流式 port 适配器（候选 03 后）。
// 职责只剩两块：① 预算策略（resolveSubtitleForContext 判定发送物与超预算回落，
// 「预算判定属策略、溢出检测属协议」——协议细节在 ai/completion.js 接缝）；
// ② port 回吐适配（把 chatCompletion 的 onEvent/onRetry/完成值/类型化错误
// 映射回 offscreen port 协议：token/reasoning/notice/done/stopped/error）。
// 请求构造、SSE 解析、溢出判定、重试策略全部下沉到 ai/completion.js。

import { buildMessages, clipSubtitleForContext } from "./context.js";
import { buildBudgetPlan, estimateTokens, MATERIAL_BUDGET_CHARS } from "./budgeter.js";
import { buildSubtitlePrompt } from "./subtitle-prompt.js";
import { chatCompletion, makeOverflowError } from "./completion.js";

// 超预算回落时的提示文案：如实描述——本次单次调用不发，ladder 收到
// overflow 标记错误后立即转 Map-Reduce 分段整理（对用户表现为进度逐段推进）。
export const OVER_BUDGET_NOTICE = "字幕过长，已切换为分段整理模式";

/**
 * 决定给模型的字幕：素材预算内（≤100k token）整篇原样；超预算回落 50k 硬截断并打标记。
 * 纯函数，streamChat 只负责消费返回的 { markdown, mode, notice, overflowMarked }。
 * 预算输入与发送物同源：发送物由 subtitle-prompt 的 buildSubtitlePrompt 从
 * subtitleBody 现场渲染（追问压缩路径则直接用 compressedSummaryMarkdown 文本产物）；
 * body 缺失/空时退化为对实际发送物（空渲染或压缩摘要）的 estimateTokens 判定。
 */
export function resolveSubtitleForContext(context) {
  const ctx = context || {};
  const body = Array.isArray(ctx.subtitleBody) ? ctx.subtitleBody : [];
  // 追问压缩路径：压缩摘要本身就是最终发送物，预算按其实际长度估 token。
  const markdown = String(ctx.compressedSummaryMarkdown || "")
    || buildSubtitlePrompt({
      body,
      chapters: ctx.chapters,
      videoDuration: ctx.videoDuration,
      includeTimestampInBody: ctx.includeTimestampInBody
    });

  let mode;
  if (body.length > 0) {
    mode = buildBudgetPlan({ body, chapters: ctx.chapters }).mode;
  } else {
    // body 缺失/空：对实际发送物估 token（空渲染 ≈ 0 → single；压缩摘要按其长度判定）。
    mode = estimateTokens(markdown) > MATERIAL_BUDGET_CHARS ? "map-reduce" : "single";
  }

  if (mode === "single") {
    return { markdown, mode, notice: "", overflowMarked: false };
  }

  return {
    markdown: clipSubtitleForContext(markdown),
    mode,
    notice: OVER_BUDGET_NOTICE,
    overflowMarked: true
  };
}

/**
 * 流式 port 适配器：对外签名不变（ladder 消费点最小改动），内部经
 * ai/completion.js 接缝发请求。port 协议不变：
 * - 流式事件（token/reasoning）原样回吐，每个事件重挂空闲超时（onActivity）；
 * - 读流中断重试：新流事件前回吐一条 stream-reset（代际重置信号，渲染层
 *   清空本条消息缓冲整体重放，避免两代流拼接成重复文本）；
 * - 重试提示经 notice（读流中断重试保持旧现状：不打扰用户）；
 * - 成功回吐 done；中止回吐 stopped；其余失败回吐 error；
 * - 仅 context-length 溢出（含预算内超限）以带 .overflow 标记的错误上抛，
 *   供 ladder「catch 查标记」分流（单次转 Map-Reduce / 追问报错）。
 */
export async function streamChat({ provider, context, userPrompt, history, port, signal, onActivity, thinkingLevel }) {
  if (!port) return;

  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    port.postMessage({ type: "error", error: "baseUrl 未配置" });
    return;
  }
  if (!provider.model) {
    port.postMessage({ type: "error", error: "模型未配置" });
    return;
  }

  const subtitleResolution = resolveSubtitleForContext(context);
  if (subtitleResolution.notice) {
    port.postMessage({ type: "notice", data: subtitleResolution.notice });
  }
  if (subtitleResolution.overflowMarked) {
    // 超预算：仍先提示，再以 overflow 标记错误上抛供 ladder 转 Map-Reduce。
    throw makeOverflowError(OVER_BUDGET_NOTICE);
  }

  const messages = buildMessages({
    // buildMessages 与 resolveSubtitleForContext 从同一份 subtitleBody /
    // compressedSummaryMarkdown 渲染，无需再注入任何渲染产物字段。
    context,
    userPrompt,
    history,
    systemPrompt: context?.aiSystemPrompt
  });

  try {
    await chatCompletion({
      provider,
      messages,
      stream: true,
      signal,
      thinkingLevel,
      onEvent: (event) => {
        // 流式活动：重挂空闲超时 + port 回吐（事件对象与 port 消息同型，直接透传）。
        onActivity?.();
        port.postMessage(event);
      },
      onStreamReset: () => {
        // 读流中断重试：通知渲染层清空本条消息缓冲，从头接收重试流。
        onActivity?.();
        port.postMessage({ type: "stream-reset" });
      },
      onRetry: ({ attempt, maxRetries, kind, error }) => {
        if (kind === "stream") {
          // 读流中断重试保持旧现状：不额外打扰用户。
          return;
        }
        port.postMessage({
          type: "notice",
          data: kind === "http"
            ? `${error.message}，正在重试...`
            : `连接中断，正在重新连接（${attempt}/${maxRetries}）...`
        });
      }
    });
  } catch (e) {
    if (e?.overflow) {
      // 溢出上抛：ladder 据标记分流（单次转 Map-Reduce / 追问报错），不经 port error。
      throw e;
    }
    if (e?.aborted || signal?.aborted) {
      // 中止收束：对齐旧 streamChat 的停止 UX，不串错误。
      port.postMessage({ type: "stopped", reason: "已停止生成" });
      return;
    }
    port.postMessage({ type: "error", error: String(e?.message ?? e) });
    return;
  }

  port.postMessage({ type: "done" });
  return { done: true };
}
