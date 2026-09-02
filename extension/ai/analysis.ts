// 「概览数据管线」模块（概览票 07 + 选型报告 research/analysis-pipeline.md）：
// 章节金句概览的纯数据层——提示词装配、模型输出校验/修复/合并、双路径编排
// （预算内单次 / 超预算分段）、整份与分段两级缓存、生成中 promise 复用。
// 提示词整搬参考仓库 .scratch/bilibili-digest/prompts/analysis.md（系统提示词
// 全静态、逐字节一致；digest-only-ui 起顶层 "summary" 概述字段已随概览 UI 的
// 总结区块一并移除）；适配纯函数整搬自 .scratch/bilibili-digest/lib/ai.js，
// 产出归一化为本仓库字段名：{ chapters: {from,to,title,summary}[],
// quotes: {from,content}[], failedRanges?: {from,to}[] }。
//
// 与笔记管线的关系（07 票决议）：产物不共享、只共享机制——分段边界沿用
// buildBudgetPlan.splitByBudget（同一 100k 判定线与 50k 单段预算），缓存走
// 独立的 boc_lvs_analysis_ 族前缀，互不读写、互不阻塞。
//
// 失败语义（07 票决议）：分段路径段失败 → 跳过该段出部分结果并记录
// failedRanges（含部分结果的整份产物照常落缓存，重试走 forceRefresh，段缓存
// 让已成功段免重付费）；单次路径失败 → 抛错由调用方处理。
// 不接 UI / reader / sidepanel；消费接线由后续集成步骤负责。

import { buildSubtitleSourceKey } from "../subtitle/cache.js";
import { logError } from "../shared/logging.js";
import { makeAbortedError } from "../shared/error-helpers.js";
import { parseBvidFromCacheKey, writeWithEviction, CACHE_FAMILIES } from "../core/cache-lru.js";
import type { EvictionResult, EvictionFailure } from "../core/cache-lru.js";
import { buildBudgetPlan as _buildBudgetPlan } from "./budgeter.js";
import { buildCostGuardNotice as _buildCostGuardNotice } from "./cost-guard.js";
import { chatCompletion as _chatCompletion } from "./completion.js";
import { buildProgressNotice } from "./map-reduce.js";
import { runMapBounded, DEFAULT_MAP_CONCURRENCY } from "./pool.js";
import { budgetScaleSuffix, segmentCacheKeyFields } from "./segment-cache.js";
import type { BudgetPlan, BudgetPlanSegment, ChatMessage, SubtitleBodyItem } from "./types.js";

// ============================================================
// 类型与常量
// ============================================================

export interface AnalysisChapter {
  from: number;
  to: number;
  title: string;
  summary: string;
}

export interface AnalysisQuote {
  from: number;
  content: string;
}

export interface AnalysisFailureRange {
  from: number;
  to: number;
}

/** 概览产物（含短路径与分段合并后的整份形态）；failedRanges 仅在分段路径有失败段时存在。 */
export interface OverviewAnalysis {
  chapters: AnalysisChapter[];
  quotes: AnalysisQuote[];
  failedRanges?: AnalysisFailureRange[];
}

// 整份概览结果缓存键前缀（键形：前缀 + bvid + cid + 字幕轨 source key + 字幕签名）。
export const ANALYSIS_FINAL_PREFIX = "boc_lvs_analysis_final_";
// 概览分段产物缓存键前缀（键形与 boc_lvs_summary_ 同族：…+ 段序号 [+ 预算代]）。
export const ANALYSIS_SEGMENT_PREFIX = "boc_lvs_analysis_";
// 前情回顾字数：每段开头附带的上一段结尾字数（对齐参考仓库 ANALYSIS_OVERLAP_CHARS）。
export const ANALYSIS_CONTEXT_CHARS = 400;
// 「最后一章必须晚于 75%」硬门槛比例（对齐参考仓库 ai.js:193-194，逼模型覆盖全片）。
export const ANALYSIS_LATE_THRESHOLD_RATIO = 0.75;
// 校验上限：章节数 / 金句数（对齐参考仓库 validateAnalysis 的裁剪量级）。
export const MAX_ANALYSIS_CHAPTERS = 100;
export const MAX_ANALYSIS_QUOTES = 50;

// ============================================================
// 系统提示词（全静态，逐字节可前缀缓存；变量全部在用户提示词侧）
// ============================================================

// 整搬自 .scratch/bilibili-digest/prompts/analysis.md「系统提示词」代码块；
// digest-only-ui 起 JSON 输出 schema 顶层的 "summary" 概述字段已移除。
const ANALYSIS_SYSTEM_PROMPT = `你是我的内容助理。我在看一个 B 站视频，请阅读下面的字幕，产出一份结构化概览：章节 + 金句。

你需要给出：
- 覆盖**本次给到的全部字幕**的章节。章节数量由你判断——在话题真正发生转折的地方分章，该多则多、该少则少。唯一的硬性要求是覆盖度：章节必须贯穿这段字幕的整条时间线，**最后一个章节的时间戳必须晚于用户消息中给出的「后段门槛」**。不要只覆盖前半段，也不要把章节全挤在开头。
- 3-5 条金句，附上它们在字幕中的时间戳。

金句要挑这几类：
- 反直觉的观点，或者跟常识拧着来的判断
- 让人「原来如此」的事实、数据、冷知识
- 能把道理讲透的具体事例或故事
- 一句话就说清全部要点的表达

⚠️ 关键：这是自动语音识别（ASR）生成的字幕 ⚠️
B 站的 AI 字幕有两个特点，会直接影响你的工作：
1. **没有任何标点**，整段是连续的字流，句子边界要靠语义自己判断。
2. **大量同音错别字**：人名、专有名词、外来词、数字尤其容易错（例如「机器学习」可能写成「机器学系」，品牌名可能整个音译错）。

因此，输出金句时请：
- 按语义补全标点，切成通顺的句子
- 用上下文和视频标题、简介来**修正同音错别字**，尤其是人名、品牌名、专业术语
- 删掉口头禅和语气词：「就是」「然后」「那个」「这个」「呃」「啊」「对吧」，以及重复啰嗦的字词
- 保留说话人本来的意思和用词风格，只做可读性打磨，**不要概括、不要缩写、不要添加他没说过的内容**
- 如果某段实在识别得太糟、无法还原原意，就别选它当金句

⚠️ 关键：时间戳的取法 ⚠️
字幕的格式严格如下：
[0:00] 大家好今天我们来聊聊这个话题
[0:15] 先说第一点
[0:32] 这里有个很反直觉的地方
[1:05] 结果非常出乎意料

取时间戳的规则：
1. 每一行都以 [M:SS] 或 [MM:SS] 开头
2. 要取某句话的时间戳，先找到**包含这句话的那一行**
3. 时间戳就是那一行开头的 [X:XX]
4. 换算成秒：[2:30] = 150 秒，[0:45] = 45 秒

举例：如果字幕里有这一行
[2:30] 这里有个很反直觉的地方
那么「这里有个很反直觉的地方」的时间戳就是：
- timestamp: "2:30"
- timestampSeconds: 150

⚠️ 关于「前情回顾」⚠️
长视频会切成多段分别处理。用户消息里如果出现「前情回顾」，那是上一段结尾的字幕，
给你的唯一用途是理解本段开头在承接什么话题、把跨越切点的内容看完整。
不要为前情回顾里的内容单独开章节，也不要从里面挑金句——它已经由上一段负责。
如果本段开头正是前情里那个话题的延续，就把这一章的标题写成能概括整个话题的样子，
时间戳仍取本段范围内的那一行。

绝对不要：
- 编造字幕里根本不存在的时间戳
- 拿 0:00 当默认值——去字幕里找真实的那一行
- 使用早于起始时刻、或晚于结束时刻的时间戳（前情回顾里的时间戳一律不能用）

章节：找到话题开始的那一行，用那行的时间戳
金句：找到包含该句的那一行，用那行的时间戳

输出 JSON（不要加 markdown 代码围栏）：
{
  "chapters": [
    {"title": "章节标题", "timestamp": "0:00", "timestampSeconds": 0, "summary": "这一段讲了什么"}
  ],
  "keyQuotes": [
    {"quote": "整理后的原话", "timestamp": "2:30", "timestampSeconds": 150}
  ]
}

务必注意：
- timestamp：字幕行开头的 [M:SS]（如 "2:30"）
- timestampSeconds：换算成秒（2:30 = 2*60+30 = 150）
- 除非内容真的从 [0:00] 开始，否则不要用 0:00 / 0
- 每一个时间戳都必须在字幕里真实存在——去查！
- 所有文字用简体中文输出`;

