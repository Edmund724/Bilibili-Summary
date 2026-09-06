// 「概览数据管线」三片之提示词装配（arch-slim-3 #11 自 ai/analysis.ts 切出，纯函数；
// 对外经 analysis.ts 壳再导出，只依赖 subtitle/cache 与 analysis-validate 的
// MAX_ANALYSIS_CHAPTERS）。
// 提示词整搬参考仓库 .scratch/bilibili-digest/prompts/analysis.md（系统提示词
// 全静态、逐字节一致；digest-only-ui 起顶层 "summary" 概述字段已随概览 UI 的
// 总结区块一并移除）。

import { normalizeSubtitleItems } from "../subtitle/cache.js";
import { formatClock, parseClock } from "../shared/clock-text.js";
import { MAX_ANALYSIS_CHAPTERS } from "./analysis-validate.js";
import type { SubtitleBodyItem } from "./types.js";

// 热门评论（HotComment[]）→ 可解析文本：只取 message 正文，一行一条。
// 评论缺失/形状不对返回空串；作者与点赞数不参与目录解析（避免噪声行）。
export function hotCommentsText(hotComments: unknown): string {
  if (!Array.isArray(hotComments)) return "";
  return hotComments
    .map((item) => String((item as { message?: unknown })?.message ?? ""))
    .filter(Boolean)
    .join("\n");
}

// ============================================================
// 系统提示词（全静态，逐字节可前缀缓存；变量全部在用户提示词侧）
// ============================================================

// 两份系统提示词逐字共享的「ASR 纠错块」（工单 arch-slim/03 提取）：金句挑选
// 标准 + ASR 字幕两大特点 + 金句纠错打磨。只此一份声明，两份提示词拼接引用；
// 合成串由 tests/ai/analysis-prompt-freeze.test.js 冻结断言逐字节把关。
const ASR_CORRECTION_BLOCK = `金句要挑这几类：
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
- 如果某段实在识别得太糟、无法还原原意，就别选它当金句`;

// 两份系统提示词逐字共享的「时间戳教学块」：字幕行格式、取时间戳的规则与
// 秒数换算示例。只此一份声明，两份提示词拼接引用。
const TIMESTAMP_TEACHING_BLOCK = `⚠️ 关键：时间戳的取法 ⚠️
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
- timestampSeconds: 150`;

// 整搬自 .scratch/bilibili-digest/prompts/analysis.md「系统提示词」代码块；
// digest-only-ui 起 JSON 输出 schema 顶层的 "summary" 概述字段已移除。
// 导出仅测试面：冻结断言（tests/ai/analysis-prompt-freeze.test.js）逐字节比对合成串。
export const ANALYSIS_SYSTEM_PROMPT = `你是我的内容助理。我在看一个 B 站视频，请阅读下面的字幕，产出一份结构化概览：章节 + 金句。

你需要给出：
- 覆盖**本次给到的全部字幕**的章节。章节数量由你判断——在话题真正发生转折的地方分章，该多则多、该少则少。唯一的硬性要求是覆盖度：章节必须贯穿这段字幕的整条时间线，**最后一个章节的时间戳必须晚于用户消息中给出的「后段门槛」**。不要只覆盖前半段，也不要把章节全挤在开头。
- 3-5 条金句，附上它们在字幕中的时间戳。

${ASR_CORRECTION_BLOCK}

${TIMESTAMP_TEACHING_BLOCK}

⚠️ 关于「现成章节目录」⚠️
用户消息里如果给出「视频简介/评论中的章节目录」（形如「00:00 开场」的时间戳行），
**章节边界必须完全采用那份目录**：目录里的每个时间戳 = 一章的起点，标题也用目录里的标题，
不得增删章节、不得改动任何时间戳——哪怕目录的分章与字幕的话题转折对不上。
你的职责只是为每一章补写 summary（这一段讲了什么），依据是目录时间戳之间的字幕内容。
前情回顾（分段路径）里的时间戳依然不能用：目录时间戳早于本段起点时，那一章归上一段管。

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
// 章节由视频自带，不再让模型分章（概览票 07 决议）。导出仅测试面（同上）。
export const QUOTES_SYSTEM_PROMPT = `你是我的内容助理。我在看一个 B 站视频，请阅读下面的字幕，为它挑选金句。

你需要给出：
- 3-5 条金句，附上它们在字幕中的时间戳。

${ASR_CORRECTION_BLOCK}

${TIMESTAMP_TEACHING_BLOCK}

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
{chapterOutlineNote}{contextNote}
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
// 小工具（渲染 / 模板填充；签名族已迁 subtitle/cache.ts）
// ============================================================

/**
 * 字幕正文 → 模型可读文本：每行 `[M:SS] 内容`（对齐系统提示词的字幕格式教学）。
 * 本模块是概览管线的单一渲染收口：预算按 body 判定（buildBudgetPlan），
 * 发送物由这里从同一份 body（段 items）现场渲染，预算量与实际消耗同源。
 */
function renderAnalysisTranscript(items: unknown): string {
  return normalizeSubtitleItems(items)
    .map((item) => `[${formatClock(item?.from)}] ${String(item?.content ?? "").trim()}`)
    .join("\n");
}

