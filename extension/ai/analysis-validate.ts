// 「概览数据管线」三片之校验/合并（arch-slim-3 #11 自 ai/analysis.ts 切出，纯函数、零 import；
// 对外经 analysis.ts 壳再导出）。适配纯函数整搬自 .scratch/bilibili-digest/lib/ai.js，
// 产出归一化为本仓库字段名：{ chapters: {from,to,title,summary}[],
// quotes: {from,content}[], failedRanges?: {from,to}[] }。

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

interface AnalysisFailureRange {
  from: number;
  to: number;
}

/** 概览产物（含短路径与分段合并后的整份形态）；failedRanges 仅在分段路径有失败段时存在。 */
export interface OverviewAnalysis {
  chapters: AnalysisChapter[];
  quotes: AnalysisQuote[];
  failedRanges?: AnalysisFailureRange[];
}

// 校验上限：章节数 / 金句数（对齐参考仓库 validateAnalysis 的裁剪量级）。
export const MAX_ANALYSIS_CHAPTERS = 100;
const MAX_ANALYSIS_QUOTES = 50;

// ============================================================
// 适配纯函数（整搬自参考仓库 lib/ai.js，产出字段名归一化为本仓库形状）。
// 通用 JSON 防线（repairTruncatedJson / parseLooseJson）已独立为 ./json-repair.ts
// （arch-slim-2/08），本模块只保留概览 shape 专属的校验/合并；时长变量与
// 输出 token 估算随提示词装配在 analysis-prompts.ts。

/**
 * 把模型输出当作不可信数据重建一遍（整搬 lib/ai.js:116-172，字段名归一化）：
 * - 模型编造超出视频时长的时间戳是常态，越界条目直接丢掉；
 * - 显示用的时间戳从校验过的秒数反推（formatClock），模型给的
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
