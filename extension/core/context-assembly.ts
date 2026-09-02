// extension/core/context-assembly.ts — AiContext 装配链的唯一入口（arch-slim/07）。
//
// 为什么存在：AiContext 快照的「装配」此前分居两处——core/context-payload.ts
// 持有字段清单/组装工厂/签名投影（形状与签名单源），而把运行时输入变成快照的
// 三条 ContextFetch 策略（扩展页消息链、进程内直读、pinned 补水身份短路）住在
// chat/context-load.ts，与 loadContextState 编排壳混装在一个模块里，「从哪里
// 装配 AiContext」因此有两个答案。本模块把三条策略收进 context-payload 锚定的
// 唯一装配链：两条装配路（阅读对话 tab 的当前视频路径 = createInProcessContextFetch；
// pinned 补水路径 = createInProcessPinnedContextResolver，命中时复用上一条）共享
// 同一套校验（createReaderContextPayload 的缺省容错）与字幕签名语义
//（computeContextStateSignature），装配知识不再分居两处。
//
// 装配链与网络适配器的分工：本模块只负责「装配」（运行时输入 → 带
// signature / isVideoContext 的 AiContext 快照信封）；「无页面 / 无标签页」时的
// 纯网络路径（ai/context-resolver 的 resolveAiConversationContext /
// getAiContextState）只是装配链落回的适配器——消息链策略调用 getAiContextState
// 的 tab transport，pinned 解析器未命中时调用注入的 resolveNetwork，本模块不
// 复制任何网络装配知识。
//
// 依赖方向（无环）：core/context-payload（形状/签名纯模块）+ ai/conversation
//（contextRef 归一化纯函数）+ ai/context-resolver（消息链 transport）+
// core/defaults；core/state 与 bilibili/gateway 仅热评缺省实现的动态 import
//（不拖进消费方的静态模块图）。不 import chat/*——快照类型用 ai/types 的
// AiContext（chat-state 的 ChatSessionContextSnapshot 就是它的别名）——也不
// import 组合根。生产消费方仅 reader/chat-tab.ts（对话组合根，按 ContextFetch
// 策略注入点与 resolveAiConversationRef 接缝接线）。
import { buildAiContextRef } from "../ai/conversation.js";
import { getAiContextState } from "../ai/context-resolver.js";
import type { AiContext } from "../ai/types.js";
import {
  createReaderContextPayload,
  computeContextStateSignature
} from "./context-payload.js";
import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import type { ClipState } from "./state.js";

// getAiContextState 的 tabOps 消息响应信封（对齐 context-resolver 的
// ContextResponse 结构；测试注入宽松桩）
interface TabStateResponse {
  ok?: boolean;
  unchanged?: boolean;
  payload?: Record<string, unknown>;
  error?: string;
  comments?: unknown[];
}

// ===========================================================================
// 上下文组装策略（ContextFetch）：loadContextState 的「拉数据」注入点（PR5）
// ===========================================================================

// fetchContext 的输出信封（判别联合）：
//   no-tab   无可用标签页（消息链专属：getActiveTab 落空；进程内直读恒有
//            当前页，不产生该分支）→ loadContextState 走 resolveNoTabPlan
//   payload  全量快照，或签名短路命中（payload.unchanged === true，policy 据
//            此走 SKIP_UNCHANGED；两条策略实现都以该形态表达短路）
//   error    读取失败（tabUrl 可选：消息链在拿到 tab 后失败仍携带，与迁移前
//            「error 分支也刷新 liveTabUrl」的行为一致）
export type ContextFetchPayload = AiContext | { unchanged: true };

export type ContextFetchOutcome =
  | { kind: "no-tab" }
  | { kind: "payload"; tabUrl: string; payload: ContextFetchPayload }
  | { kind: "error"; tabUrl?: string; error: unknown };

export interface ContextFetchOptions {
  forceRefresh: boolean;
  // 上次全量快照的签名（liveContextData.signature）。content 状态未变时策略
  // 返回 unchanged 信封；forceRefresh=true 时策略忽略签名走全量（手动刷新
  // / URL 变化语义上是明确要求全网络重拉）。
  ifSignature: string;
}

