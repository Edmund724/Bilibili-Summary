// AI 域共享类型（08 票迁移）。
// 只放纯类型与常量型字面量，不依赖运行时模块，供 ai/ 内部各模块复用。

export type ChatMessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
}

export interface SubtitleBodyItem {
  from: number;
  to: number;
  content: string;
  [key: string]: unknown;
}

export interface ChapterItem {
  title: string;
  from: number;
  to: number;
  [key: string]: unknown;
}

export interface HotComment {
  uname?: string;
  like?: number;
  message?: string;
  [key: string]: unknown;
}

export interface AiProvider {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  requiresKey?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface AiContext {
  title?: string;
  url?: string;
  author?: string;
  uploadDate?: string;
  bvid?: string;
  cid?: string;
  aid?: string;
  pageIndex?: number;
  pageCount?: number;
  pageTitle?: string;
  subtitleLang?: string;
  selectedSubtitleId?: string;
  selectedSubtitleUrl?: string;
  chapters?: ChapterItem[];
  videoDuration?: number;
  includeTimestampInBody?: boolean;
  subtitleBody?: SubtitleBodyItem[];
  subtitleOptions?: Array<{ id: string; url: string; lang: string }>;
  hotComments?: HotComment[];
  isVideoContext?: boolean;
  compressedSummaryMarkdown?: string;
  aiSystemPrompt?: string;
  [key: string]: unknown;
}

export interface BudgetPlanSegment {
  index: number;
  from: number;
  to: number;
  chars: number;
  items: SubtitleBodyItem[];
}

export interface BudgetPlan {
  totalChars: number;
  estimatedTokens: number;
  mode: "single" | "map-reduce";
  segments: BudgetPlanSegment[];
  estimatedCalls: number;
  needsReduce: boolean;
  reduceGroupInputChars: number;
}

export interface SseEvent {
  type: "reasoning" | "content";
  data: string;
}

export interface StreamTokenEvent {
  type: "token";
  data: string;
}

export interface StreamReasoningEvent {
  type: "reasoning";
  data: string;
}

export interface StreamNoticeEvent {
  type: "notice";
  data: string;
}

export interface StreamResetEvent {
  type: "stream-reset";
}

export interface StreamDoneEvent {
  type: "done";
}

export interface StreamStoppedEvent {
  type: "stopped";
  reason: string;
}

export interface StreamErrorEvent {
  type: "error";
  error: string;
}

export type StreamChatEvent =
  | StreamTokenEvent
  | StreamReasoningEvent
  | StreamNoticeEvent
  | StreamResetEvent
  | StreamDoneEvent
  | StreamStoppedEvent
  | StreamErrorEvent;

export interface ChatPort {
  postMessage(message: unknown): void;
}
