// sidepanel-context-load.ts — 上下文状态加载与上下文 chip（候选5 自 sidepanel.ts
// 迁出）：loadContextState（读标签页状态 → 按策略动作执行编排副作用）、
// applyContextPayload、updateContextChip、isBoundConversationMismatched、
// openCurrentContextUrl。分支判定收敛在 ./sidepanel-context-policy.ts（纯函数，
// 继续直 import），本模块只负责拉数据、按动作执行。
//
// 依赖方向（无环）：共享可变状态（contextData / currentContextKey /
// liveContextData / liveContextKey / liveTabUrl / currentConversationMeta）直接
// import；getActiveTab、content 就绪/发送 transport（ensureReaderContentReady /
// sendMessageToTab——两者均经 deps 注入而非直 import，避免拖入带顶层 chrome
// 副作用的模块、保证 Node 测试可 evaluate）、waitForTabComplete / tabs.update、
// 渲染/编排回调（contextChip 的 DOM、renderHistoryList、resetConversationView、
// restartChat、renderSuggestions、restoreLatest、流式守卫判定 isStreaming /
// hasPendingUserPrompt 惰性互引 chatRuntime 实例）经工厂 deps 注入。本模块
// 不 import sidepanel.ts。
import { buildContextKey, doesTabMatchContextUrl } from "../ai/conversation.js";
import { truncate } from "../shared/string-utils.js";
import { getAiSidepanelState } from "../ai/context-resolver.js";
import { waitForTabComplete } from "../shared/tab-utils.js";
import {
  LOAD_CONTEXT_ACTION,
  isPinnedContextStrict,
  resolveLoadContextAction,
  resolveNoTabPlan
} from "./sidepanel-context-policy.js";
import { sidepanelState } from "./sidepanel-state.js";
import type { SidepanelContextSnapshot } from "./sidepanel-state.js";
import type { LoadContextStateOptions } from "./sidepanel-conversation-store.js";

// getAiSidepanelState 的响应信封（payload 为 content 侧上下文快照；缺省
// 字段由运行时真值判定兜底，这里断言 payload 不为 undefined）
interface SidepanelStateResponse {
  ok?: boolean;
  error?: unknown;
  payload: SidepanelContextSnapshot | null;
}

// getAiSidepanelState 的 tabOps 消息响应信封（对齐 context-resolver 的
// SidepanelContextResponse 结构；测试注入宽松桩）
interface TabStateResponse {
  ok?: boolean;
  unchanged?: boolean;
  payload?: Record<string, unknown>;
  error?: string;
  comments?: unknown[];
}

export interface CreateContextLoadDeps {
  getActiveTab: () => Promise<{ id?: number; url?: string } | null>;
  // getAiSidepanelState 的 tabOps（content 就绪 + 单发 tab 消息，生产组装点
  // 传 core/shared 的真实实现；签名对齐 context-resolver 的 EnsureReaderContentReady
  // / SendMessageToTab，测试注入宽松桩）
  ensureReaderContentReady: (tabId: number) => Promise<void>;
  sendMessageToTab: (tabId: number, message: Record<string, unknown>) => Promise<TabStateResponse>;
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
    const tab = await deps.getActiveTab();
    if (!tab?.id) {
      // 决策点一（消息往返之前）：无可用标签页，按计划做失败清理（文案/清上下文/
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

    const resp = await getAiSidepanelState(
      tab.id,
      {
        forceRefresh,
        // 候选5：带上次全量快照的签名，content 侧状态未变时一次往返即短路返回
        //（不重发整份字幕体、不拉热评）。forceRefresh=true 时 content 忽略签名，
        // 手动刷新语义不变。liveContextData 为空（首次/此前失败）时签名为空串，
        // content 必走全量。
        ifSignature: String(sidepanelState.liveContextData?.signature || "")
      },
      { ensureReaderContentReady: deps.ensureReaderContentReady, sendMessageToTab: deps.sendMessageToTab }
    )
      .then((payload) => ({ ok: true, payload }) as SidepanelStateResponse)
      .catch((error: unknown) => ({ ok: false, error: (error as Error).message }) as SidepanelStateResponse);
    sidepanelState.liveTabUrl = String(tab.url || "").trim();

    // 决策点二（消息往返之后）：「输入 → 动作」映射全部交给策略模块。forceRefresh
    // 只随消息透传给 content，不参与动作判定；isStreaming / hasPendingUserPrompt
    // 是 chat-runtime 的纯闭包读取，此处取值时点不改变可观察行为。
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
    sidepanelState.liveContextData = resp.payload;
    sidepanelState.liveContextKey = buildContextKey(resp.payload);

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
    const contextChanged = applyContextPayload(resp.payload);
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

    const shortTitle = sidepanelState.contextData.title ? truncate(sidepanelState.contextData.title, 19) : "未知视频";
    contextChip.textContent = shortTitle;
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