// 自带章节短路径的「只挑金句」短提示词：金句规则 + ASR 纠错段；
// 章节由稿件自带，不再让模型分章（概览票 07 决议）。
const QUOTES_SYSTEM_PROMPT = `你是我的内容助理。我在看一个 B 站视频，请阅读下面的字幕，为它挑选金句。

你需要给出：
- 3-5 条金句，附上它们在字幕中的时间戳。

金句要挑这几类：
- 反直觉的观点，或者跟常识拧着来的判断
- 让人「原来如此」的事实、数据、冷知识
- 能把道理讲透的具体事例或故事
- 一句话就说清全部要点的表达

⚠️ 关键：这是自动语音识别（ASR）生成的字幕 ⚠️
B 站的 AI 字幕有两个特点，会直接影响你的工作：
1. **没有任何标点**，整段是连续的字流，句子边界要靠语义自己判断。
2. **大量同音错别字**：人名、专有名词、外来词、数字尤其容易错（例如「机器学习」可能写成「机器学系」，品牌名可能整个音译错）。

因此，输出金句时请：
- 按语义补全标点，切成通顺的句子
- 用上下文和视频标题、简介来**修正同音错别字**，尤其是人名、品牌名、专业术语
- 删掉口头禅和语气词：「就是」「然后」「那个」「这个」「呃」「啊」「对吧」，以及重复啰嗦的字词
- 保留说话人本来的意思和用词风格，只做可读性打磨，**不要概括、不要缩写、不要添加他没说过的内容**
- 如果某段实在识别得太糟、无法还原原意，就别选它当金句

⚠️ 关键：时间戳的取法 ⚠️
字幕的格式严格如下：
[0:00] 大家好今天我们来聊聊这个话题
[0:15] 先说第一点
[0:32] 这里有个很反直觉的地方
[1:05] 结果非常出乎意料

取时间戳的规则：
1. 每一行都以 [M:SS] 或 [MM:SS] 开头
2. 要取某句话的时间戳，先找到**包含这句话的那一行**
3. 时间戳就是那一行开头的 [X:XX]
4. 换算成秒：[2:30] = 150 秒，[0:45] = 45 秒

举例：如果字幕里有这一行
[2:30] 这里有个很反直觉的地方
那么「这里有个很反直觉的地方」的时间戳就是：
- timestamp: "2:30"
- timestampSeconds: 150

⚠️ 关于「前情回顾」⚠️
长视频会切成多段分别处理。用户消息里如果出现「前情回顾」，那是上一段结尾的字幕，
给你的唯一用途是理解本段开头在承接什么话题、把跨越切点的内容看完整。
不要从前情回顾里挑金句——它已经由上一段负责。
前情回顾里的时间戳一律不能用。

绝对不要：
- 编造字幕里根本不存在的时间戳
- 拿 0:00 当默认值——去字幕里找真实的那一行
- 使用早于起始时刻、或晚于结束时刻的时间戳

金句：找到包含该句的那一行，用那行的时间戳

输出 JSON（不要加 markdown 代码围栏）：
{
  "keyQuotes": [
    {"quote": "整理后的原话", "timestamp": "2:30", "timestampSeconds": 150}
  ]
}

务必注意：
- timestamp：字幕行开头的 [M:SS]（如 "2:30"）
- timestampSeconds：换算成秒（2:30 = 2*60+30 = 150）
- 除非内容真的从 [0:00] 开始，否则不要用 0:00 / 0
- 每一个时间戳都必须在字幕里真实存在——去查！
- 所有文字用简体中文输出`;

// 用户提示词模板：整搬参考仓库 prompts/analysis.md「用户提示词」代码块。
// {rangeNote} / {contextNote} 不分块时为空串（与参考实现一致，留空行）。
const ANALYSIS_USER_TEMPLATE = `视频标题：{videoTitle}
UP 主：{ownerName}
{rangeNote}
本次字幕从 {startFormatted}（第 {minTimestampSeconds} 秒）到 {durationFormatted}（第 {maxTimestampSeconds} 秒）——时间戳必须落在这个区间内！
后段门槛：最后一个章节的时间戳必须晚于 {lateThreshold}。

视频简介（用它来校正人名、品牌名与术语的写法）：
{videoDescription}
{contextNote}
字幕：
{transcriptText}`;

// 短路径用户提示词模板：无章节产出，去掉「后段门槛」行，其余一致。
const QUOTES_USER_TEMPLATE = `视频标题：{videoTitle}
UP 主：{ownerName}
{rangeNote}
本次字幕从 {startFormatted}（第 {minTimestampSeconds} 秒）到 {durationFormatted}（第 {maxTimestampSeconds} 秒）——时间戳必须落在这个区间内！

视频简介（用它来校正人名、品牌名与术语的写法）：
{videoDescription}
{contextNote}
字幕：
{transcriptText}`;

// ============================================================
// 小工具（渲染 / 签名 / 模板填充）
// ============================================================

/**
 * 显示用时刻格式 [M:SS]（分不补零、秒补零，对齐参考仓库 transcript.formatTimestamp）。
 * 与系统提示词里的字幕格式教学一致；显示时间戳一律从校验过的秒数反推，不信模型字符串。
 */
