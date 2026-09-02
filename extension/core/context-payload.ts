// context-payload.ts — content ↔ 对话上下文快照的「形状单源」（纯模块，零依赖）。
//
// 为什么存在：reader-get-context 的 payload 是 content 与对话上下文之间的隐式
// 跨 context 契约。此前字段清单手写在 message-handler 的组装字面量里，「哪些字段
// 参与签名失效判定」又只活在 computeContextStateSignature 的注释里，两处知识
// 分居、改动靠人肉对账。本模块把三件事收进一处：
//   1. 字段清单（READER_CONTEXT_PAYLOAD_FIELDS，含每个字段「给谁消费」的对账注）；
//   2. 组装工厂（createReaderContextPayload，message-handler 只喂运行时输入）；
//   3. 签名投影（参与字段集合 + 逐字段投影 + 排除清单，签名从 payload 字段清单
//      派生而非手列 join 数组）。
//
// 契约边界（对账结论，勿在本模块补字段）：对话侧实际持有的快照 = 本 payload +
//   { signature }（message-handler 处理器附加）+ { hotComments 覆盖, isVideoContext }
//   （background 的 ai/context-resolver.js getAiContextState 转发层覆盖/补写）。
//   即 isVideoContext 不由 content 组装，对话侧读取依赖背景层补写。
//
// 纯模块约束：不 import state/defaults/location——运行时输入（clip/settings/url）
// 全部由调用方注入；对 snapshot 的非法形状一律按旧实现的缺省口径容错。

import type { ClipState, NoSubtitleReason, SubtitleBodyItem, SubtitleOption, ChapterItem } from "./state.js";
import type { Settings } from "./defaults.js";

// ============================================================
// 1. 字段清单（顺序即组装顺序，与线上响应的 key 序逐字一致）
// ============================================================

export type ReaderContextPayload = {
  url: string | undefined;
  title: string;
  author: string;
  uploadDate: string;
  bvid: string;
  cid: string;
  aid: string;
  pageIndex: number;
  pageCount: number;
  pageTitle: string;
  subtitleBody: SubtitleBodyItem[];
  videoDuration: number;
  includeTimestampInBody: boolean;
  subtitleFetchState: string;
  noSubtitleReason: NoSubtitleReason;
  subtitleLang: string;
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  subtitleOptions: SubtitleOption[];
  chapters: ChapterItem[];
  hotComments: unknown[];
};

// reader-get-context 全量 payload 的字段清单。每个字段注明消费方（对账于
// reader/chat-tab.ts 对话壳、ai/context-resolver.js、offscreen/ai 层）：
//   url                   对话侧 上下文 chip 跳转/禁用态（对话壳 updateContextChip）、
//                         会话 contextUrl 兜底；无 bvid/cid/aid 时经
//                         ai/conversation.js buildContextKey / buildAiContextRef 回落。
//   title                 对话侧 chip 文案；background hasLoadedClip 判定；offscreen
//                         渲染 prompt 首段（ai/context.js buildMessages）。
//   author / uploadDate   经 buildAiContextRef 随会话持久化；offscreen 渲染 prompt
//                         的作者/上传日期段。对话侧 UI 无直接读取。
//   bvid / cid / aid      会话上下文键（buildContextKey 的 video: 键）；background
//                         hasLoadedClip 判定；ai/segment-cache.js 缓存键入参。
//   pageIndex             会话持久化与标题 -P{n} 后缀（buildAiContextRef）。
//   pageCount / pageTitle 会话持久化（buildAiContextRef）；pageTitle 供背景层
//                         resolveAiSidepanelPageRef 兜底。对话侧 UI 无直接读取。
//   subtitleBody          对话侧 等待轮询（chat/subtitle-wait.ts）与无字幕拦截
//                         （chat/no-subtitle.ts）的判定数据；chat-runtime 按
//                         contextKey ack 省略重传；offscreen 单槽缓存（offscreen-
//                         subtitle-slot.js）与 prompt 渲染（ai/subtitle-prompt.js）。
//   videoDuration         offscreen 渲染 prompt 的 withHours（小时级时间戳）判定。
//   includeTimestampInBody 同上：offscreen 渲染 prompt 沿用同一时间戳开关。
//   subtitleFetchState    对话侧 等待轮询（loading）与无字幕拦截（empty）的主信号。
//   noSubtitleReason      对话侧 发送拦截的按原因提示（对话壳 buildNoSubtitleNotice）。
//   subtitleLang          会话持久化（buildAiContextRef）与 segment-cache 缓存键；
//                         背景层重选字幕轨时作 previousLang 偏好。
//   selectedSubtitleId    会话持久化、segment-cache 缓存键、背景层 previousId 偏好。
//   selectedSubtitleUrl   会话持久化、segment-cache 缓存键、背景层 previousUrl 偏好。
//   subtitleOptions       对话侧 侧当前无直接读取（保留：与 clip 快照 payload 字段同名
//                         同源 state.clip.subtitles，且签名按其长度判定换轨）。
//   chapters              offscreen 章节对齐切段（budgeter）与追问章节名检索
//                         （raw-retrieval/followup-context）。
//   hotComments           content 侧恒为 []：真值由 background 全量路径拉取后
//                         整体覆盖（getAiContextState）。此占位仅为字段齐全。
// 新增字段必须：同时进本清单 + 工厂 + 签名三分类（参与/间接/排除）之一，
// 并在 tests/core/message-handler-signature.test.js 的形状锁死断言里显式过测试。
export const READER_CONTEXT_PAYLOAD_FIELDS: readonly (keyof ReaderContextPayload)[] = Object.freeze([
  "url",
  "title",
  "author",
  "uploadDate",
  "bvid",
  "cid",
  "aid",
  "pageIndex",
  "pageCount",
  "pageTitle",
  "subtitleBody",
  "videoDuration",
  "includeTimestampInBody",
  "subtitleFetchState",
  "noSubtitleReason",
  "subtitleLang",
  "selectedSubtitleId",
  "selectedSubtitleUrl",
  "subtitleOptions",
  "chapters",
  "hotComments"
]);