export type ContextFetch = (opts: ContextFetchOptions) => Promise<ContextFetchOutcome>;

// ---------------------------------------------------------------------------
// 策略一：扩展页消息链（sidepanel 页面已随 PR5c 摘除，策略保留供扩展页复用）
// ---------------------------------------------------------------------------

export interface MessageChainContextFetchDeps {
  getActiveTab: () => Promise<{ id?: number; url?: string } | null>;
  // getAiContextState 的 tabOps（content 就绪 + 单发 tab 消息，生产组装点
  // 传 core/shared 的真实实现；签名对齐 context-resolver 的 EnsureReaderContentReady
  // / SendMessageToTab，测试注入宽松桩）
  ensureReaderContentReady: (tabId: number) => Promise<void>;
  sendMessageToTab: (tabId: number, message: Record<string, unknown>) => Promise<TabStateResponse>;
}

// 行为与迁移前 loadContextState 内联的「getActiveTab → getAiContextState」
// 一致：无可用标签页 → no-tab 信封（getAiContextState 不被调用）；往返失败
// → error 信封（tabUrl 照带——迁移前 error 分支也刷新 liveTabUrl）。
// getAiContextState 的错误不外抛，折成 error 信封（error 字段与迁移前同为
// (error as Error).message）。
export function createMessageChainContextFetch(deps: MessageChainContextFetchDeps): ContextFetch {
  return async function fetchContext({ forceRefresh, ifSignature }: ContextFetchOptions): Promise<ContextFetchOutcome> {
    const tab = await deps.getActiveTab();
    if (!tab?.id) {
      return { kind: "no-tab" };
    }
    const tabUrl = String(tab.url || "").trim();
    try {
      // 解析器的返回面是 { unchanged: true } 或全量快照（运行时判别），类型上
      // 的宽 boolean 收窄为字面量信封（与消息链现状一致，policy 读 unchanged
      // 严格 === true）。
      const payload = (await getAiContextState(
        tab.id,
        {
          forceRefresh,
          // 候选5：带上次全量快照的签名，content 侧状态未变时一次往返即短路返回
          //（不重发整份字幕体、不拉热评）。forceRefresh=true 时 content 忽略签名，
          // 手动刷新语义不变。liveContextData 为空（首次/此前失败）时签名为空串，
          // content 必走全量。
          ifSignature
        },
        { ensureReaderContentReady: deps.ensureReaderContentReady, sendMessageToTab: deps.sendMessageToTab }
      )) as ContextFetchPayload;
      return { kind: "payload", tabUrl, payload };
    } catch (error: unknown) {
      return { kind: "error", tabUrl, error: (error as Error).message };
    }
  };
}

// ---------------------------------------------------------------------------
// 策略二：进程内直读（reader 用，当前视频路径的装配入口）
// ---------------------------------------------------------------------------

export interface InProcessContextFetchDeps {
  // content 侧运行时输入（生产传 core/state.js 的 state.clip / state.settings
  // 与 location.href 读取器；测试注入受控快照）。clip 缺省为空对象（全缺省
  // payload），settings 缺省回 DEFAULT_SETTINGS（与 message-handler 组装口径
  // 一致）。
  clip?: () => Partial<ClipState>;
  settings?: () => Partial<Settings>;
  url?: () => string;
  // 热评拉取（全量路径专用；返回 [] 视为降级）。缺省实现重演 message-handler
  // 的 reader-get-hot-comments 处理器语义（见 defaultFetchHotComments）。
  fetchHotComments?: () => Promise<unknown[]>;
}

// 缺省热评实现：重演 core/message-handler.ts 的 reader-get-hot-comments
// 处理器（gateway 动态装载、getCurrentAid 判定、clipState.setHotComments 落账、
// 失败降级空列表）。动态 import 避免把 core/state 与 gateway 拖进本策略消费方
//（对话组合根）的静态模块图。
async function defaultFetchHotComments(): Promise<unknown[]> {
  // clipState 热评落账的引用（动态取自 core/state.js；装载失败时无从落账，
  // 与降级语义一致）。
  let clipState: (typeof import("./state.js"))["clipState"] | undefined;
  try {
    clipState = (await import("./state.js")).clipState;
    const { getCurrentAid, fetchHotComments } = await import("../bilibili/gateway.js");
    if (!getCurrentAid()) {
      clipState.setHotComments([]);
      return [];
    }
    const comments = await fetchHotComments(20);
    clipState.setHotComments(comments);
    return comments;
  } catch {
    // 装载/拉取失败时静默降级（落账清空），避免阻断主流程——与
    // reader-get-hot-comments 处理器的 catch 口径一致
    clipState?.setHotComments([]);
    return [];
  }
}

