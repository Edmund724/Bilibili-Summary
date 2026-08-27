// extension/asr/adapters/stepfun-sse.js
// 阶跃 StepAudio SSE 流式转写适配器：POST {baseUrl}/v1/audio/asr/sse，
// 请求体为嵌套 JSON（audio.data = base64 音频），响应为 SSE 流逐条聚合
// 文本增量直到 done 事件。
//
// ===== 接口事实（据官方文档与实现调研，未真机实测） =====
//
// 事件 JSON 字段与结束条件（据阶跃开放平台文档"语音识别（流式返回文本）"
// https://platform.stepfun.com/docs/zh/api-reference/audio/asr-sse ）：
//   - transcript.text.delta：增量文本。字段 type / delta（本次增量）/
//     item_id / content_index / start_time / end_time（毫秒）/
//     meta.timestamp。逐条把 delta 拼进文本，是流式展示用的渐进结果。
//   - transcript.text.done：完整结果。字段 type / text（权威全量文本）/
//     usage。**结束条件**：收到 done 后停止读取（官方技能 transcribe.py
//     与第三方实现均以 done.text 为最终文本，而非拼 delta）。
//   - error：识别过程出错。字段 type / message。流中可能出现（内容审查
//     等），要单独解析并报出 message，不能静默丢弃。
//   - SSE 行可能是 data: [DONE]（结束哨兵，官方 Python 技能把 [DONE] 当
//     可忽略行），也按结束处理。
//
// 请求体嵌套结构（据官方 API 文档 + 官方 stepfun-ai/StepAudio-Skills
// transcribe.py）：
//   { audio: { data: <base64>, input: { transcription: { model,
//     language, enable_itn }, format: { type: "wav", rate, bits,
//     channel } } } }
//
// 句级时间戳（据官方 API 文档）：transcription 配置里有
//   enable_timestamp: 是否返回识别文本对应的音频时间戳，默认 false。
// delta 事件本身带 start_time / end_time（毫秒，文本对应的音频区间）。
// 实现选择：发送 enable_timestamp: true 请求句级时间戳，done 事件的
// text 为权威文本；若响应事件里出现 start_time/end_time（毫秒）则映射为
// 片内相对秒的 segments 随结果返回，否则不返回 segments（由上层合成
// 整片粗粒度字幕）。——「官方文档确认接口支持时间戳参数」，
// 实际事件是否携带（尤其 done 事件）属 spec 基线假设、待实测确认。
//
// 关键坑（spec 4 / 6.6 / 技术备忘 8）：
//   - stepaudio-2.5-asr 不在 /v1/audio/transcriptions 上，错误端点会返回
//     "model stepaudio-2.5-asr not supported"（与权限被拒长得一样）→
//     提示"端点或模型名错误"。
//   - API Key 必须是 "Normal" 等级，"Plan" 类型 key 调音频端点会无声 4xx
//     （响应体为空）→ 提示检查 Key 等级。
//   - SSE 流中可能出现 error 事件（内容审查等），单独解析并报出 message。

import { bytesToBase64 } from "../asr-provider-store.js";
import { resolveStepfunSseUrl } from "../../core/shared-defaults.js";

export const ADAPTER_TYPE = "stepfun-sse";

// 每个 data: 行之间回调一次 onProgress（可选，上层用于流式进度展示）；
// 文案为当前已聚合文本长度，避免刷屏。
const PROGRESS_EVERY = 1;

// 构造阶跃 SSE 请求体（纯函数便于单测断言）。audioB64 为 WAV 的 base64。
export function buildStepfunRequestBody({ wavBytes, model, language }) {
  return {
    audio: {
      data: bytesToBase64(wavBytes),
      input: {
        transcription: {
          model: String(model || "").trim(),
          language: language || "zh",
          // 请求句级时间戳（官方文档：默认 false）。若服务端不支持/不返回，
          // 则按无时间戳处理（见 transcribe）。
          enable_timestamp: true,
          enable_itn: true
        },
        format: {
          // 管线统一输出 16k 单声道 16bit PCM WAV（chunker.js），故写死
          type: "wav",
          rate: 16000,
          bits: 16,
          channel: 1
        }
      }
    }
  };
}

// 解析一条 SSE data: 行（去掉前缀后的文本）。非 data: 行返回 null；
// 空 / "[DONE]" 返回 { done: true }；合法 JSON 返回 { event }；非法 JSON
// 返回 { done: false }（忽略该行）。
export function parseSseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") {
    return { done: true };
  }
  try {
    return { event: JSON.parse(payload) };
  } catch {
    return { done: false };
  }
}

// 把阶跃 delta/done 事件里的毫秒时间戳映射为 segments（片内相对秒）。
// 仅当事件带合法的 start_time / end_time（毫秒）才产出 segment；
// done 事件即使带 text 而无时间戳也返回空数组（由调用方合成整片粗粒度
// 字幕）。—— 事件是否实际携带时间戳待实测。
export function parseSegmentsFromEvent(event) {
  const out = [];
  if (!event || typeof event !== "object") {
    return out;
  }
  const text = String(event.text || event.delta || "").trim();
  if (!text) {
    return out;
  }
  const startMs = Number(event.start_time);
  const endMs = Number(event.end_time);
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    out.push({ start: startMs / 1000, end: endMs / 1000, text });
  }
  return out;
}