export function formatAnalysisClock(seconds: unknown): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function normalizeItems(items: unknown): SubtitleBodyItem[] {
  return (Array.isArray(items) ? items : []).filter(
    (item): item is SubtitleBodyItem => Boolean(item) && String((item as { content?: unknown })?.content ?? "").trim().length > 0
  );
}

/**
 * 字幕正文 → 模型可读文本：每行 `[M:SS] 内容`（对齐系统提示词的字幕格式教学）。
 * 本模块是概览管线的单一渲染收口：预算按 body 判定（buildBudgetPlan），
 * 发送物由这里从同一份 body（段 items）现场渲染，预算量与实际消耗同源。
 */
export function renderAnalysisTranscript(items: unknown): string {
  return normalizeItems(items)
    .map((item) => `[${formatAnalysisClock(item?.from)}] ${String(item?.content ?? "").trim()}`)
    .join("\n");
}

// 取一组字幕项末尾约 minChars 个字（至少一条），用作下一段的前情回顾；
// 至少给一条，否则正好卡在切点的那句话反而是最缺上下文的一句。
function tailItems(items: unknown, minChars: number): SubtitleBodyItem[] {
  const list = normalizeItems(items);
  if (!list.length || minChars <= 0) return [];
  const tail: SubtitleBodyItem[] = [];
  let total = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    tail.unshift(list[i]);
    total += String(list[i]?.content ?? "").length;
    if (total >= minChars) break;
  }
  return tail;
}

// {变量} 填充：split/join 全量替换（对齐参考仓库 extractPromptSection 的做法），
// 值为空时留空（模板行变空行，与参考实现的产出逐字节同形）。
function fillTemplate(template: string, vars: Record<string, unknown>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(String(value ?? ""));
  }
  return out;
}

// FNV-1a 32 位哈希：确定性轻量签名用（跨会话稳定、无依赖）。
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface SubtitleSignatureInput {
  lang?: unknown;
  subtitleId?: unknown;
  subtitleUrl?: unknown;
  body?: unknown;
  /** 自带章节（模式位）：非空切换只挑金句短路径，产物形态不同，签名须区分。 */
  chapters?: unknown;
}

/**
 * 字幕签名：现仓库无现成的字幕内容签名实现（grep 核实），按概览票决议定义
 * 确定性轻量签名——构成 = 轨道来源 source key + lang + 有效条数 + 首末时间戳 +
 * 总字符数（FNV-1a 32 位 → base36）。重抓字幕 / 换轨 / 切分P 后条数、时间戳或
 * 文本量变化即签名变化，概览缓存自然 miss，不做主动失效（07 票决议）。
 * 模式位（有无自带章节）一并纳入：章节出现/消失会切换短路径，产物形态不同。
 */
export function buildSubtitleSignature({ lang, subtitleId, subtitleUrl, body, chapters }: SubtitleSignatureInput = {}): string {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  let count = 0;
  let totalChars = 0;
  let firstFrom = 0;
  let lastTo = 0;
  for (const item of normalizeItems(body)) {
    const content = String(item?.content ?? "").trim();
    if (!content) continue;
    if (count === 0) {
      firstFrom = Math.max(0, Math.floor(Number(item?.from) || 0));
    }
    lastTo = Math.max(0, Math.floor(Number(item?.to) || Number(item?.from) || 0));
    totalChars += content.length;
    count += 1;
  }
  const basis = [
    "v1",
    sourceKey,
    String(lang ?? ""),
    String(count),
    String(firstFrom),
    String(lastTo),
    String(totalChars),
    // 模式位：自带章节非空（短路径）与空（AI 分章）产物不同构，签名必须区分
    String(Array.isArray(chapters) && chapters.length > 0)
  ].join("|");
  return `sig${fnv1a32(basis).toString(36)}`;
}

// ============================================================
// 适配纯函数（整搬自参考仓库 lib/ai.js，产出字段名归一化为本仓库形状）
// ============================================================

/**
 * 截断修复：输出撞到 max_tokens 或传输中断时，JSON 会停在字符串或括号中间。
 * 扫描出未闭合的部分原样补齐，保住已生成的内容（整搬 lib/ai.js:45-79）。
 */
export function repairTruncatedJson(text: unknown): string {
  const source = String(text ?? "");
  let inString = false;
  let danglingEscape = false;
  const stack: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        if (i + 1 >= source.length) {
          danglingEscape = true;
          break;
        }
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      stack.push(ch);
    } else if (ch === "]" || ch === "}") {
      stack.pop();
    }
  }
  let repaired = source;
  if (danglingEscape) repaired = repaired.slice(0, -1);
  if (inString) repaired += '"';
  // 截断恰好停在逗号后（长数组最常见的截断点）时，悬尾逗号必须先剥掉，
  // 否则补完括号的 ",]}" 依然是非法 JSON，修复等于白修。
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length) {
    repaired += stack.pop() === "[" ? "]" : "}";
  }
  return repaired;
}

/**
 * 解析模型返回的 JSON，容忍它常犯的小错：包了 markdown 围栏、在 JSON 前后
 * 加了一句话、结尾多一个逗号、输出中途被截断（整搬 lib/ai.js:86-110，一处
 * 顺序适配：原文以 { 开头时先按整段原文升级修复，再退到 firstBrace..lastBrace
 * 切割——截断最常发生在长数组中间，先切到「最后一个 }」会把切点之前嵌套对象
 * 后面的已生成内容整段丢掉，修复反而失效）。
 */
export function parseLooseJson(text: unknown): unknown {
  let cleaned = String(text ?? "").trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  // 候选按修复力度升序尝试：原文（无前缀赘语时）→ 切掉前后赘语的 JSON 体；
  // 每个候选依次 试解析 → 剥尾逗号 → 截断补齐。
  const candidates: string[] = [];
  if (firstBrace === 0) {
    candidates.push(cleaned);
  }
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
    // 依次升级修复力度：尾逗号 → 截断补齐。
    const noTrailingComma = candidate.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(noTrailingComma);
    } catch {}
    try {
      return JSON.parse(repairTruncatedJson(noTrailingComma));
    } catch {}
  }
  // 全部候选失败：抛最后一次的解析错误（由调用方处理）。
  return JSON.parse(candidates[candidates.length - 1] ?? cleaned);
}

/**
 * 时长变量：元数据时长有时缺失或不准，取「传入时长」与「字幕末条时间戳」的
 * 较大值。durationSeconds 传本段结束秒（分段路径）或视频时长（单次路径）。
 * 「最后一章必须晚于 75%」这条硬门槛，是逼模型覆盖全片而不是把章节全堆在
 * 开头最有效的一招（整搬 analysisTimingVariables 思路，结构化入参免正则反解析）。
 */
