// ai/completion.ts — OpenAI 兼容 /chat/completions 的纯协议接缝（候选 03）。
// 请求构造（baseUrl 归一 / Bearer 头 / 思考档位：low·high 发 reasoning_effort、
// off 发显式关思考字段族 / max_tokens 探针）、
// SSE 解析、context-length 溢出判定、参数化重试策略，全部收口于此；
// 三份历史实现（client 流式 port 回吐 / map-reduce 非流式 / provider 探针）
// 统一经此调用，未来接入新 provider 家族（Gemini/Ollama）时在此加适配器插点。
// 纯协议层约束：不 import port/DOM/offscreen 任何东西——流式增量经 onEvent
// 回调吐出，port 回吐留在调用方适配器；完成值与错误走返回/throw。
//
// 错误模型（house style 类型化标记，唯一写点在本文件）：
// - context-length 溢出 → makeOverflowError（err.overflow = true，不重试）
// - 中止 → makeAbortedError（err.aborted = true，不重试）
// - 网络/HTTP 失败 → err.status（HTTP 状态）/ err.cause（原始抛出物）
//   结构化字段，err.retryable 与 isRetryableNetworkError 语义一致；
//   重试触发条件与旧 client 现状一致：fetch 抛错与非溢出 !response.ok
//   （及流式读流中断）都重试，与状态码无关。
import { parseSsePayload } from "./sse-parser.js";
import { makeAbortedError, isRetryableNetworkError } from "../shared/error-helpers.js";
import type { ChatMessage, StreamChatEvent } from "./types.js";

// OpenAI 兼容协议 chat 路径。
// 覆盖 OpenAI / DeepSeek / Qwen / Zhipu / Kimi / MiniMax / Mimo / Opencode Go / OpenRouter / Stepfun / Ollama（OpenAI 兼容模式）等。
// （原 client.js 的 OPENAI_COMPAT 常量收口于此；listModels 死字段不再保留。）
export const OPENAI_CHAT_PATH = "/chat/completions";

// 思考档位：low / high 映射到 OpenAI 兼容的 reasoning_effort；off = 显式关思考
// （见 THINKING_DISABLE_FIELDS，不再是「什么都不发」）。
const AI_THINKING_LEVELS = ["off", "low", "high"];

// 「关闭思考」的显式字段（OpenAI 兼容族里两家各认一种，一次全发，不认的一方按
// 未知参数忽略）：
//   thinking: {type:"disabled"}   —— DeepSeek / GLM / Kimi / MiniMax / 豆包的混合思考开关
//   enable_thinking: false        —— Qwen（DashScope 兼容模式）/ vLLM / SiliconFlow 系
// 写点唯一：档位 off 时由 buildChatRequestBody 注入，覆盖对话 tab（含 offscreen
// 流式链路）、概览生成、选区解释与连通性探针——用户在对话 tab 选 Off 或调用方
// 省略档位，都落到这里。若某平台对未知参数严格报错（表现为 HTTP 400），删掉对应
// 一条即可，各调用方无需改动。（不用 reasoning_effort:"none"：那是 GPT-5 专属，
// 不接受该值的模型会直接 400。）
const THINKING_DISABLE_FIELDS = {
  thinking: { type: "disabled" },
  enable_thinking: false
};

export function normalizeThinkingLevel(value: unknown): string {
  return AI_THINKING_LEVELS.includes(String(value)) ? String(value) : "off";
}

interface BuildChatRequestBodyInput {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  thinkingLevel?: string;
  maxTokens?: number | null;
}

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  reasoning_effort?: string;
  max_tokens?: number;
  thinking?: { type: string };
  enable_thinking?: boolean;
}

/**
 * 构造 chat/completions 请求体（纯函数，便于单测；请求构造单点）。
 * stream 显式传递（流式 true / 非流式 false）；maxTokens 供探针传 1。
 * 档位 off（含省略/非法回落到 off）→ 注入 THINKING_DISABLE_FIELDS 显式关思考；
 * 档位 low/high → 只发 reasoning_effort，不混入关闭字段。
 */
export function buildChatRequestBody({ model, messages, stream = false, thinkingLevel, maxTokens }: BuildChatRequestBodyInput): ChatRequestBody {
  const body: ChatRequestBody = { model, messages, stream };
  const level = normalizeThinkingLevel(thinkingLevel);
  if (level === "off") {
    Object.assign(body, THINKING_DISABLE_FIELDS);
  } else {
    body.reasoning_effort = level;
  }
  if (maxTokens != null) {
    body.max_tokens = maxTokens;
  }
  return body;
}

interface OverflowError extends Error {
  overflow: true;
}

/**
 * 溢出错误工厂：err.overflow = true 的唯一写点。
 * message 沿用触发场景的原始文案（HTTP 详情 / 预算回落提示），供日志排查；
 * 消费方按 err.overflow 标记分流（ladder 转 Map-Reduce 或报错），不读 message。
 */
