import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import { logWarnAlways } from "../shared/logging.js";

/**
 * State namespace objects.
 *
 * Access patterns:
 * - Structured: state.reader.X, state.clip.X, state.ui.X
 * (the playerAi namespace has moved to ai/player-ai-state.ts)
 *
 * The structured namespaces expose the sub-state objects directly.
 * Flat sub-state property access (e.g. state.readingViewOpen) is no longer
 * supported; use the structured namespace (state.reader.readingViewOpen) instead.
 */

// subtitleFetchState 的取值全集（写入点：fetcher resetClipState/refreshClip/catch
// 收尾与 subtitle/commit 的接受/无字幕两事务；读取点 subtitle/core 占位文案、
// chat/subtitle-wait pending 判定、chat/no-subtitle 拦截、context-payload 快照）。
export type SubtitleFetchState = "idle" | "loading" | "ready" | "error" | "empty";

// noSubtitleReason 的取值全集（写入点 asr/fallback.ts 各终态分支与 commit 事务；
// KNOWN_ASR_SKIP_REASONS 白名单与 "asr-disabled"/"no-asr-config" 同源）。
export type NoSubtitleReason = null | "no-asr-config" | "asr-disabled" | "asr-failed" | "asr-empty";

export type SubtitleOption = {
  id?: string;
  subtitleUrl?: string;
  lan?: string;
  [key: string]: unknown;
};

export type SubtitleBodyItem = {
  from: number;
  to: number;
  content: string;
};

export type ChapterItem = {
  title: string;
  from: number;
  to?: number;
};

// ===== Reader namespace =====
// Issue 06 hoisted reader-internal bookkeeping into reader-impl.js module closure;
// issue 07 removed the now-dead fields. The remaining fields are settings/shared
// flags plus a few cross-module bookkeeping fields: readingVideoEl (video-probe
// reads, fetcher writes null, reader-impl writes the element when binding/
// unbinding), readingDocumentClickBound (ui-renderer sets), readingShellState
// (阅读壳生命周期状态机，唯一写手 transitionReaderShell).

// 阅读壳生命周期四态。合法迁移集见 transitionReaderShell 处的注释。
export type ReaderShellState = "closed" | "entering" | "open" | "exiting";

type ReaderBusinessState = {
  readingViewOpen: boolean;
  readingTheme: string;
  readingSettingsExpanded: boolean;
  readingActiveSubtitleIndex: number;
  readingActiveChapterIndex: number;
  readingNextScrollBehavior: string;
  readingViewReady: boolean;
};

type ReaderInternalState = {
  // 阅读壳生命周期状态机（closed/entering/open/exiting），唯一写手是下方
  // transitionReaderShell；readingViewOpen 是它的派生投影。
  readingShellState: ReaderShellState;
  readingVideoEl: HTMLVideoElement | null;
  readingDocumentClickBound: boolean;
};

type ReaderSetters = {
  setViewOpen(value: boolean): void;
  setTheme(value: string): void;
  setSettingsExpanded(value: boolean): void;
  setActiveSubtitleIndex(value: number): void;
  setActiveChapterIndex(value: number): void;
  setNextScrollBehavior(value: string): void;
  setViewReady(value: boolean): void;
};

export type ReaderState = Readonly<ReaderBusinessState> & ReaderInternalState & ReaderSetters;
type ReaderStateWritable = ReaderBusinessState & ReaderInternalState & ReaderSetters;

