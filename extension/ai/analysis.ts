// 「概览数据管线」模块（概览票 07 + 选型报告 research/analysis-pipeline.md）：
// 章节金句概览的纯数据层——提示词装配、模型输出校验/修复/合并、双路径编排
// （预算内单次 / 超预算分段）、整份与分段两级缓存、生成中 promise 复用。

// arch-slim-3 #11 起按纯度切三片，本文件只是再导出壳（对外导出面与导入路径不变，
// 三片同属按需 analysis chunk）：
// - analysis-validate.ts：概览 shape 校验/合并纯函数与产物类型（纯，零 import）；
// - analysis-prompts.ts：系统/用户提示词装配与 token 估算（纯，只依赖 subtitle/cache
//   与 analysis-validate 的 MAX_ANALYSIS_CHAPTERS）；
// - analysis-orchestrate.ts：双路径编排、两级缓存接线、inflightOverviews promise 复用
//   （全仓唯一的 analysis 模块态）。
//
// 与笔记管线的关系（07 票决议）：产物不共享、只共享机制——分段边界沿用
// buildBudgetPlan.splitByBudget（同一 100k 判定线与 50k 单段预算），缓存走
// 独立的 boc_lvs_analysis_ 族前缀，互不读写、互不阻塞。
//
// 失败语义（07 票决议）：分段路径段失败 → 跳过该段出部分结果并记录
// failedRanges（含部分结果的整份产物照常落缓存，重试走 forceRefresh，段缓存
// 让已成功段免重付费）；单次路径失败 → 抛错由调用方处理。
// 不接 UI / reader / sidepanel；消费接线由后续集成步骤负责。

export type {
  AnalysisChapter,
  AnalysisQuote,
  OverviewAnalysis,
} from "./analysis-validate.js";
export {
  validateAnalysis,
  mergeAnalyses,
  groupQuotesIntoChapters,
} from "./analysis-validate.js";
export {
  ANALYSIS_SYSTEM_PROMPT,
  QUOTES_SYSTEM_PROMPT,
  parseChapterOutline,
  buildAnalysisPrompt,
} from "./analysis-prompts.js";
export {
  buildAnalysisFinalCacheKey,
  buildAnalysisSegmentCacheKey,
  runOverviewAnalysis,
} from "./analysis-orchestrate.js";