export function makeOverflowError(message = "上下文超出模型限制"): OverflowError {
  const error = new Error(message) as OverflowError;
  error.overflow = true;
  return error;
}

/**
 * 判定一段错误文案是否属于 context-length 溢出（纯函数，自 client.js 迁入）。
 * 粗判：命中常见溢出子串，或「长度/上下文/令牌」语义 + 「超限」语义同时出现。
 * 非溢出错误（401/404/500/网络错误/限流等）返回 false，仍走既有重试/报错路径。
 */
export function isContextLengthOverflow(detailOrError: unknown): boolean {
  const text = String(detailOrError ?? "").toLowerCase();
  if (!text) return false;

  const directPatterns = [
    "context_length",
    "context length",
    "maximum context length",
    "max context length",
    "context window",
    "too many tokens",
    "too long",
    "too large",
    "max_tokens",
    "max tokens",
    "token limit",
    "最大上下文",
    "上下文长度",
    "上下文超出",
    "超出上下文",
    "超出长度",
    "超过上下文",
    "令牌超限",
    "token超限",
    "超出上限"
  ];

  for (const pattern of directPatterns) {
    if (text.includes(pattern)) return true;
  }

  const subjectPattern = /(context|tokens?|length|上下文|长度|令牌|窗口)/;
  const overflowPattern = /(exceed|limit|maximum|too many|too long|overflow|超出|超过|超限|上限|最大)/;
  return subjectPattern.test(text) && overflowPattern.test(text);
}

interface HttpError extends Error {
  status: number;
  retryable: boolean;
}