// 读取响应体并解析错误文案（口径与探针 probeStepfunSse 一致）：
//   - "not supported" → 端点或模型名错误；
//   - 402 / quota_exceeded → 计费通道引导（/v1 音频端点只吃按量余额，
//     文本可用 ≠ 音频可用；Step Plan Credit 需走 step_plan/v1 专属路径）；
//   - 响应体为空 → Key 等级引导（Normal / Plan）。
// 返回 { message } 供抛错透出。
export function describeHttpError(response, rawText) {
  const detail = String(rawText || "").slice(0, 500);
  if (detail.includes("not supported")) {
    return { message: `端点或模型名错误（HTTP ${response.status}）: ${detail}` };
  }
  if (response.status === 402 || detail.includes("quota_exceeded")) {
    return {
      message: `配额校验未通过（HTTP 402 quota_exceeded）。该端点按音频时长单独计费，与文本模型额度、Step Plan 订阅 Credit 不共享——请确认是普通按量 Key 且有按量余额；若是 Step Plan 订阅用户，可把 baseUrl 改为 https://api.stepfun.com/step_plan 走订阅专属端点。`
    };
  }
  if (!detail.trim()) {
    return {
      message: `连接失败（HTTP ${response.status}，无错误体）。请确认 API Key 为 Normal 等级——Plan 类型的 Key 调音频端点会无声 4xx。`
    };
  }
  return { message: `HTTP ${response.status}: ${detail}` };
}

// 统一入口。输入一片（或整段）WAV Blob，输出
//   { text, segments?: [{start, end, text}] }，start/end 为片内相对秒。
// segments 缺省表示无句级时间戳（由上层合成整片粗粒度字幕）。
// 错误：HTTP 错误 / 流中 error 事件 → 抛 Error，message 透出可读文案
// （网络错误/5xx 由调用方 retryAsync 重试）。AbortSignal 透传 fetch，
// reader 循环里 signal.aborted 提前退出。
export async function transcribe({ wavBlob, startSec, durationSec, provider, signal, onProgress }) {
  // wavBlob → bytes → base64（分段编码，避免 String.fromCharCode 栈溢出）
  const wavBytes = new Uint8Array(await wavBlob.arrayBuffer());
  const body = buildStepfunRequestBody({ wavBytes, model: provider?.model });

  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("平台 baseUrl 未配置");
  }
  const apiKey = String(provider?.apiKey || "").trim();
  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let response;
  try {
    // baseUrl 兼容完整端点 / step_plan 订阅根 / 站点根三种写法（见 shared-defaults.js）
    response = await fetch(resolveStepfunSseUrl(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    if (signal?.aborted) {
      const abortError = new Error("已停止生成");
      abortError.name = "AbortError";
      throw abortError;
    }
    throw error;
  }

  if (!response.ok) {
    // 非 2xx：读响应体（可能为空——Plan key 无声 4xx），按三类坑映射文案
    let rawText = "";
    try {
      rawText = await response.text();
    } catch {
      // 忽略响应体读取失败，按空处理
    }
    const { message } = describeHttpError(response, rawText);
    throw new Error(message);
  }

  if (!response.body?.getReader) {
    throw new Error("SSE 响应不支持流式读取（response.body 缺失）");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let textParts = [];
  let segments = [];
  let doneEvent = null;
  let dataLineCount = 0;
  // 流诊断：转写事件计数 + 首条数据行样本。零事件 EOF（端点/Key 类型不匹配
  // 等场景）曾表现为"静默聚合出空文本→误报没有人声"，这里把它变成显式报错。
  let transcriptEventCount = 0;
  let firstDataLineSample = "";

  try {
    readLoop: while (true) {
      if (signal?.aborted) {
        throw new DOMException("已停止生成", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // SSE 按行聚合：块可能截断在行中间，buffer 保留未处理尾段
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!firstDataLineSample && line.trim().startsWith("data:")) {
          firstDataLineSample = line.trim().slice(0, 200);
        }
        const parsed = parseSseLine(line);
        if (!parsed) {
          continue;
        }
        if (parsed.done) {
          // 结束哨兵：data: [DONE]（或空行），停止读取（与 EOF 同一收尾逻辑）
          reader.cancel?.().catch(() => {});
          break readLoop;
        }
        dataLineCount += 1;
        const event = parsed.event;
        if (!event || typeof event !== "object") {
          continue;
        }
        const eventType = String(event.type || "");
        if (eventType === "error") {
          // 流中错误事件（内容审查等），透出 message
          throw new Error(`语音识别失败：${String(event.message || "未知错误")}`);
        }
        if (eventType === "transcript.text.delta") {
          transcriptEventCount += 1;
          const delta = String(event.delta || "");
          if (delta) {
            textParts.push(delta);
          }
        } else if (eventType === "transcript.text.done") {
          transcriptEventCount += 1;
          doneEvent = event;
          const segs = parseSegmentsFromEvent(event);
          if (segs.length > 0) {
            segments = segs;
          }
        }
        if (dataLineCount % PROGRESS_EVERY === 0) {
          onProgress?.(`已识别 ${textParts.join("").length} 字…`);
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  // 零转写事件的流结束：不是"没有人声"，而是端点/鉴权/参数层面的异常
  if (transcriptEventCount === 0) {
    throw new Error(
      `阶跃流式响应未包含任何转写事件（收到 ${dataLineCount} 条数据行）。` +
        `请确认 baseUrl 端点与 API Key 类型匹配${firstDataLineSample ? `；首行样本: ${firstDataLineSample}` : ""}`
    );
  }

  // 流自然读完或遇哨兵：把聚合文本作为结果返回
  return buildResult({ textParts, segments, doneEvent });
}

// 归一化最终结果。优先级：done.text（权威全量文本）> 各 delta 拼接。
// segments 有内容才带（无句级时间戳时省略，由上层合成整片粗粒度字幕）。
export function buildResult({ textParts, segments, doneEvent }) {
  const doneText = String(doneEvent?.text || "").trim();
  const text = doneText || textParts.join("").trim();
  const hasSegments = Array.isArray(segments) && segments.length > 0;
  if (hasSegments) {
    return { text, segments };
  }
  return { text };
}
