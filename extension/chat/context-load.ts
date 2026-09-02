// extension/chat/context-load.ts — 上下文状态加载与上下文 chip（候选5 自
// sidepanel.ts 迁出，PR5 自 pages/sidepanel-context-load.ts 迁入 chat 域并
// 改造；PR5c 随 sidepanel 摘除，chat/* 为对话内核唯一宿主）：
// loadContextState（拉上下文 → 按策略动作执行编排副作用）、
// applyContextPayload、updateContextChip、isBoundConversationMismatched、
// openCurrentContextUrl。分支判定收敛在 ./context-policy.ts（纯函数，继续直
// import），本模块只负责拉数据、按动作执行。
//
// PR5 改造（上下文组装策略可注入）：loadContextState 的「拉数据」一段抽成
// ContextFetch 策略注入点，两条实现随本模块导出：
//   - createMessageChainContextFetch：扩展页消息链（getActiveTab +
//     getAiContextState 三连消息往返），行为与迁移前逐字节一致；
//   - createInProcessContextFetch：进程内直读（reader 用：直接读 content 侧
//     state.clip + core/context-payload 组装，不走消息往返），重演消息链的
//     三件事（工单 08 短路验收）：签名短路（unchanged 不重发字幕体、不拉
//     热评）、热评拉取时机（仅全量路径，与现状一致）、快照附 signature 供
//     下一轮 ifSignature；
//   - createInProcessPinnedContextResolver：pinned 补水的 context 解析适配器
//    （工单 04）：会话 contextRef 与当前 clip 身份一致 → 走上一条从同进程
//     快照装配（零网络解析、不重下字幕正文），未命中原样落回注入的网络
//     解析器（ai/context-resolver）。
//
// 依赖方向（无环）：共享可变状态（contextData / currentContextKey /
// liveContextData / liveContextKey / liveTabUrl / currentConversationMeta）直接
// import；上下文组装策略（fetchContext）、openCurrentContextUrl 的 transport
//（getActiveTab——扩展页专属跳转，reader 壳可不注入）、渲染/编排回调
//（contextChip 的 DOM、renderHistoryList、resetConversationView、restartChat、
// renderSuggestions、restoreLatest、流式守卫判定 isStreaming /
// hasPendingUserPrompt 惰性互引 chatRuntime 实例）经工厂 deps 注入。本模块
// 不 import 组合根。
import { buildAiContextRef, buildContextKey, doesTabMatchContextUrl } from "../ai/conversation.js";
import { getAiContextState } from "../ai/context-resolver.js";
import { waitForTabComplete } from "../shared/tab-utils.js";
import {
  createReaderContextPayload,
  computeContextStateSignature
} from "../core/context-payload.js";
import { DEFAULT_SETTINGS, type Settings } from "../core/defaults.js";
import type { ClipState } from "../core/state.js";
import {
  LOAD_CONTEXT_ACTION,
  isPinnedContextStrict,
  resolveLoadContextAction,
  resolveNoTabPlan
} from "./context-policy.js";
import { sidepanelState } from "./chat-state.js";
import type { SidepanelContextSnapshot } from "./chat-state.js";
import type { LoadContextStateOptions } from "./conversation-store.js";

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
export type ContextFetchPayload = SidepanelContextSnapshot | { unchanged: true };

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
// 策略二：进程内直读（reader 用）
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
// （对话组合根）的静态模块图。
async function defaultFetchHotComments(): Promise<unknown[]> {
  // clipState 热评落账的引用（动态取自 core/state.js；装载失败时无从落账，
  // 与降级语义一致）。
  let clipState: (typeof import("../core/state.js"))["clipState"] | undefined;
  try {
    clipState = (await import("../core/state.js")).clipState;
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
// （工单 08 短路验收，测试见 tests/chat/context-inprocess.test.js）：
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
    const hotComments = (await fetchHotComments()) as SidepanelContextSnapshot["hotComments"];
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

// pinned 补水的 context 解析器：conversation-store 的 resolveAiConversationContext
// dep 在 reader 组合根的适配器。contextRef 与当前 clip 身份一致（上面的判定）→
// 经 createInProcessContextFetch 从同进程快照装配（同 shape 同签名，不再经网络
// 解析发三四趟请求、不重新下载可达 MB 级的字幕正文）；未命中（换视频/换分P/
// 换轨/无页面/转写中）→ 原样落回注入的网络解析器。conversation-store 的
// context 解析 dep 因此保持「进程内短路 + 网络」两个适配器的复合，接缝真实
// （扩展页消息链世界仍直接接纯网络解析器）。
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

// ===========================================================================
// loadContextState 编排壳（「按动作执行副作用」骨架与迁移前一致）
// ===========================================================================

export interface CreateContextLoadDeps {
  // 上下文组装策略（createMessageChainContextFetch / createInProcessContextFetch）
  fetchContext: ContextFetch;
  // openCurrentContextUrl 的 transport（扩展页专属：chip 点击跳转目标视频；
  // reader 壳可不注入——缺省时 openCurrentContextUrl 为 no-op）
  getActiveTab?: () => Promise<{ id?: number; url?: string } | null>;
  contextChip: HTMLButtonElement;
  renderHistoryList: () => void;
  renderInitialState: () => void;
  renderSuggestions: () => void;
  resetConversationView: (stateHtml?: string) => void;
  restartChat: (opts?: { keepContext?: boolean }) => void;
  restoreLatest: () => Promise<boolean>;
  // 惰性互引（组装点以箭头函数接线，回调执行时 chatRuntime 实例已存在）
  isStreaming: () => boolean;
  hasPendingUserPrompt: () => boolean;
}

export interface ContextLoad {
  loadContextState: (opts?: LoadContextStateOptions) => Promise<boolean>;
  updateContextChip: () => void;
  openCurrentContextUrl: () => Promise<void>;
}

export function createContextLoad(deps: CreateContextLoadDeps): ContextLoad {
  const { contextChip } = deps;

  async function loadContextState({ forceRefresh = false, silent = false }: LoadContextStateOptions = {}): Promise<boolean> {
    const hasPinnedConversation = isPinnedContextStrict(sidepanelState.currentConversationMeta);
    // 上下文组装策略注入点（PR5）。ifSignature 沿用迁移前口径：上次全量快照
    // 的签名；liveContextData 为空（首次/此前失败）时签名为空串，策略必走全量。
    const outcome = await deps
      .fetchContext({ forceRefresh, ifSignature: String(sidepanelState.liveContextData?.signature || "") })
      .catch((error: unknown) => ({ kind: "error", error: (error as Error)?.message }) as ContextFetchOutcome);

    if (outcome.kind === "no-tab") {
      // 决策点一（迁移前为 getActiveTab 落空即走，现由策略信封报告——getAiContextState
      // 同样不被调用）：无可用标签页，按计划做失败清理（文案/清上下文/
      // 重置视图的取舍全部来自策略计划）。
      const plan = resolveNoTabPlan({ hasPinnedConversation, silent });
      sidepanelState.liveContextData = null;
      sidepanelState.liveContextKey = "";
      sidepanelState.liveTabUrl = "";
      if (plan.clearContext) {
        sidepanelState.contextData = null;
        sidepanelState.currentContextKey = "";
      }
      updateContextChip();
      if (plan.resetView) {
        deps.resetConversationView(plan.message as string);
      }
      return plan.returnValue;
    }

    // no-tab 之外的分支都刷新 liveTabUrl（error 亦然——迁移前行为：往返
    // 结束后即使失败也写入 tab.url）。
    sidepanelState.liveTabUrl = outcome.tabUrl || "";

    // 决策点二（消息往返之后）：「输入 → 动作」映射全部交给策略模块。unchanged
    // 信封折算成 policy 的响应形态；forceRefresh 只随策略透传，不参与动作判定；
    // isStreaming / hasPendingUserPrompt 是 chat-runtime 的纯闭包读取，此处
    // 取值时点不改变可观察行为。
    const resp = outcome.kind === "error"
      ? { ok: false as const, error: outcome.error }
      : { ok: true as const, payload: outcome.payload };

    const plan = resolveLoadContextAction({
      response: resp,
      hasPinnedConversation,
      silent,
      isStreaming: deps.isStreaming(),
      hasPendingUserPrompt: deps.hasPendingUserPrompt()
    });

    // 候选5：content 状态未变 → 保持现状不动（不 applyContextPayload、不重渲染、
    // 不刷新 live 快照、不转 spinner）。liveContextData 仍持有带 signature 的
    // 上次全量 payload：既是下一轮 ifSignature 的来源，也是等待轮询
    //（subtitle-wait）的判定数据源——返回 true 让轮询按旧快照继续判 pending，
    // ASR 完成时签名必然变化（subtitleFetchState/body.length），全量快照自然到位。
    if (plan.action === LOAD_CONTEXT_ACTION.SKIP_UNCHANGED) {
      return plan.returnValue;
    }

    if (plan.action === LOAD_CONTEXT_ACTION.ERROR) {
      sidepanelState.liveContextData = null;
      sidepanelState.liveContextKey = "";
      if (plan.clearContext) {
        sidepanelState.contextData = null;
        sidepanelState.currentContextKey = "";
      }
      updateContextChip();
      if (plan.resetView) {
        deps.resetConversationView(plan.message as string);
      }
      return plan.returnValue;
    }

    // 三个成功动作（pinned / 流式守卫 / live）的公共前缀：live 快照照常落地，
    // 保证轮询与补水的数据源不断供。
    sidepanelState.liveContextData = resp.payload as SidepanelContextSnapshot;
    sidepanelState.liveContextKey = buildContextKey(resp.payload as SidepanelContextSnapshot);

    // pinned 与流式守卫的执行体逐字节相同：只落地 live 快照，不进主上下文。
    if (
      plan.action === LOAD_CONTEXT_ACTION.APPLY_PINNED ||
      plan.action === LOAD_CONTEXT_ACTION.BLOCKED_STREAMING
    ) {
      deps.renderHistoryList();
      updateContextChip();
      return plan.returnValue;
    }

    // apply-live：正常路径，上下文变化时恢复最近对话并重渲染初始态。
    const contextChanged = applyContextPayload(resp.payload as SidepanelContextSnapshot | null);
    deps.renderHistoryList();
    if (contextChanged) {
      await deps.restoreLatest();
      deps.renderInitialState();
    }
    return plan.returnValue;
  }

  function applyContextPayload(payload: SidepanelContextSnapshot | null): boolean {
    const nextContext = payload && typeof payload === "object" ? payload : null;
    const nextKey = buildContextKey(nextContext);
    const contextChanged = Boolean(sidepanelState.currentContextKey && nextKey && nextKey !== sidepanelState.currentContextKey);

    sidepanelState.contextData = nextContext;
    sidepanelState.currentContextKey = nextKey;
    updateContextChip();

    if (contextChanged && !deps.isStreaming() && !deps.hasPendingUserPrompt()) {
      deps.restartChat({ keepContext: true });
    } else {
      deps.renderSuggestions();
    }
    return contextChanged;
  }

  function updateContextChip(): void {
    if (!sidepanelState.contextData) {
      contextChip.textContent = "无上下文";
      contextChip.title = "";
      contextChip.disabled = true;
      contextChip.classList.remove("is-mismatch");
      return;
    }

    // 标题不按字数硬截：chip 已占满 header 剩余宽度，溢出交给 CSS
    // text-overflow: ellipsis 按真实盒宽裁（短标题也能铺满整个 chip）。
    contextChip.textContent = sidepanelState.contextData.title || "未知视频";
    const mismatch = isBoundConversationMismatched();
    contextChip.classList.toggle("is-mismatch", mismatch);
    contextChip.title = sidepanelState.contextData.url
      ? `${sidepanelState.contextData.title || ""}${mismatch ? "\n当前页不是这个对话绑定的视频" : ""}\n点击跳转目标视频，或开启新对话`
      : sidepanelState.contextData.title || "";
    contextChip.disabled = !String(sidepanelState.contextData.url || "").trim();
  }

  function isBoundConversationMismatched(): boolean {
    if (sidepanelState.currentConversationMeta?.pinnedContext !== true) {
      return false;
    }
    const targetUrl = String(sidepanelState.currentConversationMeta?.contextUrl || sidepanelState.contextData?.url || "").trim();
    if (!targetUrl) {
      return false;
    }
    if (!sidepanelState.liveTabUrl) {
      return true;
    }
    return !doesTabMatchContextUrl(sidepanelState.liveTabUrl, targetUrl);
  }

  async function openCurrentContextUrl(): Promise<void> {
    if (!deps.getActiveTab) {
      return;
    }
    const targetUrl = String(sidepanelState.contextData?.url || sidepanelState.currentConversationMeta?.contextUrl || "").trim();
    if (!targetUrl) {
      return;
    }
    const tab = await deps.getActiveTab().catch(() => null);
    if (!tab?.id) {
      return;
    }
    try {
      const sameVideo = doesTabMatchContextUrl(tab.url || "", targetUrl);
      if (!sameVideo) {
        await chrome.tabs.update(tab.id, { url: targetUrl });
        await waitForTabComplete(tab.id);
      }
      await loadContextState({ forceRefresh: true, silent: true });
    } catch {}
  }

  return { loadContextState, updateContextChip, openCurrentContextUrl };
}