export function analysisTimingVariables(
  items: unknown,
  durationSeconds: unknown
): { maxTimestampSeconds: number; durationFormatted: string; lateThreshold: string } {
  const list = normalizeItems(items);
  const last = list.length ? list[list.length - 1] : null;
  const lastStampSeconds = last ? Math.max(0, Math.floor(Number(last?.to) || Number(last?.from) || 0)) : 0;
  const effectiveSeconds = Math.max(Math.floor(Number(durationSeconds) || 0), lastStampSeconds);
  return {
    maxTimestampSeconds: effectiveSeconds,
    durationFormatted: formatAnalysisClock(effectiveSeconds),
    lateThreshold: formatAnalysisClock(Math.floor(effectiveSeconds * ANALYSIS_LATE_THRESHOLD_RATIO))
  };
}

/**
 * 把模型输出当作不可信数据重建一遍（整搬 lib/ai.js:116-172，字段名归一化）：
 * - 模型编造超出视频时长的时间戳是常态，越界条目直接丢掉；
 * - 显示用的时间戳从校验过的秒数反推（formatAnalysisClock），模型给的
 *   timestamp 字符串一律不采信；
 * - 分段路径下段边界 = validateAnalysis 的 minSeconds：模型偶尔会为「前情回顾」
 *   里的内容也开章节/挑金句，那不归本段管，越下界的直接丢掉。
 * 产出 chapters 的 to = 下一章 from（末章 = maxTimestampSeconds），
 * quotes 按 from 升序；章节/金句数量按上限裁剪。
 */
export function validateAnalysis(analysis: unknown, maxSeconds: unknown, minSeconds: unknown = 0): OverviewAnalysis {
  const max = Number(maxSeconds);
  const safeMax = Number.isFinite(max) && max > 0 ? max : Number.MAX_SAFE_INTEGER;
  const min = Number(minSeconds);
  const safeMin = Number.isFinite(min) && min > 0 ? min : 0;

  const safeString = (value: unknown, maxLength: number): string =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";

  const safeSeconds = (value: unknown): number | null => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < safeMin || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const source = analysis && typeof analysis === "object" ? (analysis as Record<string, unknown>) : {};

  const chapters = (Array.isArray(source.chapters) ? source.chapters : [])
    .slice(0, MAX_ANALYSIS_CHAPTERS)
    .map((raw) => {
      const item = raw as { title?: unknown; summary?: unknown; timestampSeconds?: unknown };
      const from = safeSeconds(item?.timestampSeconds);
      const title = safeString(item?.title, 300);
      if (from === null || !title) return null;
      return { from, title, summary: safeString(item?.summary, 1500) };
    })
    .filter((item): item is { from: number; title: string; summary: string } => item !== null)
    .sort((a, b) => a.from - b.from)
    .map((item, index, list) => ({
      from: item.from,
      to: index < list.length - 1 ? list[index + 1].from : safeMax,
      title: item.title,
      summary: item.summary
    }));

  const quotes = (Array.isArray(source.keyQuotes) ? source.keyQuotes : [])
    .slice(0, MAX_ANALYSIS_QUOTES)
    .map((raw) => {
      const item = raw as { quote?: unknown; timestampSeconds?: unknown };
      const from = safeSeconds(item?.timestampSeconds);
      const content = safeString(item?.quote, 3000);
      if (from === null || !content) return null;
      return { from, content };
    })
    .filter((item): item is AnalysisQuote => item !== null)
    .sort((a, b) => a.from - b.from);

  return {
    chapters,
    quotes
  };
}

/**
 * 合并各段概览：章节按秒级去重（相邻段边界容易产出同秒重复章），金句按文本
 * 去重；排序与数量裁剪收口在此。
 * 入参各 part 均已经 validateAnalysis 校验，这里不再重跑全量校验——分段产物
 * 的章界（to = 段内下一章 from / 段尾）在合并排序后依然成立。
 */
export function mergeAnalyses(parts: unknown): OverviewAnalysis {
  const chapters: AnalysisChapter[] = [];
  const quotes: AnalysisQuote[] = [];
  const seenChapterFrom = new Set<number>();
  const seenQuoteText = new Set<string>();

  for (const rawPart of Array.isArray(parts) ? parts : []) {
    const part = (rawPart && typeof rawPart === "object" ? rawPart : {}) as Partial<OverviewAnalysis>;
    for (const rawChapter of Array.isArray(part.chapters) ? part.chapters : []) {
      const from = Number(rawChapter?.from);
      if (!Number.isFinite(from) || seenChapterFrom.has(from)) continue;
      seenChapterFrom.add(from);
      chapters.push({
        from: Math.floor(from),
        to: Number(rawChapter?.to) || Math.floor(from),
        title: String(rawChapter?.title ?? "").trim(),
        summary: String(rawChapter?.summary ?? "")
      });
    }
    for (const rawQuote of Array.isArray(part.quotes) ? part.quotes : []) {
      const from = Number(rawQuote?.from);
      const content = String(rawQuote?.content ?? "").trim();
      if (!Number.isFinite(from) || !content || seenQuoteText.has(content)) continue;
      seenQuoteText.add(content);
      quotes.push({ from: Math.floor(from), content });
    }
  }

  chapters.sort((a, b) => a.from - b.from);
  quotes.sort((a, b) => a.from - b.from);

  return {
    chapters: chapters.slice(0, MAX_ANALYSIS_CHAPTERS),
    quotes: quotes.slice(0, MAX_ANALYSIS_QUOTES)
  };
}

/**
 * 把金句按时间戳归入章节，形成「章节 → 金句」的层次结构（整搬 lib/ai.js:380-403，
 * 字段名归一化）。不依赖模型显式给出归属：章节与金句的时间戳都出自同一份字幕、
 * 同一个模型，归类的误差很小。章节需按时间升序（validateAnalysis / 稿件归一化
 * 已保证）。金句落到最后一个 from <= 自己时间戳的章节；落在第一章之前的归为
 * orphan，由消费方决定怎么展示（单列「其他金句」比硬塞进最近的章节诚实）。
 * 两条路径（AI 分章 / 自带章节）的产物都是扁平 chapters + quotes，归章统一
 * 由本函数在消费端完成，UI 不区分来源。
 */
export function groupQuotesIntoChapters(
  chapters: AnalysisChapter[],
  quotes: AnalysisQuote[]
): { grouped: Array<{ chapter: AnalysisChapter; quotes: AnalysisQuote[] }>; orphans: AnalysisQuote[] } {
  const chapterList = (Array.isArray(chapters) ? chapters : []).filter((chapter) =>
    Number.isFinite(Number(chapter?.from))
  );
  const quoteList = (Array.isArray(quotes) ? quotes : []).filter((quote) => Number.isFinite(Number(quote?.from)));

  const grouped = chapterList.map((chapter) => ({ chapter, quotes: [] as AnalysisQuote[] }));
  const orphans: AnalysisQuote[] = [];

  for (const quote of quoteList) {
    const seconds = Number(quote.from);
    let owner = -1;
    for (let i = 0; i < chapterList.length; i += 1) {
      if (Number(chapterList[i].from) <= seconds) owner = i;
      else break;
    }
    if (owner >= 0) grouped[owner].quotes.push(quote);
    else orphans.push(quote);
  }

  return { grouped, orphans };
}