const localReaderState: ReaderStateWritable = {
  readingShellState: "closed",
  // readingViewOpen 是阅读壳状态机的派生投影（readingShellState === "open"）：
  // 全部读取点零改动。setter 保留直写兼容（测试脚手架/历史直写点经它对齐
  // 状态机，绕过迁移校验）——生产写入点一律走 transitionReaderShell。
  get readingViewOpen() { return this.readingShellState === "open"; },
  set readingViewOpen(value: boolean) { this.readingShellState = value ? "open" : "closed"; },
  readingTheme: "light",
  readingSettingsExpanded: false,
  readingActiveSubtitleIndex: -1,
  readingActiveChapterIndex: -1,
  readingNextScrollBehavior: "smooth",
  readingVideoEl: null,
  readingDocumentClickBound: false,
  readingViewReady: false,
  setViewOpen(value) { this.readingViewOpen = value; },
  setTheme(value) { this.readingTheme = value; },
  setSettingsExpanded(value) { this.readingSettingsExpanded = value; },
  setActiveSubtitleIndex(value) { this.readingActiveSubtitleIndex = value; },
  setActiveChapterIndex(value) { this.readingActiveChapterIndex = value; },
  setNextScrollBehavior(value) { this.readingNextScrollBehavior = value; },
  setViewReady(value) { this.readingViewReady = value; }
};

// ===== Clip namespace =====

type ClipBusinessState = {
  currentUrl: string;
  fetchRunId: number;
  bvid: string;
  aid: string;
  cid: string;
  cidSource: string;
  pageIndex: number;
  pageCount: number;
  pageTitle: string;
  videoDuration: number;
  description: string;
  title: string;
  author: string;
  uploadDate: string;
  subtitles: SubtitleOption[];
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  selectedSubtitleLang: string;
  subtitleBody: SubtitleBodyItem[];
  subtitleFetchState: SubtitleFetchState;
  noSubtitleReason: NoSubtitleReason;
  chapters: ChapterItem[];
  hotComments: unknown[];
  markdown: string;
  srt: string;
  txt: string;
  currentClipSignature: string;
};

type ClipSetters = {
  setCurrentUrl(value: string): void;
  setFetchRunId(value: number): void;
  setBvid(value: string): void;
  setAid(value: string): void;
  setCid(value: string): void;
  setCidSource(value: string): void;
  setPageIndex(value: number): void;
  setPageCount(value: number): void;
  setPageTitle(value: string): void;
  setVideoDuration(value: number): void;
  setDescription(value: string): void;
  setTitle(value: string): void;
  setAuthor(value: string): void;
  setUploadDate(value: string): void;
  setSubtitles(value: SubtitleOption[]): void;
  setSelectedSubtitleId(value: string): void;
  setSelectedSubtitleUrl(value: string): void;
  setSelectedSubtitleLang(value: string): void;
  setSubtitleBody(value: SubtitleBodyItem[]): void;
  setSubtitleFetchState(value: SubtitleFetchState): void;
  setNoSubtitleReason(value: NoSubtitleReason): void;
  setChapters(value: ChapterItem[]): void;
  setHotComments(value: unknown[]): void;
  setMarkdown(value: string): void;
  setSrt(value: string): void;
  setTxt(value: string): void;
  setCurrentClipSignature(value: string): void;
};

export type ClipState = Readonly<ClipBusinessState> & ClipSetters;
type ClipStateWritable = ClipBusinessState & ClipSetters;