// ============================================================
// 2. 组装工厂（原 message-handler.js 内联字面量原样抽出）
// ============================================================

// 输入：{ clip, settings, url }。
//   clip     content 侧 state.clip（字段名映射注意：payload.subtitleLang ←
//            clip.selectedSubtitleLang；payload.subtitleOptions ← clip.subtitles）。
//   settings content 侧 state.settings（缺省时调用方传 DEFAULT_SETTINGS）。
//   url      location.href（由调用方注入，保持本模块纯函数可测）。
// 输出字段名/key 顺序与线上响应逐字一致（key 序 = READER_CONTEXT_PAYLOAD_FIELDS）。
export function createReaderContextPayload({
  clip,
  settings,
  url
}: {
  clip?: Partial<ClipState>;
  settings?: Partial<Settings>;
  url?: string;
} = {}): ReaderContextPayload {
  const c = clip || {};
  const body = c.subtitleBody || [];
  const payload: ReaderContextPayload = {
    url,
    title: c.title || "",
    author: c.author || "",
    uploadDate: c.uploadDate || "",
    bvid: c.bvid || "",
    cid: c.cid || "",
    aid: c.aid || "",
    pageIndex: Number(c.pageIndex) > 0 ? Number(c.pageIndex) : 1,
    pageCount: Number(c.pageCount) > 0 ? Number(c.pageCount) : 0,
    pageTitle: c.pageTitle || "",
    subtitleBody: body as SubtitleBodyItem[],
    // 视频时长（fetcher 经 page-context seam 写入 clip.videoDuration）：offscreen
    // 渲染 prompt 时用于 withHours（小时级时间戳）判定。
    videoDuration: Number(c.videoDuration || 0) || 0,
    // 字幕时间戳开关透传：offscreen 渲染 prompt 时沿用同一设置；缺失按默认 true。
    includeTimestampInBody: settings?.includeTimestampInBody !== false,
    // idle/loading/ready/error：loading 且 subtitleBody 为空表示抓取（可能含小时级
    // ASR 转写）仍在进行，对话侧据此等待而非把空字幕直接发给模型。
    subtitleFetchState: c.subtitleFetchState || "idle",
    // empty 时的无字幕原因归类（null | "no-asr-config" | "asr-disabled" |
    // "asr-failed" | "asr-empty"），对话侧拦截总结发送时按原因提示。
    noSubtitleReason: c.noSubtitleReason || null,
    subtitleLang: c.selectedSubtitleLang || "",
    selectedSubtitleId: c.selectedSubtitleId || "",
    selectedSubtitleUrl: c.selectedSubtitleUrl || "",
    subtitleOptions: c.subtitles || [],
    // 章节透传（fetcher 写入 clip.chapters）：供侧边栏回传 offscreen 后做章节对齐
    // 切段（budgeter）与追问章节名检索（raw-retrieval/followup-context）。
    chapters: Array.isArray(c.chapters) ? (c.chapters as ChapterItem[]) : [],
    hotComments: []
  };
  return payload;
}

// ============================================================
// 3. 状态签名（候选5 上下文同步瘦身的失效判定）
// ============================================================

type SignatureProjection = readonly [keyof ReaderContextPayload | "cid", (s: Partial<ReaderContextPayload>) => string | number];