/**
 * 按输入长度估算输出 token 上限（整搬 lib/ai.js:202-210）。max_tokens 是上限
 * 而非配额，给宽不花钱；但超过模型自身上限会被拒，所以给有余量的估算。
 * 概览是摘要，产出远小于原文：调用方按 ratio 0.5、floor 2048 传入（对齐
 * 参考仓库 analyzeChunk），前情回顾只进输入不进输出。
 */
export function estimateOutputTokens(
  inputChars: unknown,
  { ratio = 1, floor = 1024, ceiling = 8192 }: { ratio?: number; floor?: number; ceiling?: number } = {}
): number {
  const chars = Number.isFinite(Number(inputChars)) && Number(inputChars) > 0 ? Number(inputChars) : 0;
  // 中文约一字一 token；固定量留给 JSON 结构与转义字符。
  const estimated = Math.ceil(chars * ratio) + 512;
  return Math.min(Math.ceil(Number(ceiling) || 8192), Math.max(Math.ceil(Number(floor) || 1024), estimated));
}

// ============================================================
// 用户提示词装配（单一渲染收口：变量全部在这里从 body / 段 items 现场装配）
// ============================================================

export interface BuildAnalysisPromptInput {
  title?: unknown;
  ownerName?: unknown;
  videoDescription?: unknown;
  /** 本段（或全部）字幕项 { from, to, content }（秒级时间戳）。 */
  items?: unknown;
  /** 前情回顾：上一段结尾字幕项；第一段与不分块时为空。 */
  contextItems?: unknown;
  /** 元数据时长（秒）；分段路径传本段结束秒，让时长变量收敛在本段区间内。 */
  videoDuration?: unknown;
  /** 本段起始秒（用户提示词的「第 N 秒」与校验下界同源）。 */
  startSeconds?: unknown;
  /** 分段信息（1-based）；与 totalSegments 一起 >1 时产出 rangeNote。 */
  segmentIndex?: unknown;
  totalSegments?: unknown;
}

export interface BuiltAnalysisPrompt {
  prompt: string;
  timing: ReturnType<typeof analysisTimingVariables>;
  /** 字幕正文渲染产物长度（输出 token 估算的输入，前情回顾不计入）。 */
  transcriptChars: number;
}

// rangeNote / contextNote 措辞整搬参考仓库 lib/analysis-service.js analyzeChunk；
// 短路径（只挑金句）把「章节与金句」改为「金句」。
function buildRangeNote(
  mode: "full" | "quotes",
  segmentIndex: unknown,
  totalSegments: unknown,
  startSeconds: number,
  endSeconds: number
): string {
  const index = Math.floor(Number(segmentIndex) || 1);
  const total = Math.floor(Number(totalSegments) || 1);
  if (total <= 1) {
    return "";
  }
  const scope = mode === "full" ? "只为这一段产出章节与金句" : "只为这一段挑选金句";
  return (
    `注意：这是长视频切分后的第 ${index} / ${total} 段，` +
    `覆盖 ${formatAnalysisClock(startSeconds)} 到 ${formatAnalysisClock(endSeconds)}。` +
    `${scope}，不要涉及其它时间段。`
  );
}

function buildContextNote(mode: "full" | "quotes", contextItems: unknown): string {
  const text = renderAnalysisTranscript(contextItems);
  if (!text) {
    return "";
  }
  const clause = mode === "full" ? "不要为它开章节或挑金句" : "不要从中挑金句";
  return `\n前情回顾（上一段的结尾，只用来理解本段承接什么，${clause}）：\n${text}\n`;
}

/**
 * 概览用户提示词装配（mode=full 整份分章+金句；mode=quotes 自带章节短路径只挑金句）。
 * 输入与素材预算判定（buildBudgetPlan 的 body / 段 items）同源；时长变量按本段
 * 区间算（videoDuration 传段尾秒或视频时长），让模型只覆盖这一段。
 */
function buildAnalysisUserPrompt(mode: "full" | "quotes", input: BuildAnalysisPromptInput = {}): BuiltAnalysisPrompt {
  const items = normalizeItems(input.items);
  const timing = analysisTimingVariables(items, input.videoDuration);
  const startSeconds = Math.max(0, Math.floor(Number(input.startSeconds) || (items.length ? Number(items[0]?.from) || 0 : 0)));
  const lastItem = items.length ? items[items.length - 1] : null;
  const endSeconds = lastItem
    ? Math.max(startSeconds, Math.floor(Number(lastItem?.to) || Number(lastItem?.from) || startSeconds))
    : startSeconds;

  const transcriptText = renderAnalysisTranscript(items);
  const prompt = fillTemplate(mode === "full" ? ANALYSIS_USER_TEMPLATE : QUOTES_USER_TEMPLATE, {
    videoTitle: String(input.title ?? "").trim() || "未知",
    ownerName: String(input.ownerName ?? "").trim() || "未知",
    rangeNote: buildRangeNote(mode, input.segmentIndex, input.totalSegments, startSeconds, endSeconds),
    startFormatted: formatAnalysisClock(startSeconds),
    minTimestampSeconds: startSeconds,
    durationFormatted: timing.durationFormatted,
    maxTimestampSeconds: timing.maxTimestampSeconds,
    lateThreshold: timing.lateThreshold,
    videoDescription: String(input.videoDescription ?? "").trim() || "（无简介）",
    contextNote: buildContextNote(mode, input.contextItems),
    transcriptText
  });
  return { prompt, timing, transcriptChars: transcriptText.length };
}

/** 整份分章+金句的用户提示词（单次路径与分段路径的每段共用）。 */
export function buildAnalysisPrompt(input: BuildAnalysisPromptInput = {}): BuiltAnalysisPrompt {
  return buildAnalysisUserPrompt("full", input);
}

/** 自带章节短路径「只挑金句」的用户提示词（与 buildAnalysisPrompt 同一套变量装配）。 */
export function buildQuotesPrompt(input: BuildAnalysisPromptInput = {}): BuiltAnalysisPrompt {
  return buildAnalysisUserPrompt("quotes", input);
}

// ============================================================
// 缓存（chrome.storage.local + 统一 LRU 淘汰；读取失败静默返回 null）
// ============================================================

type SaveResult = EvictionResult | EvictionFailure;

// 本模块新增两族并入统一 LRU 淘汰名单：概览写入顺带维持「每族最近 3 个视频」
// 的既有不变量（既有三族名单不动，历史行为零变化）。
const ANALYSIS_CACHE_FAMILIES = [...CACHE_FAMILIES, ANALYSIS_SEGMENT_PREFIX, ANALYSIS_FINAL_PREFIX];

function contextKeyFields(context: Record<string, unknown> | undefined | null): {
  bvid: unknown;
  cid: unknown;
  subtitleId: string;
  subtitleUrl: string;
  lang: string;
} {
  const fields = segmentCacheKeyFields(context);
  return {
    bvid: fields.bvid,
    cid: fields.cid,
    subtitleId: String(fields.subtitleId ?? ""),
    subtitleUrl: String(fields.subtitleUrl ?? ""),
    lang: String(fields.lang ?? "")
  };
}