// 取一组字幕项末尾约 minChars 个字（至少一条），用作下一段的前情回顾；
// 至少给一条，否则正好卡在切点的那句话反而是最缺上下文的一句。
export function tailItems(items: unknown, minChars: number): SubtitleBodyItem[] {
  const list = normalizeSubtitleItems(items);
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

// 「最后一章必须晚于 75%」硬门槛比例（对齐参考仓库 ai.js:193-194，逼模型覆盖全片）。
const ANALYSIS_LATE_THRESHOLD_RATIO = 0.75;

/**
 * 时长变量：元数据时长有时缺失或不准，取「传入时长」与「字幕末条时间戳」的
 * 较大值。durationSeconds 传本段结束秒（分段路径）或视频时长（单次路径）。
 * 「最后一章必须晚于 75%」这条硬门槛，是逼模型覆盖全片而不是把章节全堆在
 * 开头最有效的一招（整搬 analysisTimingVariables 思路，结构化入参免正则反解析）。
 */
function analysisTimingVariables(
  items: unknown,
  durationSeconds: unknown
): { maxTimestampSeconds: number; durationFormatted: string; lateThreshold: string } {
  const list = normalizeSubtitleItems(items);
  const last = list.length ? list[list.length - 1] : null;
  const lastStampSeconds = last ? Math.max(0, Math.floor(Number(last?.to) || Number(last?.from) || 0)) : 0;
  const effectiveSeconds = Math.max(Math.floor(Number(durationSeconds) || 0), lastStampSeconds);
  return {
    maxTimestampSeconds: effectiveSeconds,
    durationFormatted: formatClock(effectiveSeconds),
    lateThreshold: formatClock(Math.floor(effectiveSeconds * ANALYSIS_LATE_THRESHOLD_RATIO))
  };
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

/** 简介/评论时间戳目录里的单条章节：秒数 + 标题（原样保留，不让模型改写）。 */
export interface OutlineChapter {
  seconds: number;
  title: string;
}

// 时间戳行识别：行首（可带列表符号/引用符号）后跟 M:SS / MM:SS / H:MM:SS，
// 后接标题文字（标题与时间戳之间也可用「・」「·」等间隔符）。纯时间戳行（无标题）
// 不算章节条目。上游正则约束形状，数值容错（2 段分钟位不封顶、拒 ss≥60/
// 3 段 mm≥60/hh≥24）单源到 shared/clock-text.ts 的 parseClock。
const OUTLINE_LINE_RE = /^(?:[-*•>#\s]|\d+[.、)])*\s*(\d{1,2}:\d{2}(?::\d{2})?)[\s・·]+(.{1,120}?)\s*$/;

// 目录时间戳解析：容错规则单源（parseClock），哨兵语义保留——解不出
// 返回 -1，parseChapterOutline 丢弃该条（原 parseOutlineClock 无范围校验，
// 「99:99」这类非法时刻归一后按拍板拒绝）。
function parseOutlineClock(text: string): number {
  return parseClock(text) ?? -1;
}

/**
 * 从简介/评论文本提取「时间戳目录」：形如「00:00 开场 / 03:25 安装」的行。
 * 至少 2 条才认定为现成章节划分（单条时间戳行不构成划分）；重复秒数去重、
 * 按秒排序；上限 MAX_ANALYSIS_CHAPTERS 对齐产物裁剪。不足 2 条或识别不了
 * 返回空数组，调用方回落到 AI 自由分章（现状行为）。
 */
export function parseChapterOutline(text: unknown): OutlineChapter[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const out: OutlineChapter[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    const match = line.match(OUTLINE_LINE_RE);
    if (!match) continue;
    const seconds = parseOutlineClock(match[1]);
    const title = match[2].trim();
    if (seconds < 0 || !title || seen.has(seconds)) continue;
    seen.add(seconds);
    out.push({ seconds, title });
  }
  if (out.length < 2) {
    return [];
  }
  out.sort((a, b) => a.seconds - b.seconds);
  return out.slice(0, MAX_ANALYSIS_CHAPTERS);
}

/**
 * 现成章节目录 → 用户提示词注入块。有空目录返回空串（模板行变空行），
 * 有目录时给出「边界照抄、只补大意」的硬约束（措辞与系统提示词的
 * 「现成章节目录」节呼应）。
 */
function buildChapterOutlineNote(outline: OutlineChapter[] | undefined): string {
  if (!Array.isArray(outline) || outline.length === 0) {
    return "";
  }
  const lines = outline.map(
    (item) => `${formatClock(item.seconds)} ${item.title}`
  );
  return (
    `\n现成章节目录（来自视频简介/评论，共 ${outline.length} 章）：\n` +
    `${lines.join("\n")}\n` +
    `按系统提示词的要求：章节边界与标题必须完全照抄这份目录，不要增删或改动时间戳，只需为每章补写 summary。\n`
  );
}

interface BuildAnalysisPromptInput {
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
  /** 简介/评论中解析出的现成章节目录（parseChapterOutline 产物）；非空时章节边界照抄目录。 */
  chapterOutline?: OutlineChapter[];
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
    `覆盖 ${formatClock(startSeconds)} 到 ${formatClock(endSeconds)}。` +
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
  const items = normalizeSubtitleItems(input.items);
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
    startFormatted: formatClock(startSeconds),
    minTimestampSeconds: startSeconds,
    durationFormatted: timing.durationFormatted,
    maxTimestampSeconds: timing.maxTimestampSeconds,
    lateThreshold: timing.lateThreshold,
    videoDescription: String(input.videoDescription ?? "").trim() || "（无简介）",
    chapterOutlineNote: buildChapterOutlineNote(input.chapterOutline),
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