// 参与签名的字段（有序）+ 逐字段投影。签名相同 ⇒ 重发全量对 对话侧 是纯冗余——
// applyContextPayload 本就按 contextKey 去重不重渲染，但整份字幕体的消息传输
// 与上层热评的网络拉取照跑。索引型数组只取长度不取内容：同 id 字幕重拉产生的
// 等长新数组视为未变，与 对话侧 侧 contextKey 的去重语义一致。
//
// 各字段参与理由：
//   bvid / cid             视频身份主键（cid 空回退 aid，无 cid 的老数据/异常页
//                          仍有稳定键）。
//   pageIndex              同视频换分 P 是上下文实质变化。
//   subtitleFetchState     idle/loading/ready/error 覆盖抓取全生命周期，对话侧 等待
//                          轮询与无字幕拦截都以此为信号。
//   subtitleBody           字幕体是快照的大头；只取长度（内容变化伴随重抓，长度
//                          或 fetchState/selectedSubtitleId 必有同变）。
//   selectedSubtitleId     换轨的权威标识。
//   subtitleOptions        只取长度：可用轨集合变化 ⇒ 重选结果可能变化。
//   chapters               只取长度：章节集合变化影响切段与检索。
//   includeTimestampInBody 设置项变化改变 offscreen 渲染产物，需触发重发。
//   subtitleLang           与 selectedSubtitleId 互补的轨身份（lang 可独立变化）。
const SIGNATURE_FIELD_PROJECTIONS: readonly SignatureProjection[] = Object.freeze([
  ["bvid", (s: Partial<ReaderContextPayload>) => String(s.bvid || "").trim()],
  ["cid", (s: Partial<ReaderContextPayload>) => String(s.cid || "").trim() || String(s.aid || "").trim()],
  ["pageIndex", (s: Partial<ReaderContextPayload>) => (Number(s.pageIndex) > 0 ? Number(s.pageIndex) : 1)],
  ["subtitleFetchState", (s: Partial<ReaderContextPayload>) => String(s.subtitleFetchState || "idle")],
  ["subtitleBody", (s: Partial<ReaderContextPayload>) => (Array.isArray(s.subtitleBody) ? s.subtitleBody : []).length],
  ["selectedSubtitleId", (s: Partial<ReaderContextPayload>) => String(s.selectedSubtitleId || "").trim()],
  ["subtitleOptions", (s: Partial<ReaderContextPayload>) => (Array.isArray(s.subtitleOptions) ? s.subtitleOptions : []).length],
  ["chapters", (s: Partial<ReaderContextPayload>) => (Array.isArray(s.chapters) ? s.chapters : []).length],
  ["includeTimestampInBody", (s: Partial<ReaderContextPayload>) => (s.includeTimestampInBody !== false ? "1" : "0")],
  ["subtitleLang", (s: Partial<ReaderContextPayload>) => String(s.subtitleLang || "").trim()]
]);

// 直接参与签名的字段名（从投影表派生，保持单一事实）。
export const SIGNATURE_PARTICIPATING_FIELDS: readonly string[] = Object.freeze(
  SIGNATURE_FIELD_PROJECTIONS.map(([name]) => name as string)
);

// 间接参与：aid 仅在 cid 为空时经 cid 投影回退进入签名（见 cid 投影），自身
// 变化不独立驱动签名。单独列出而非并入排除清单，保证三分类划分完备、
// 「改排除字段签名不变」可机械遍历测试。
export const SIGNATURE_INDIRECT_FIELDS: readonly string[] = Object.freeze(["aid"]);

// 刻意不纳入签名的字段（排除清单即知识：此前只活在函数注释里）。逐项理由：
//   hotComments          由 background 按需拉取并在转发层整体覆盖（unchanged 短路
//                        时整体跳过）；content 侧恒为 []，纳入无信息量。
//   url / title          随视频切换必然带动 bvid/cid 变化，纳入只会制造假阳性刷新；
//                        title 同页可被站点改写（播放态后缀等），与上下文失效无关。
//   author / uploadDate  视频元信息，与 bvid/cid 同源一次落定，身份键已在签名内。
//   pageCount / pageTitle 同上：分 P 元信息，pageIndex/bvid 已覆盖失效判定。
//   videoDuration        与元信息同源写入；纯渲染参数，不影响「上下文是否换了」。
//   selectedSubtitleUrl  同 id 字幕重拉产生的签名 URL 变化不应触发整份重发（与
//                        对话侧 contextKey 按 id 去重的语义一致）。
//   noSubtitleReason     与 subtitleFetchState 同源变化（empty 收尾时两者同时
//                        落定），跟随 fetchState 即可。
export const SIGNATURE_EXCLUDED_FIELDS: readonly string[] = Object.freeze([
  "hotComments",
  "url",
  "title",
  "author",
  "uploadDate",
  "pageCount",
  "pageTitle",
  "videoDuration",
  "selectedSubtitleUrl",
  "noSubtitleReason"
]);

// 签名判定（纯函数，可测）。输入是 createReaderContextPayload 产物（即 SP
// 持有快照的 shape，背景层附加的 signature/hotComments/isVideoContext 字段天然
// 被投影表忽略）。字段覆盖 对话侧 消费的全部可变状态；实现从投影表派生，不再手列
// join 数组——加/减签名键只改 SIGNATURE_FIELD_PROJECTIONS 一处。
export function computeContextStateSignature(snapshot: Partial<ReaderContextPayload>): string {
  return SIGNATURE_FIELD_PROJECTIONS.map(([, project]) => String(project(snapshot))).join("|");
}