// reader 与 content 同进程：直接读 state.clip + core/context-payload 组装，
// 不走「扩展页 → background → content」的消息往返。消息链的三件事在此重演
//（工单 08 短路验收，测试见 tests/chat/context-inprocess.test.js）：
//   1. 签名短路：ifSignature 与当前 payload 签名一致且非 forceRefresh →
//      unchanged 信封（不重发字幕体、不拉热评，对应 message-handler
//      reader-get-context 处理器的现有语义）；
//   2. 热评时机：仅全量路径拉热评（unchanged 已提前返回），时机与
//      getAiContextState 现状一致；
//   3. 快照附带 signature（对应 content 全量路径的回执附签）与 isVideoContext
//      补写（对应 background 转发层的补写职责——payload 单源不组装该字段），
//      loadContextState 落进 liveContextData 供下一轮 ifSignature。
// 「clip-refresh 驱动抓取」不在此重演：reader 世界的抓取由 reader 自身的
// URL 变化编排（message-handler bindUrlChangeHandler）驱动；转写中发送的等待
// 由 subtitle-wait 在发送路径承担（三事之三）。
export function createInProcessContextFetch(deps: InProcessContextFetchDeps = {}): ContextFetch {
  const getClip = deps.clip || (() => ({}));
  const getSettings = deps.settings || (() => DEFAULT_SETTINGS);
  const getUrl = deps.url || (() => (typeof location !== "undefined" ? location.href : ""));
  const fetchHotComments = deps.fetchHotComments || defaultFetchHotComments;

  return async function fetchContext({ forceRefresh, ifSignature }: ContextFetchOptions): Promise<ContextFetchOutcome> {
    const tabUrl = getUrl();
    // 与 message-handler 的 buildReaderContextPayload 同口径：字段清单/
    // 组装/缺省容错全部单源在 core/context-payload.js。
    const payload = createReaderContextPayload({
      clip: getClip(),
      settings: getSettings(),
      url: tabUrl
    });
    const signature = computeContextStateSignature(payload);
    if (!forceRefresh && ifSignature && ifSignature === signature) {
      return { kind: "payload", tabUrl, payload: { unchanged: true } };
    }
    // 全量路径才拉热评（短路已提前返回，时机与消息链现状一致）。热评条目为
    // 开放形状（HotComment 带索引签名），策略边界对齐 AiContext 的字段类型。
    const hotComments = (await fetchHotComments()) as AiContext["hotComments"];
    return {
      kind: "payload",
      tabUrl,
      // core/context-payload 的 ChapterItem/SubtitleOption 与 ai/types 的
      // 同名字段是同形结构类型（可选性/必选性略宽窄不同），消息链同样以此
      // 形状跨域传递，边界处经 unknown 断言对齐 AiContext。
      payload: { ...payload, hotComments, isVideoContext: true, signature } as unknown as ContextFetchPayload
    };
  };
}

// ---------------------------------------------------------------------------
// 策略三：pinned 补水的进程内身份短路（工单 04）
// ---------------------------------------------------------------------------