const localClipState: ClipStateWritable = {
  currentUrl: typeof location !== "undefined" ? location.href : "",
  fetchRunId: 0,
  bvid: "",
  aid: "",
  cid: "",
  cidSource: "",
  pageIndex: 1,
  pageCount: 0,
  pageTitle: "",
  videoDuration: 0,
  description: "",
  title: "",
  author: "",
  uploadDate: "",
  subtitles: [],
  selectedSubtitleId: "",
  selectedSubtitleUrl: "",
  selectedSubtitleLang: "",
  subtitleBody: [],
  subtitleFetchState: "idle",
  // 无字幕原因（subtitleFetchState === "empty" 时的归类，供 sidepanel 拦截总结
  // 时按原因提示）：
  //   null            未知/不适用
  //   "no-asr-config" 未配置语音识别平台（含激活平台不在列表）
  //   "asr-disabled"  无字幕自动转写开关未开启
  //   "asr-failed"    语音识别失败
  //   "asr-empty"     语音识别成功但未识别到语音内容
  // 写入点在 asr/fallback.js 各终态分支（skip/empty 原因；失败原因随无字幕
  // 出口逆事务 commitNoSubtitle 写入）；清除点为 resetClipState 与字幕接受
  // 事务（subtitle/commit.js acceptSubtitle，subtitleFetchState → "ready"
  // 的唯一写入点）。
  noSubtitleReason: null,
  chapters: [],
  hotComments: [],
  markdown: "",
  srt: "",
  txt: "",
  currentClipSignature: "",
  setCurrentUrl(value) { this.currentUrl = value; },
  setFetchRunId(value) { this.fetchRunId = value; },
  setBvid(value) { this.bvid = value; },
  setAid(value) { this.aid = value; },
  setCid(value) { this.cid = value; },
  setCidSource(value) { this.cidSource = value; },
  setPageIndex(value) { this.pageIndex = value; },
  setPageCount(value) { this.pageCount = value; },
  setPageTitle(value) { this.pageTitle = value; },
  setVideoDuration(value) { this.videoDuration = value; },
  setDescription(value) { this.description = value; },
  setTitle(value) { this.title = value; },
  setAuthor(value) { this.author = value; },
  setUploadDate(value) { this.uploadDate = value; },
  setSubtitles(value) { this.subtitles = value; },
  setSelectedSubtitleId(value) { this.selectedSubtitleId = value; },
  setSelectedSubtitleUrl(value) { this.selectedSubtitleUrl = value; },
  setSelectedSubtitleLang(value) { this.selectedSubtitleLang = value; },
  setSubtitleBody(value) { this.subtitleBody = value; },
  setSubtitleFetchState(value) { this.subtitleFetchState = value; },
  setNoSubtitleReason(value) { this.noSubtitleReason = value; },
  setChapters(value) { this.chapters = value; },
  setHotComments(value) { this.hotComments = value; },
  setMarkdown(value) { this.markdown = value; },
  setSrt(value) { this.srt = value; },
  setTxt(value) { this.txt = value; },
  setCurrentClipSignature(value) { this.currentClipSignature = value; }
};

// ===== UI namespace =====

type UiBusinessState = {
  uiEventsBound: boolean;
  runtimeEventsBound: boolean;
  settingsWatcherBound: boolean;
  normalPageStateGuardBound: boolean;
  urlWatcherStarted: boolean;
  statusText: string;
  messageText: string;
};

type UiSetters = {
  setEventsBound(value: boolean): void;
  setRuntimeEventsBound(value: boolean): void;
  setSettingsWatcherBound(value: boolean): void;
  setNormalPageStateGuardBound(value: boolean): void;
  setUrlWatcherStarted(value: boolean): void;
  setStatusText(value: string): void;
  setMessageText(value: string): void;
};

export type UiState = Readonly<UiBusinessState> & UiSetters;
type UiStateWritable = UiBusinessState & UiSetters;

const localUiState: UiStateWritable = {
  uiEventsBound: false,
  runtimeEventsBound: false,
  settingsWatcherBound: false,
  normalPageStateGuardBound: false,
  urlWatcherStarted: false,
  statusText: "准备就绪，点击“刷新抓取”开始。",
  messageText: "",
  setEventsBound(value) { this.uiEventsBound = value; },
  setRuntimeEventsBound(value) { this.runtimeEventsBound = value; },
  setSettingsWatcherBound(value) { this.settingsWatcherBound = value; },
  setNormalPageStateGuardBound(value) { this.normalPageStateGuardBound = value; },
  setUrlWatcherStarted(value) { this.urlWatcherStarted = value; },
  setStatusText(value) { this.statusText = value; },
  setMessageText(value) { this.messageText = value; }
};

// ===== State container =====

export interface State {
  settings: Settings;
  readerState: ReaderState;
  clipState: ClipState;
  uiState: UiState;
  reader: ReaderState;
  clip: ClipState;
  ui: UiState;
  setSettings(next: Settings): void;
}

const localState: State = {
  settings: { ...DEFAULT_SETTINGS },
  readerState: localReaderState,
  clipState: localClipState,
  uiState: localUiState,
  reader: localReaderState,
  clip: localClipState,
  ui: localUiState,
  setSettings(next) { this.settings = next; }
};

