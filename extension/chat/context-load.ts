// extension/chat/context-load.ts — 上下文状态加载编排壳与上下文 chip（候选5 自
// sidepanel.ts 迁出，PR5 自 pages/sidepanel-context-load.ts 迁入 chat 域并
// 改造；PR5c 随 sidepanel 摘除，chat/* 为对话内核唯一宿主）：
// loadContextState（拉上下文 → 按策略动作执行编排副作用）、applyContextPayload、
// updateContextChip、isBoundConversationMismatched、openCurrentContextUrl。
// 分支判定收敛在 ./context-policy.ts（纯函数，继续直 import），本模块只负责
// 拉数据、按动作执行。
//
// arch-slim/07 装配收口：「拉数据」的 ContextFetch 策略（扩展页消息链 /
// 进程内直读 / pinned 补水身份短路）连同 AiContext 装配知识一并迁往
// core/context-assembly.ts（core/context-payload 锚定的唯一装配链），本模块
// 退为纯编排壳——按信封动作执行副作用，不持有任何装配知识。生产组合根
//（reader/chat-tab.ts）注入进程内直读策略；测试可注入消息链策略。
//
// 依赖方向（无环）：共享可变状态（contextData / currentContextKey /
// liveContextData / liveContextKey / liveTabUrl / currentConversationMeta）直接
// import；上下文组装策略（fetchContext）与 openCurrentContextUrl 的 transport
//（getActiveTab——扩展页专属跳转，reader 壳可不注入）经工厂 deps 注入；
// 渲染/编排回调（contextChip 的 DOM、renderHistoryList、resetConversationView、
// restartChat、renderSuggestions、restoreLatest、流式守卫判定 isStreaming /
// hasPendingUserPrompt 惰性互引 chatRuntime 实例）同样经 deps 注入。本模块
// 不 import 组合根。
import { buildContextKey, doesTabMatchContextUrl } from "../ai/conversation.js";
import { waitForTabComplete } from "../shared/tab-utils.js";
import { LOAD_CONTEXT_ACTION, isPinnedContextStrict, resolveLoadContextAction, resolveNoTabPlan } from "./context-policy.js";
import { chatSessionState } from "./chat-state.js";
import type { ChatSessionContextSnapshot } from "./chat-state.js";
import type { ContextFetch, ContextFetchOutcome } from "../core/context-assembly.js";
import type { LoadContextStateOptions } from "./conversation-store.js";

// ===========================================================================
// loadContextState 编排壳（「按动作执行副作用」骨架与迁移前一致）
// ===========================================================================

export interface CreateContextLoadDeps {
  // 上下文组装策略（core/context-assembly 的 createMessageChainContextFetch /
  // createInProcessContextFetch）
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
    const hasPinnedConversation = isPinnedContextStrict(chatSessionState.currentConversationMeta);
    // 上下文组装策略注入点（PR5）。ifSignature 沿用迁移前口径：上次全量快照
    // 的签名；liveContextData 为空（首次/此前失败）时签名为空串，策略必走全量。
    const outcome = await deps
      .fetchContext({ forceRefresh, ifSignature: String(chatSessionState.liveContextData?.signature || "") })
      .catch((error: unknown) => ({ kind: "error", error: (error as Error)?.message }) as ContextFetchOutcome);

    if (outcome.kind === "no-tab") {
      // 决策点一（迁移前为 getActiveTab 落空即走，现由策略信封报告——getAiContextState
      // 同样不被调用）：无可用标签页，按计划做失败清理（文案/清上下文/
      // 重置视图的取舍全部来自策略计划）。
      const plan = resolveNoTabPlan({ hasPinnedConversation, silent });
      chatSessionState.liveContextData = null;
      chatSessionState.liveContextKey = "";
      chatSessionState.liveTabUrl = "";
      if (plan.clearContext) {
        chatSessionState.contextData = null;
        chatSessionState.currentContextKey = "";
      }
      updateContextChip();
      if (plan.resetView) {
        deps.resetConversationView(plan.message as string);
      }
      return plan.returnValue;
    }

    // no-tab 之外的分支都刷新 liveTabUrl（error 亦然——迁移前行为：往返
    // 结束后即使失败也写入 tab.url）。
    chatSessionState.liveTabUrl = outcome.tabUrl || "";

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
      chatSessionState.liveContextData = null;
      chatSessionState.liveContextKey = "";
      if (plan.clearContext) {
        chatSessionState.contextData = null;
        chatSessionState.currentContextKey = "";
      }
      updateContextChip();
      if (plan.resetView) {
        deps.resetConversationView(plan.message as string);
      }
      return plan.returnValue;
    }

    // 三个成功动作（pinned / 流式守卫 / live）的公共前缀：live 快照照常落地，
    // 保证轮询与补水的数据源不断供。
    chatSessionState.liveContextData = resp.payload as ChatSessionContextSnapshot;
    chatSessionState.liveContextKey = buildContextKey(resp.payload as ChatSessionContextSnapshot);

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
    const contextChanged = applyContextPayload(resp.payload as ChatSessionContextSnapshot | null);
    deps.renderHistoryList();
    if (contextChanged) {
      await deps.restoreLatest();
      deps.renderInitialState();
    }
    return plan.returnValue;
  }

  function applyContextPayload(payload: ChatSessionContextSnapshot | null): boolean {
    const nextContext = payload && typeof payload === "object" ? payload : null;
    const nextKey = buildContextKey(nextContext);
    const contextChanged = Boolean(chatSessionState.currentContextKey && nextKey && nextKey !== chatSessionState.currentContextKey);

    chatSessionState.contextData = nextContext;
    chatSessionState.currentContextKey = nextKey;
    updateContextChip();

    if (contextChanged && !deps.isStreaming() && !deps.hasPendingUserPrompt()) {
      deps.restartChat({ keepContext: true });
    } else {
      deps.renderSuggestions();
    }
    return contextChanged;
  }

  function updateContextChip(): void {
    if (!chatSessionState.contextData) {
      contextChip.textContent = "无上下文";
      contextChip.title = "";
      contextChip.disabled = true;
      contextChip.classList.remove("is-mismatch");
      return;
    }

    // 标题不按字数硬截：chip 已占满 header 剩余宽度，溢出交给 CSS
    // text-overflow: ellipsis 按真实盒宽裁（短标题也能铺满整个 chip）。
    contextChip.textContent = chatSessionState.contextData.title || "未知视频";
    const mismatch = isBoundConversationMismatched();
    contextChip.classList.toggle("is-mismatch", mismatch);
    contextChip.title = chatSessionState.contextData.url
      ? `${chatSessionState.contextData.title || ""}${mismatch ? "\n当前页不是这个对话绑定的视频" : ""}\n点击跳转目标视频，或开启新对话`
      : chatSessionState.contextData.title || "";
    contextChip.disabled = !String(chatSessionState.contextData.url || "").trim();
  }

  function isBoundConversationMismatched(): boolean {
    if (chatSessionState.currentConversationMeta?.pinnedContext !== true) {
      return false;
    }
    const targetUrl = String(chatSessionState.currentConversationMeta?.contextUrl || chatSessionState.contextData?.url || "").trim();
    if (!targetUrl) {
      return false;
    }
    if (!chatSessionState.liveTabUrl) {
      return true;
    }
    return !doesTabMatchContextUrl(chatSessionState.liveTabUrl, targetUrl);
  }

  async function openCurrentContextUrl(): Promise<void> {
    if (!deps.getActiveTab) {
      return;
    }
    const targetUrl = String(chatSessionState.contextData?.url || chatSessionState.currentConversationMeta?.contextUrl || "").trim();
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