// pinned 会话的 contextRef 与当前 clip 的身份一致性判定（纯函数）。从紧语义：
// 任一身份字段缺失或不一致一律不命中（宁可多一次网络，不可装配出错的上下文）——
//   - bvid 双方非空且相等：视频身份主键；
//   - cid 双方非空且相等：分P 身份（ref.cid 缺失的老会话/aid 键会话不命中）；
//   - 字幕轨身份三元组（selectedSubtitleId / selectedSubtitleUrl / subtitleLang）
//     双方非空且逐项相等：轨不一致时网络路径会按 ref 偏好重选轨，而快照装配
//     给出的是当前生效轨，两者不可互换；
//   - clip.subtitleBody 非空：轨身份与字幕体同属「字幕接受」事务
//    （subtitle/commit.ts 原子落账），此处防御抓取/转写中窗口把空字幕上下文
//     装配给 pinned 补水（其发送路径不经 subtitle-wait 等待闸）。
// ref 先经 buildAiContextRef 归一（单一构造器；bvid 允许从 url 回落，但 cid
// 必须显式存在才可能命中）。
export function doesContextRefMatchCurrentClip(
  contextRef: unknown,
  clip: Partial<ClipState> | null | undefined
): boolean {
  const ref = buildAiContextRef(contextRef);
  const refBvid = String(ref.bvid || "").trim();
  const refCid = String(ref.cid || "").trim();
  const clipBvid = String(clip?.bvid || "").trim();
  const clipCid = String(clip?.cid || "").trim();
  if (!refBvid || !refCid || refBvid !== clipBvid || refCid !== clipCid) {
    return false;
  }
  const trackFields = [ref.selectedSubtitleId, ref.selectedSubtitleUrl, ref.subtitleLang].map((item) =>
    String(item || "").trim()
  );
  const clipTrackFields = [
    clip?.selectedSubtitleId,
    clip?.selectedSubtitleUrl,
    clip?.selectedSubtitleLang
  ].map((item) => String(item || "").trim());
  if (trackFields.some((item, index) => !item || item !== clipTrackFields[index])) {
    return false;
  }
  return Array.isArray(clip?.subtitleBody) && clip.subtitleBody.length > 0;
}

// pinned 补水的 context 解析器：conversation-store 的 resolveAiConversationRef
//（purpose="context"）dep 在 reader 组合根的适配器。contextRef 与当前 clip 身份
// 一致（上面的判定）→ 经 createInProcessContextFetch 从同进程快照装配（同 shape
// 同签名，不再经网络解析发三四趟请求、不重新下载可达 MB 级的字幕正文）；未命中
//（换视频/换分P/换轨/无页面/转写中）→ 原样落回注入的网络解析器
//（ai/context-resolver 的纯网络路径适配器，本装配链不复制其装配知识）。
// conversation-store 的 context 解析 dep 因此保持「进程内短路 + 网络」两个
// 适配器的复合，接缝真实（扩展页消息链世界仍直接接纯网络解析器）。
export interface InProcessPinnedContextResolverDeps {
  // 进程内快照输入（与 createInProcessContextFetch 同一套注入、同一缺省口径）。
  clip?: () => Partial<ClipState>;
  settings?: () => Partial<Settings>;
  url?: () => string;
  fetchHotComments?: () => Promise<unknown[]>;
  // 未命中时的网络路径（生产传 ai/context-resolver 的 resolveAiConversationContext；
  // 原始 contextRef 透传，归一化留给网络路径自己）。
  resolveNetwork: (contextRef: unknown) => Promise<Record<string, unknown>>;
}

export function createInProcessPinnedContextResolver(
  deps: InProcessPinnedContextResolverDeps
): (contextRef: unknown) => Promise<Record<string, unknown>> {
  const fetchContext = createInProcessContextFetch({
    clip: deps.clip,
    settings: deps.settings,
    url: deps.url,
    fetchHotComments: deps.fetchHotComments
  });
  const getClip = deps.clip || (() => ({}));
  const resolveNetwork = deps.resolveNetwork;

  return async function resolveAiConversationContext(contextRef: unknown): Promise<Record<string, unknown>> {
    if (doesContextRefMatchCurrentClip(contextRef, getClip())) {
      // 命中：forceRefresh + 空签名 ⇒ 必走全量（不吃 unchanged 短路），热评
      // 时机与 live 全量路径一致。
      const outcome = await fetchContext({ forceRefresh: true, ifSignature: "" });
      // 进程内组装不产生 no-tab/error，空签名下 unchanged 也不可达；防御式
      // 收窄，异常形态一律落回网络路径。
      if (
        outcome.kind === "payload" &&
        outcome.payload &&
        (outcome.payload as { unchanged?: unknown }).unchanged !== true
      ) {
        return outcome.payload as Record<string, unknown>;
      }
    }
    return resolveNetwork(contextRef);
  };
}