// ===== 单例槽（content 双实例收口） =====
//
// 状态单例挂 globalThis 而非模块级：两轮构建（scripts/build-content.js）把常驻
// 底座在轮 B 懒 chunk 区重复一份，本模块在 content-main 与 chunks/ 共享 chunk
// 里各是一个实例——两份 state 各写各的，常驻侧（content.ts / message-handler /
// ui-status）与懒加载区（fetcher / reader / 对话）看到的 clip/ui/reader 不是
// 同一份，只靠「各自自洽」侥幸不出事（跨侧读取随时可能拿到空值：状态行文案、
// 视图开关、fetchRunId 代次）。隔离世界的 globalThis 在同一扩展的全部 content
// 模块间唯一，两侧对齐到同一份状态（与 shared/messaging.ts 的页内分发槽、
// reader/reader-bus.ts 的槽表同款先例）。
//
// 初始值（clip.currentUrl 读 location）由先求值的实例——常驻包——创建；后求值
// 的实例把自己那份本地对象丢弃、改用槽内对象，因此下面只导出槽内绑定，本地
// 对象仅作为「第一个实例」的建槽材料（一次性小开销，换来声明体逐字不动）。
interface StateBundle {
  readerState: ReaderStateWritable;
  clipState: ClipStateWritable;
  uiState: UiStateWritable;
  state: State;
}

const STATE_SLOT_KEY = "__BOC_STATE__";

const stateBundle: StateBundle = ((globalThis as unknown as Record<string, StateBundle | undefined>)[STATE_SLOT_KEY] ??= {
  readerState: localReaderState,
  clipState: localClipState,
  uiState: localUiState,
  state: localState
});

export const state: State = stateBundle.state;
export const clipState = stateBundle.clipState;
export const uiState = stateBundle.uiState;

// ===== 阅读壳生命周期状态机 =====
//
// 四态单源（ReaderShellState）+ 唯一写手 transitionReaderShell；派生布尔
// readingViewOpen（state === "open"）让既有读取点零改动。生产写入点一律走
// 迁移函数校验 from→to 合法性；非法迁移拒绝并经 logWarnAlways 直出（调试门
// 缺省关，异常路径不能静默）。
//
// 合法迁移集（含回退边——按 restore 自愈「先 close 再 enter」与直开路径的
// 现状定，保持既有行为全部合法）：
//   closed → entering   进入事务开始（reader/shell.ts 两个进入入口）
//   entering → open     enterReaderMode 打开视图
//   entering → closed   进入失败回退 / entering 中 restore 自愈先收敛
//   closed → open       直开兜底（entry/content.ts 直达路径直调 enterReaderMode）
//   open → exiting      退出事务开始（exitReaderShell 入队后）
//   open → closed       closeReadingView 兜底直关（不经退出事务的调用）
//   exiting → closed    退出事务内 closeReadingView 收尾
//   exiting → open      退出失败回退（视图仍在，不能卡在 exiting）
// 同态迁移（from === to）视为幂等 no-op，不记日志。desync（壳失整）不进状态机
// ——isReaderShellIntact 谓词 + digest-button 自查维持现状。

const READER_SHELL_TRANSITIONS: Record<ReaderShellState, readonly ReaderShellState[]> = {
  closed: ["entering", "open"],
  entering: ["open", "closed"],
  open: ["exiting", "closed"],
  exiting: ["closed", "open"]
};

export function getReaderShellState(): ReaderShellState {
  return state.reader.readingShellState;
}

export function transitionReaderShell(to: ReaderShellState): boolean {
  const from = state.reader.readingShellState;
  if (from === to) {
    return true;
  }
  if (!READER_SHELL_TRANSITIONS[from].includes(to)) {
    logWarnAlways(`[BOC] 非法阅读壳状态迁移：${from} → ${to}，已拒绝`);
    return false;
  }
  state.reader.readingShellState = to;
  return true;
}
