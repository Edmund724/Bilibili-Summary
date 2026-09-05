// 「时刻文本」单源模块（arch-slim-2/08；CONTEXT.md「时刻文本」词条的代码落点）：
// 视频「秒 ↔ 时刻文本」的唯一换算约定——展示格式、解析容错、withHours 判定
// 三件事都只有这一份实现。此前的双展示实现（ai/analysis.ts 的
// formatAnalysisClock、shared/string-utils.ts 的 formatCompactTimestamp）、
// 三处解析器（parseOutlineClock / parseTimestampSeconds / parseTimestampToSeconds）、
// 九处内联 withHours 启发式全部收口到此，禁止再出现靠注释对齐的第二套约定。
//
// 展示格式拍板（arch-slim-2 Q1）：统一不补零 `0:05`。
//   - 分钟不封顶（沿 formatAnalysisClock 口径）：3725 → `62:05`；
//   - 带小时位时 H:MM:SS 同样不补零：3725 → `1:02:05`；
//   - 系统提示词的教学格式 [M:SS]（analysis 的 TIMESTAMP_TEACHING_BLOCK）与本模块
//     的 never 档一致——提示词教学与 UI 渲染出自同一实现，字节冻结面不受本票影响。
//
// 过渡期兼容：历史缓存（boc_lvs_summary_* 分段小结正文）与旧笔记内嵌补零形态
// （`00:05`）的文本。parse 对补零/不补零输入一律接受——补零不影响 split+Number
// 的数值语义（"00" 与 "0" 同值），只影响展示；展示侧已统一切换为不补零，
// 补零形态仅存于解析容错。

/** 小时位档位：auto 按秒数自判（≥3600 带小时位）；never 恒不带；always 恒带。 */
export type ClockHoursMode = "auto" | "never" | "always";

export interface ClockFormatOptions {
  /**
   * 小时位档位，默认 false（never，教学格式 M:SS，分钟不封顶）。
   * boolean 为 withHours 布尔直通（迁移兼容形态）；三态枚举为正字。
   * boolean 形态为迁移期兼容、随存量调用方收敛（后续票）清退，新调用方一律用三态枚举。
   */
  hours?: ClockHoursMode | boolean;
}

// 小时位判定阈值：3600s = 1h。
const HOUR_SECONDS = 3600;

/**
 * 单点秒数的小时位判定（withHours 的最底层单源）。
 * 元数据级消费方（笔记/概览：字幕末尾、章节边界、视频时长取 max 后判定）与
 * 单点消费方（当前进度、锚点时间戳）共用；条目级用 shouldUseHoursForRange。
 * 非有限/负值一律 false。
 */
export function shouldUseHours(seconds: unknown): boolean {
  return (Number(seconds) || 0) >= HOUR_SECONDS;
}

/**
 * 条目级 withHours 判定：一个区间（字幕项 from/to、片段起止）的两端任一达到
 * 小时级即整条带小时位（沿 ai/map-reduce.ts formatSegmentItem 的既有口径）。
 */
export function shouldUseHoursForRange(from: unknown, to: unknown): boolean {
  return shouldUseHours(from) || shouldUseHours(to);
}

/**
 * 秒 → 时刻文本（全仓唯一展示实现，不补零）。
 * - hours=false/"never"（默认）：`M:SS`，分钟不封顶（3725 → `62:05`；5 → `0:05`）；
 *   这是系统提示词教学格式 [M:SS] 的同构档（ai/analysis.ts 的字幕渲染用）。
 * - hours=true/"always"：恒带小时位，不补零（3725 → `1:02:05`；5 → `0:00:05`）。
 * - hours="auto"：total ≥ 3600 走 always，否则 never（UI 惯例：整段/整卡统一口径）。
 * 负值/非有限值归 0；小数秒向下取整。
 */
export function formatClock(seconds: unknown, options: ClockFormatOptions = {}): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = options.hours ?? false;
  const withHours =
    hours === true || hours === "always" || (hours === "auto" && shouldUseHours(total));
  const second = total % 60;
  if (!withHours) {
    return `${Math.floor(total / 60)}:${String(second).padStart(2, "0")}`;
  }
  const minute = Math.floor((total % HOUR_SECONDS) / 60);
  return `${Math.floor(total / HOUR_SECONDS)}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

/**
 * 时刻文本 → 秒（全仓唯一解析实现，与 formatClock 互逆）：
 * - 2 段 = M:SS，3 段 = H:MM:SS；1 段与 >3 段不解析；
 * - 2 段的分钟位**不封顶**（62:05 = 3725）：formatClock never 档分钟不封顶
 *   （3725 → `62:05`），parse 必须能回读自己产出的形态；B 站长视频的目录行、
 *   字幕行与对话引用同为此形态；
 * - 3 段小时位出现后分钟/秒必须归位（mm < 60 / ss < 60），hh ≥ 24 沿原
 *   parseTimestampSeconds 严口径拒绝（B 站无 >24h 视频）；ss ≥ 60 一律非法
 *   （「99:99」不再换算成非法秒数）；
 * - 补零形态（`00:05` / `01:02:05`）与不补零同值，天然兼容（过渡期容错，见文件头）。
 * 解不出 / 非法返回 null。哨兵语义不在本模块、由调用方各自保留：
 *   章节目录解析失败 → -1（parseChapterOutline 丢弃该条）；
 *   对话时间戳跳转失败 → 0（timestamp-nav 不跳转）。
 */
export function parseClock(text: unknown): number | null {
  const parts = String(text ?? "")
    .trim()
    .split(":")
    .map(Number);
  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  const three = parts.length === 3;
  const hh = three ? parts[0] : 0;
  const mm = three ? parts[1] : parts[0];
  const ss = three ? parts[2] : parts[1];
  if (ss >= 60) {
    return null;
  }
  if (three && (hh >= 24 || mm >= 60)) {
    return null;
  }
  return hh * 3600 + mm * 60 + ss;
}