// HTTP 非 2xx 错误：文案与 formatProbeHttpError 同型（detail 截前 200 字符），
// 附 status 结构化字段与 retryable 语义（408/429/≥500 可重试）。
function makeHttpError(status: number, detail: string): HttpError {
  const error = new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`) as HttpError;
  error.status = status;
  error.retryable = isRetryableNetworkError(error);
  return error;
}

interface NetworkError extends Error {
  cause: unknown;
  retryable: boolean;
}

// 网络层（fetch 抛错）错误：文案对齐旧实现的「网络错误：」前缀；
// 原始抛出物挂 cause（探针适配层据此拼「无法连接：…」），retryable 语义同上。
function makeNetworkError(cause: unknown): NetworkError {
  const causeLike = cause as { message?: unknown } | undefined;
  const error = new Error(`网络错误：${causeLike?.message || cause}`) as NetworkError;
  error.cause = cause;
  error.retryable = isRetryableNetworkError(error);
  return error;
}

// 重试默认策略：流式 2 次（保持旧 client MAX_STREAM_RETRIES=2 现状）；
// 非流式/探针 0（map-reduce 与探针现状无重试；是否给归并链路开重试是后续独立决定）。
function defaultRetries(stream: boolean): number {
  return stream ? 2 : 0;
}

interface DrainSseStreamInput {
  response: Response;
  signal?: AbortSignal | null;
  onEvent?: (event: StreamChatEvent) => void;
}

/**
 * 读取并解析单个 SSE 响应，逐事件经 onEvent 吐出（不依赖 port/DOM）。
 * 手动 buffer 按行切、data: 前缀、[DONE] 跳过；解析出的事件（reasoning/content）
 * 归一为 { type: "token" | "reasoning", data }（port 协议词表，适配层可直透）。
 * 中止时抛 makeAbortedError，由调用方统一收束。
 */
async function drainSseStream({ response, signal, onEvent }: DrainSseStreamInput): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) {
      throw makeAbortedError();
    }

    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.length ? lines.pop()! : "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      const events = parseSsePayload(data);
      for (const event of events) {
        onEvent?.({
          type: event.type === "reasoning" ? "reasoning" : "token",
          data: event.data
        });
      }
    }
  }
}

interface RetryPayload {
  attempt: number;
  maxRetries: number;
  kind: "fetch" | "http" | "stream";
  error: Error;
}

interface ChatCompletionInput {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  messages: ChatMessage[];
  stream?: boolean;
  signal?: AbortSignal | null;
  thinkingLevel?: string;
  retries?: number;
  probe?: boolean;
  maxTokens?: number | null;
  headers?: Record<string, string>;
  onEvent?: (event: StreamChatEvent) => void;
  onRetry?: (payload: RetryPayload) => void;
  onStreamReset?: () => void;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * /chat/completions 单一入口（流式与非流式合一，probe 为探针特化）。
 * 参数：
 * - provider: { baseUrl, apiKey, model }；baseUrl 去尾斜杠、Bearer 仅当 apiKey。
 * - messages: OpenAI 消息数组（组装留在调用方）。
 * - stream: 流式增量经 onEvent 吐出，成功返回 { done: true }；
 *   非流式成功返回 choices[0].message.content（非字符串回落空串）。
 * - probe: 探针模式——body 强制 max_tokens（默认 1），成功判定 = response.ok
 *   且不读响应体（某些兼容网关在 max_tokens:1 下返回非 JSON 体，不视为失败）。
 * - retries: 重试次数，默认流式 2 / 非流式 0；退避线性 retryDelayMs × attempt。
 *   溢出/中止不重试；重试前的用户可见提示经 onRetry({ attempt, maxRetries, kind, error })，
 *   kind: "fetch"（网络抛错）| "http"（非溢出 !response.ok）| "stream"（读流中断）。
 * - onStreamReset: 流式专用——读流中断（kind=stream）重试时，在新流任何事件吐出
 *   前调用一次。重试从头生成、已吐事件无法撤回且新流不保证前缀一致，渲染层
 *   收到该信号应清空本条消息的流式缓冲整体重放（避免两代流拼接成重复文本）。
 *   fetch/http 阶段的失败未吐过任何事件，不触发。
 * - headers: 额外请求头（探针的 Accept 等）；Content-Type 固定 JSON，
 *   Authorization 已存在时不重复注入。
 * - thinkingLevel / maxTokens / signal / fetchImpl（默认 globalThis.fetch）；
 *   档位 off（或省略）= 显式关思考，见 THINKING_DISABLE_FIELDS。
 * 错误模型见文件头注释。
 */
export async function chatCompletion({
  provider,
  messages,
  stream = false,
  signal,
  thinkingLevel,
  retries,
  probe = false,
  maxTokens,
  headers: extraHeaders,
  onEvent,
  onRetry,
  onStreamReset,
  retryDelayMs = 800,
  fetchImpl = globalThis.fetch
}: ChatCompletionInput): Promise<string | { done: true }> {
  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("baseUrl 未配置");
  }
  const model = provider?.model;
  if (!model) {
    throw new Error("模型未配置");
  }

  const maxRetries = retries ?? defaultRetries(stream);

  const headers: Record<string, string> = { ...extraHeaders, "Content-Type": "application/json" };
  if (provider.apiKey && !headers.Authorization) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  const body = buildChatRequestBody({
    model,
    messages,
    stream,
    thinkingLevel,
    maxTokens: probe ? (maxTokens ?? 1) : maxTokens
  });

  // 上一次失败（kind + 错误）：attempt > 0 时经 onRetry 上报后再退避重试。
  let lastFailure: { kind: "fetch" | "http" | "stream"; error: Error } | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (lastFailure) {
      onRetry?.({ attempt, maxRetries, kind: lastFailure.kind, error: lastFailure.error });
      // 读流中断后的重试流从头生成：在新流任何事件吐出前发代际重置信号，
      // 渲染层据此清空缓冲整体重放（fetch/http 失败未吐过事件，无需重置）。
      if (stream && lastFailure.kind === "stream") {
        onStreamReset?.();
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      lastFailure = null;
    }

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${OPENAI_CHAT_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal
      });
    } catch (e) {
      // 中止（真实 signal 中止 / 注入实现抛出的中止标记 / AbortError）统一收束。
      if (signal?.aborted || (e as { aborted?: boolean })?.aborted || (e as { name?: string }).name === "AbortError") {
        throw makeAbortedError();
      }
      const error = makeNetworkError(e);
      if (attempt >= maxRetries) {
        throw error;
      }
      lastFailure = { kind: "fetch", error };
      continue;
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 200);
      } catch {}
      if (isContextLengthOverflow(detail)) {
        // context-length 溢出：不重试，带 overflow 标记抛出供调用方分流。
        throw makeOverflowError(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const error = makeHttpError(response.status, detail);
      if (attempt >= maxRetries) {
        throw error;
      }
      lastFailure = { kind: "http", error };
      continue;
    }

    // 探针成功判定 = response.ok，不读响应体（对齐旧 probeAiChatCompletion）。
    if (probe) {
      return "";
    }

    if (stream) {
      try {
        await drainSseStream({ response, signal, onEvent });
      } catch (e) {
        if ((e as { aborted?: boolean })?.aborted || signal?.aborted) {
          throw makeAbortedError();
        }
        const error = e instanceof Error ? e : new Error(String((e as { message?: unknown })?.message ?? e));
        if (attempt >= maxRetries) {
          throw error;
        }
        lastFailure = { kind: "stream", error };
        continue;
      }
      return { done: true };
    }

    let json = null;
    try {
      json = await response.json();
    } catch (e) {
      throw new Error(`响应解析失败：${(e as { message?: unknown })?.message || e}`);
    }
    const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }
  // 循环内最后一次失败必 throw，此处不可达；防御性兜底满足控制流分析。
  throw lastFailure?.error || new Error("chatCompletion 未能完成");
}
