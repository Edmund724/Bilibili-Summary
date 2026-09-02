// extension/ai/explain.ts
// 选区「解释」的单次模型调用：拼提示词 + 发非流式请求，返回解释文本。
//
// 与概览生成（ai/analysis.js）的区别只在形态：解释是一问一答的短回复，不进
// Map-Reduce、不进会话存储、不落缓存，因此不走 port 流式链路，直接
// ai/completion.js 的非流式 chatCompletion（content 侧可直发，概览同理）。
//
// 上下文口径：以选中所在句为锚，取前后各 CONTEXT_WINDOW_SENTENCES 句字幕组成
// 窗口（带时间戳），并把选中句本身单独列出——模型据此判断选中的是个词、术语
// 还是一句观点，而不必回读整片字幕。整片字幕既贵又没必要（解释只需要局部语境）。

import { chatCompletion } from "./completion.js";
import { formatCompactTimestamp } from "../shared/string-utils.js";
import type { AiProvider, ChatMessage } from "./types.js";

interface ExplainSubtitleItem {
  from?: unknown;
  content?: unknown;
}

export interface ExplainSelectionInput {
  provider: AiProvider;
  videoTitle?: string;
  /** 用户实际选中的文本（词 / 短语 / 句子片段） */
  selection: string;
  /** 选中所在的整条字幕句 */
  line: string;
  /** 所在句起始秒 */
  from: number;
  /** 全片字幕体（只用于截取局部上下文窗口） */
  body?: ExplainSubtitleItem[];
  /** 所在句在 body 中的下标；缺省或越界时退化为「无上下文窗口」 */
  index?: number;
  signal?: AbortSignal | null;
}

// 上下文窗口半径（前后各取几句）。太小判不出指代，太大就只是在重复字幕。
const CONTEXT_WINDOW_SENTENCES = 2;
// 解释输出的 token 上限：口径是「最多三句话」，320 已够中文三句 + 少量英文术语，
// 压低上限同时也是给模型的长度信号（越长出得越慢）。
const EXPLAIN_MAX_TOKENS = 320;

const EXPLAIN_SYSTEM_PROMPT = [
  "你在解释 B 站视频字幕里被观众选中的内容。",
  "规则：",
  "- 不要思考过程、不要前言后语，直接给出解释本身",
  "- 最多 3 句话，尽量短",
  "- 选中的是词或术语：给简明定义，并说明它在本视频里具体指什么",
  "- 选中的是短语或整句：解释它在当前上下文中的含义与说话人想表达什么",
  "- 人名 / 机构 / 产品名：说明它是谁 / 什么，以及与本片主题的关系",
  "- 只依据给出的字幕上下文判断，上下文不足以确定时如实说明，不要臆造",
  "- 用与字幕一致的语言回答（中文字幕用中文）"
].join("\n");

/**
 * 以选中句为锚截取上下文窗口（前后各 N 句，带时间戳；跳过空句）。
 * index 缺失 / 越界 / body 为空时返回空串（调用方按「无上下文」渲染提示词）。
 */
export function buildExplainContext(
  body: ExplainSubtitleItem[] | undefined,
  index: number | undefined
): string {
  const list = Array.isArray(body) ? body : [];
  const anchor = Number(index);
  if (!list.length || !Number.isFinite(anchor) || anchor < 0 || anchor >= list.length) {
    return "";
  }
  const from = Math.max(0, Math.floor(anchor) - CONTEXT_WINDOW_SENTENCES);
  const to = Math.min(list.length - 1, Math.floor(anchor) + CONTEXT_WINDOW_SENTENCES);
  const withHours = list.some((item) => Number(item?.from) >= 3600);
  const lines: string[] = [];
  for (let i = from; i <= to; i += 1) {
    const item = list[i];
    const content = String(item?.content || "").trim();
    if (!content) {
      continue;
    }
    const mark = i === Math.floor(anchor) ? "→ " : "  ";
    lines.push(`${mark}[${formatCompactTimestamp(Number(item?.from) || 0, withHours)}] ${content}`);
  }
  return lines.join("\n");
}

/** 组装解释请求的消息（纯函数，便于单测）。 */
export function buildExplainMessages({
  videoTitle,
  selection,
  line,
  from,
  body,
  index
}: Omit<ExplainSelectionInput, "provider" | "signal">): ChatMessage[] {
  const stamp = formatCompactTimestamp(Number(from) || 0, Number(from) >= 3600);
  const context = buildExplainContext(body, index);
  const sections = [
    `视频标题：${String(videoTitle || "未知").trim() || "未知"}`,
    `选中内容：「${selection}」`,
    `所在字幕句（${stamp}）：「${line}」`,
    context ? `字幕上下文（→ 标记为所在句）：\n${context}` : "（无可用上下文）"
  ];
  return [
    { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
    { role: "user", content: `${sections.join("\n\n")}\n\n请解释选中内容。` }
  ];
}

/**
 * 发一次解释请求，返回模型给出的解释文本（已 trim）。
 * 思考档位显式钉死「关」：thinkingLevel:"off" + disableThinking:true——不跟随
 * 用户在对话 tab 选的档位，并在请求体里发 OpenAI 兼容族的显式关闭字段
 *（ai/completion.js 的 THINKING_DISABLE_FIELDS），服务端默认开思考的平台
 *（Qwen / DeepSeek / GLM / Kimi / GPT-5）也一并压住；「不要思考过程」的措辞
 * 留在系统提示词里做第二道闸。中止（signal）与网络/HTTP 失败按
 * ai/completion.js 的错误模型上抛，由调用方落 error 态展示；空回复按错误处理
 *（模型没给东西不算成功）。
 */
export async function explainSelection({
  provider,
  videoTitle,
  selection,
  line,
  from,
  body,
  index,
  signal
}: ExplainSelectionInput): Promise<string> {
  const messages = buildExplainMessages({ videoTitle, selection, line, from, body, index });
  const result = await chatCompletion({
    provider,
    messages,
    stream: false,
    thinkingLevel: "off",
    disableThinking: true,
    signal,
    maxTokens: EXPLAIN_MAX_TOKENS,
    retries: 1
  });
  const text = typeof result === "string" ? result.trim() : "";
  if (!text) {
    throw new Error("模型没有给出解释，请重试。");
  }
  return text;
}