/**
 * 整份概览结果缓存键：bvid + cid + 字幕轨 source key + 字幕签名。
 * 签名随字幕内容（条数/首末时间戳/文本量）与轨道变化，重抓字幕/换轨/切分P 自然 miss。
 */
export function buildAnalysisFinalCacheKey(context: Record<string, unknown> | undefined | null, signature: unknown): string {
  const { bvid, cid, subtitleId, subtitleUrl, lang } = contextKeyFields(context);
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${ANALYSIS_FINAL_PREFIX}${bvid}_${cid}_${sourceKey}_${String(signature ?? "")}`;
}

/**
 * 概览分段产物缓存键：与 boc_lvs_summary_ 同族键形（…+ 段序号 [+ 预算代]），
 * 仅族前缀不同——产物不共享、键位机制共享（07 票决议）；预算代后缀逻辑继承
 * segment-cache 的 budgetScaleSuffix（_b50 等），段边界漂移不串内容。
 */
export function buildAnalysisSegmentCacheKey(
  context: Record<string, unknown> | undefined | null,
  segmentIndex: number | string | unknown,
  budgetScale: number | string | unknown = 1
): string {
  const { bvid, cid, subtitleId, subtitleUrl, lang } = contextKeyFields(context);
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  return `${ANALYSIS_SEGMENT_PREFIX}${bvid}_${cid}_${sourceKey}_${segmentIndex}${budgetScaleSuffix(budgetScale)}`;
}

function isOverviewShape(value: unknown): value is OverviewAnalysis {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { chapters?: unknown }).chapters) &&
      Array.isArray((value as { quotes?: unknown }).quotes)
  );
}

/** 读取整份概览缓存：命中返回产物，未命中/读失败/形状损坏返回 null。 */
export async function loadAnalysisFinal(key: string): Promise<OverviewAnalysis | null> {
  try {
    const result = await chrome.storage.local.get(key);
    const value = (result[key] as { analysis?: unknown } | undefined)?.analysis;
    return isOverviewShape(value) ? value : null;
  } catch {
    return null;
  }
}

/** 保存整份概览产物：落盘 { analysis, timestamp }，走统一 LRU 淘汰；最终失败 logError 不抛。 */
export async function saveAnalysisFinal(key: string, analysis: OverviewAnalysis): Promise<SaveResult> {
  const result = await writeWithEviction({
    family: ANALYSIS_FINAL_PREFIX,
    bvid: parseBvidFromCacheKey(key, ANALYSIS_FINAL_PREFIX),
    keys: [key],
    pruneFamilies: ANALYSIS_CACHE_FAMILIES,
    write: () =>
      chrome.storage.local.set({
        [key]: {
          analysis,
          timestamp: Date.now()
        }
      })
  });
  if (!result.ok) {
    logError("[BOC] failed to save final analysis cache after eviction", {
      key,
      error: result.error?.message || result.error
    });
  }
  return result;
}

/** 读取概览分段产物：命中返回产物，未命中/读失败/形状损坏返回 null。 */
export async function loadAnalysisSegment(key: string): Promise<OverviewAnalysis | null> {
  try {
    const result = await chrome.storage.local.get(key);
    const value = (result[key] as { analysis?: unknown } | undefined)?.analysis;
    return isOverviewShape(value) ? value : null;
  } catch {
    return null;
  }
}

/** 保存概览分段产物：落盘 { analysis, timestamp }，容错语义同 saveAnalysisFinal。 */
export async function saveAnalysisSegment(key: string, analysis: OverviewAnalysis): Promise<SaveResult> {
  const result = await writeWithEviction({
    family: ANALYSIS_SEGMENT_PREFIX,
    bvid: parseBvidFromCacheKey(key, ANALYSIS_SEGMENT_PREFIX),
    keys: [key],
    pruneFamilies: ANALYSIS_CACHE_FAMILIES,
    write: () =>
      chrome.storage.local.set({
        [key]: {
          analysis,
          timestamp: Date.now()
        }
      })
  });
  if (!result.ok) {
    logError("[BOC] failed to save analysis segment cache after eviction", {
      key,
      error: result.error?.message || result.error
    });
  }
  return result;
}

// ============================================================
// 编排入口：双路径分派 + promise 复用 + 成本护栏
// ============================================================

export type ChatCompletionFn = (input: {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  messages: ChatMessage[];
  thinkingLevel?: string;
  signal?: AbortSignal | null;
  retries?: number;
  maxTokens?: number | null;
}) => Promise<unknown>;

export type BuildBudgetPlanFn = (args: { body?: unknown[]; chapters?: unknown[] }) => BudgetPlan;

export type BuildCostGuardNoticeFn = (args: { estimatedCalls?: unknown; estimatedTokens?: unknown }) => {
  shouldPrompt: boolean;
  message: string;
};

export interface RunOverviewAnalysisArgs {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  /** AI 上下文（AiContext 形状）：bvid/cid/字幕轨三键位 + title/author/videoDescription + subtitleBody/chapters。 */
  context: Record<string, unknown>;
  signal?: AbortSignal | null;
  thinkingLevel?: string;
  /** 跳过整份缓存读取重新生成（分段缓存仍复用——重试只重跑未落盘段）。 */
  forceRefresh?: boolean;
}

export interface RunOverviewAnalysisDeps {
  chatCompletion?: ChatCompletionFn;
  buildBudgetPlan?: BuildBudgetPlanFn;
  buildCostGuardNotice?: BuildCostGuardNoticeFn;
  /** 成本护栏确认钩子（≥5 次调用时）；未注入则不阻塞、直接生成（接线由集成步骤负责）。 */
  askCostGuard?: (message: string) => Promise<unknown>;
  /** 分段进度回调（可选，数据层无 port）。 */
  onProgress?: (notice: string) => void;
}

// 生成中 promise 复用（对齐 ensureSummarizeChain 的 promise 缓存手法）：
// 同一 finalKey 的重复触发共享同一 promise；落定（成功或失败）即移除，
// 之后触发改走缓存读取或重新生成。
const inflightOverviews = new Map<string, Promise<OverviewAnalysis>>();

// 分段 worker 的单段结果：失败不炸整单（07 票决议），以 ok 标记带出段区间。
interface SegmentOutcome {
  ok: boolean;
  part?: OverviewAnalysis;
  from?: number;
  to?: number;
  error?: unknown;
}

// 稿件章节 → 产物章节（短路径：章节取稿件标题，模型不再分章）。
// to 缺失/不合法时回落到下一章 from（末章 maxSeconds），与 AI 分章产物同构。
function normalizeManuscriptChapters(chapters: unknown, maxSeconds: number): AnalysisChapter[] {
  const list = (Array.isArray(chapters) ? chapters : [])
    .map((raw) => {
      const item = raw as { from?: unknown; to?: unknown; title?: unknown };
      return {
        from: Math.floor(Number(item?.from)),
        to: Math.floor(Number(item?.to)),
        title: typeof item?.title === "string" ? item.title.trim().slice(0, 300) : ""
      };
    })
    .filter((item) => Number.isFinite(item.from) && item.from >= 0 && item.title)
    .sort((a, b) => a.from - b.from);

  const out: AnalysisChapter[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (seen.has(item.from)) continue;
    seen.add(item.from);
    const nextFrom = i + 1 < list.length ? list[i + 1].from : null;
    const to =
      Number.isFinite(item.to) && item.to > item.from
        ? item.to
        : nextFrom !== null && nextFrom > item.from
          ? nextFrom
          : maxSeconds;
    out.push({ from: item.from, to, title: item.title, summary: "" });
  }
  return out.slice(0, MAX_ANALYSIS_CHAPTERS);
}

// 取消错误：err.cancelled = true 标记（house style 类型化标记；消费方查标记分流）。
function makeOverviewCancelledError(): Error & { cancelled: true } {
  const error = new Error("已取消") as Error & { cancelled: true };
  error.cancelled = true;
  return error;
}

// 空产物错误：模型没给出任何有效章节与金句（对齐参考仓库 EMPTY_ANALYSIS 语义）。
function makeEmptyAnalysisError(): Error {
  return new Error("模型没有产出有效的章节或金句，请重试。");
}

// 单次模型调用 → 宽容解析 → 校验。maxTokens 按正文长度估算（ratio 0.5，
// 前情回顾只进输入不进输出）；非流式显式 retries 由调用方给（单次 2 / 分段走池层重试）。
async function requestValidatedPart({
  provider,
  systemPrompt,
  built,
  minSeconds,
  thinkingLevel,
  signal,
  retries,
  chatCompletionImpl
}: {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  systemPrompt: string;
  built: BuiltAnalysisPrompt;
  minSeconds: number;
  thinkingLevel?: string;
  signal?: AbortSignal | null;
  retries?: number;
  chatCompletionImpl: ChatCompletionFn;
}): Promise<OverviewAnalysis> {
  if (signal?.aborted) {
    throw makeAbortedError();
  }
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: built.prompt }
  ];
  const text = await chatCompletionImpl({
    provider,
    messages,
    thinkingLevel,
    signal,
    retries,
    maxTokens: estimateOutputTokens(built.transcriptChars, { ratio: 0.5, floor: 2048 })
  });
  return validateAnalysis(parseLooseJson(String(text ?? "")), built.timing.maxTimestampSeconds, minSeconds);
}

/**
 * 概览生成编排入口（纯数据层，依赖注入对齐 ladder / orchestrateMapReduce 惯例）：
 * 1. 双路径分派：字幕 ≤100k 字符（buildBudgetPlan mode=single）单次非流式调用
 *    （显式 retries: 2）；>100k 走 buildBudgetPlan 切段 + runMapBounded 有界并发
 *    每段生成 + 段产物合并。
 * 2. 自带章节短路径：context.chapters 非空时只跑金句挑选调用（短提示词），
 *    章节取稿件标题，产物与 AI 分章完全同构。
 * 3. 失败语义：分段路径段失败 → 跳过出部分结果 + failedRanges 记录（全部段
 *    失败 → 抛第一个真实错误）；单次路径失败 → 抛错由调用方处理。
 * 4. 缓存：整份结果按 (bvid, cid, 字幕轨, 字幕签名) 落 chrome.storage.local；
 *    分段产物按段缓存复用——重试（forceRefresh）天然只重跑未落盘段。
 * 5. 生成编排：同视频生成中重复触发 → 复用进行中的 promise（ensureSummarizeChain
 *    手法：promise 缓存按 finalKey 去重、落定即清），与笔记管线互不阻塞。
 * 返回归一化产物；abort / 取消 / 失败以异常上浮（err.aborted / err.cancelled 标记）。
 * 本函数刻意非 async：直接返回内部 promise，重复触发拿到的是同一个 promise 引用。
 */
export function runOverviewAnalysis(
  { provider, context, signal, thinkingLevel, forceRefresh = false }: RunOverviewAnalysisArgs,
  deps: RunOverviewAnalysisDeps = {}
): Promise<OverviewAnalysis> {
  const ctx = context || {};
  const body = Array.isArray(ctx.subtitleBody) ? (ctx.subtitleBody as unknown[]) : [];
  // 短路径判定：自带章节非空 → 只挑金句（章节取稿件标题）。
  const manuscriptChapters = Array.isArray(ctx.chapters) ? ctx.chapters : [];
  const shortPath = manuscriptChapters.length > 0;

  const signature = buildSubtitleSignature({
    lang: ctx.subtitleLang,
    subtitleId: ctx.selectedSubtitleId,
    subtitleUrl: ctx.selectedSubtitleUrl,
    body,
    chapters: manuscriptChapters
  });
  const finalKey = buildAnalysisFinalCacheKey(ctx, signature);

  // 生成编排：进行中 promise 复用（forceRefresh 的显式重生成不去重）。
  const inflight = forceRefresh ? undefined : inflightOverviews.get(finalKey);
  if (inflight) {
    return inflight;
  }
  const promise = executeOverviewRun({
    provider,
    ctx,
    body,
    shortPath,
    manuscriptChapters,
    finalKey,
    signal,
    thinkingLevel,
    forceRefresh,
    chatCompletionImpl: deps.chatCompletion ?? (_chatCompletion as unknown as ChatCompletionFn),
    buildBudgetPlanImpl: deps.buildBudgetPlan ?? (_buildBudgetPlan as unknown as BuildBudgetPlanFn),
    buildCostGuardNoticeImpl:
      deps.buildCostGuardNotice ?? (_buildCostGuardNotice as unknown as BuildCostGuardNoticeFn),
    askCostGuard: deps.askCostGuard,
    onProgress: deps.onProgress
  });
  if (!forceRefresh) {
    inflightOverviews.set(finalKey, promise);
    const cleanup = () => {
      if (inflightOverviews.get(finalKey) === promise) {
        inflightOverviews.delete(finalKey);
      }
    };
    promise.then(cleanup, cleanup);
  }
  return promise;
}

interface ExecuteOverviewRunArgs {
  provider: { baseUrl?: string; apiKey?: string; model?: string };
  ctx: Record<string, unknown>;
  body: unknown[];
  shortPath: boolean;
  manuscriptChapters: unknown[];
  finalKey: string;
  signal?: AbortSignal | null;
  thinkingLevel?: string;
  forceRefresh: boolean;
  chatCompletionImpl: ChatCompletionFn;
  buildBudgetPlanImpl: BuildBudgetPlanFn;
  buildCostGuardNoticeImpl: BuildCostGuardNoticeFn;
  askCostGuard?: (message: string) => Promise<unknown>;
  onProgress?: (notice: string) => void;
}

async function executeOverviewRun({
  provider,
  ctx,
  body,
  shortPath,
  manuscriptChapters,
  finalKey,
  signal,
  thinkingLevel,
  forceRefresh,
  chatCompletionImpl,
  buildBudgetPlanImpl,
  buildCostGuardNoticeImpl,
  askCostGuard,
  onProgress
}: ExecuteOverviewRunArgs): Promise<OverviewAnalysis> {
  if (normalizeItems(body).length === 0) {
    throw new Error("没有可用的字幕");
  }
  const systemPrompt = shortPath ? QUOTES_SYSTEM_PROMPT : ANALYSIS_SYSTEM_PROMPT;
  const buildPrompt = shortPath ? buildQuotesPrompt : buildAnalysisPrompt;
  // 整份缓存命中直接复用（短路径的章节取自稿件，返回前以稿件现值覆盖，防章节晚于字幕更新）。
  if (!forceRefresh) {
    const cached = await loadAnalysisFinal(finalKey);
    if (cached) {
      return shortPath
        ? { ...cached, chapters: normalizeManuscriptChapters(manuscriptChapters, cached.chapters.at(-1)?.to ?? 0) }
        : cached;
    }
  }

  const promptVars = {
    title: ctx.title,
    ownerName: ctx.author,
    videoDescription: ctx.videoDescription
  };
  const plan = buildBudgetPlanImpl({ body, chapters: manuscriptChapters });
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  const segmented = plan.mode === "map-reduce" && segments.length > 0;

  // 成本护栏：分段路径预估 ≥5 次调用时经注入的确认钩子询问（对齐 ladder 手法；
  // 钩子未注入则不阻塞——护栏 UI 接线由集成步骤负责）。
  if (segmented) {
    const guard = buildCostGuardNoticeImpl({
      estimatedCalls: segments.length,
      estimatedTokens: plan.totalChars
    });
    if (guard.shouldPrompt && typeof askCostGuard === "function") {
      if (signal?.aborted) {
        throw makeAbortedError();
      }
      const confirmed = Boolean(await askCostGuard(guard.message));
      if (!confirmed) {
        throw makeOverviewCancelledError();
      }
    }
  }

  if (!segmented) {
    // —— 单次路径：预算内一次调用，失败整体抛错由调用方处理（07 票决议）——
    const items = normalizeItems(body);
    const startSeconds = Math.max(0, Math.floor(Number(items[0]?.from) || 0));
    const built = buildPrompt({
      ...promptVars,
      items: body,
      contextItems: [],
      videoDuration: ctx.videoDuration,
      startSeconds,
      segmentIndex: 1,
      totalSegments: 1
    });
    const part = await requestValidatedPart({
      provider,
      systemPrompt,
      built,
      minSeconds: startSeconds,
      thinkingLevel,
      signal,
      retries: 2,
      chatCompletionImpl
    });
    const analysis = shortPath
      ? {
          ...part,
          chapters: normalizeManuscriptChapters(manuscriptChapters, built.timing.maxTimestampSeconds)
        }
      : part;
    if (!analysis.chapters.length && !analysis.quotes.length) {
      throw makeEmptyAnalysisError();
    }
    await saveAnalysisFinal(finalKey, analysis);
    return analysis;
  }

  // —— 分段路径：有界并发逐段生成（段缓存复用），段失败跳过出部分结果 ——
  const total = segments.length;
  let done = 0;

  const analyzeSegment = async (segment: BudgetPlanSegment, index: number): Promise<OverviewAnalysis> => {
    const segKey = buildAnalysisSegmentCacheKey(ctx, segment.index, 1);
    const cached = await loadAnalysisSegment(segKey);
    if (cached) {
      return cached;
    }
    if (signal?.aborted) {
      throw makeAbortedError();
    }
    // 前情回顾：上一段结尾字幕（只作上下文，产出限定在本段区间，靠 minSeconds 兜底）。
    const contextItems = index > 0 ? tailItems(segments[index - 1]?.items, ANALYSIS_CONTEXT_CHARS) : [];
    const built = buildPrompt({
      ...promptVars,
      items: segment.items,
      contextItems,
      // 时长变量按本段区间算（对齐参考仓库 analyzeChunk 传 chunk.endSeconds）。
      videoDuration: segment.to,
      startSeconds: segment.from,
      segmentIndex: index + 1,
      totalSegments: total
    });
    const part = await requestValidatedPart({
      provider,
      systemPrompt,
      built,
      minSeconds: segment.from,
      thinkingLevel,
      signal,
      chatCompletionImpl
    });
    // 先落盘再返回：失败重试只重跑未落盘段（segment-cache 复用语义）。
    await saveAnalysisSegment(segKey, part);
    return part;
  };

  const worker = async (segment: BudgetPlanSegment, index: number): Promise<SegmentOutcome> => {
    try {
      const part = await analyzeSegment(segment, index);
      return { ok: true, part };
    } catch (e) {
      // 中止仍整体上抛（池层收束）；其余失败按 07 票决议跳过该段、记录区间。
      if ((e as { aborted?: boolean })?.aborted || signal?.aborted) {
        throw e;
      }
      return { ok: false, from: segment.from, to: segment.to, error: e };
    }
  };

  let outcomes: SegmentOutcome[];
  try {
    outcomes = await runMapBounded({
      items: segments,
      worker,
      concurrency: DEFAULT_MAP_CONCURRENCY,
      signal,
      onItemDone: () => {
        done += 1;
        onProgress?.(buildProgressNotice(done, total));
      }
    });
  } catch (e) {
    if ((e as { aborted?: boolean })?.aborted || signal?.aborted) {
      throw e;
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  const parts = outcomes.filter((outcome) => outcome?.ok && outcome.part).map((outcome) => outcome.part as OverviewAnalysis);
  const failedRanges = outcomes
    .filter((outcome) => !outcome?.ok)
    .map((outcome) => ({ from: Math.floor(Number(outcome?.from) || 0), to: Math.floor(Number(outcome?.to) || 0) }));

  // 全军覆没时把第一个真实错误透出去，它比「生成失败」有用得多。
  if (parts.length === 0) {
    const firstError = outcomes.find((outcome) => !outcome?.ok)?.error;
    if (firstError instanceof Error) {
      throw firstError;
    }
    throw new Error(firstError ? String(firstError) : "概览生成失败。");
  }

  const merged = mergeAnalyses(parts);
  const analysis: OverviewAnalysis = shortPath
    ? {
        ...merged,
        chapters: normalizeManuscriptChapters(manuscriptChapters, merged.chapters.at(-1)?.to ?? 0)
      }
    : merged;
  if (!analysis.chapters.length && !analysis.quotes.length) {
    throw makeEmptyAnalysisError();
  }
  if (failedRanges.length) {
    analysis.failedRanges = failedRanges;
  }
  // 部分结果照常落缓存（含 failedRanges）：重试走 forceRefresh，段缓存让已成功段免重付费。
  await saveAnalysisFinal(finalKey, analysis);
  return analysis;
}
