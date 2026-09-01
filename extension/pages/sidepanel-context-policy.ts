// sidepanel-context-policy.ts — loadContextState 的分支判定纯函数（候选08，可测）。
//
// 为什么存在：sidepanel.js 的 loadContextState 把「签名短路 / pinned / streaming
// 守卫 / live 快照应用」四态判定交错在带副作用的编排里（消息往返、setState、
// 渲染），分支组合零直测。本模块只做「输入 → 动作」映射：不做任何 I/O、
// 不写 sidepanelState、不渲染；编排壳（sidepanel.js 的 loadContextState /
// ensureCurrentContextForSend）负责拉数据、按动作执行，可观察行为逐字节不变。
//
// 动作与旧分支的对应（旧代码真实分支顺序，判定优先级自上而下）：
//   no-tab            !tab?.id                    （消息往返之前，由 resolveNoTabPlan 给出）
//   skip-unchanged    resp.ok && payload.unchanged === true
//   error             !resp.ok || !resp.payload
//   apply-pinned      有 pinned 对话（优先于流式守卫）
//   blocked-streaming chatRuntime 流式中或有待发送 prompt
//   apply-live        以上皆否：live 快照落地并应用到主上下文

// ai-sidepanel-get-state 的响应信封（sendRuntimeMessage 结果经编排壳收窄；
// payload 为 content 侧的上下文快照，本模块只读其 unchanged 信封字段）。
export interface LoadContextResponse {
  ok?: boolean;
  error?: unknown;
  payload?: { unchanged?: unknown; [key: string]: unknown } | null;
}

// 会话绑定判定输入（sidepanelState.currentConversationMeta 的窄视图）
export interface CurrentConversationMetaLike {
  pinnedContext?: unknown;
  [key: string]: unknown;
}

// 动作枚举：loadContextState 一次调用可能采取的全部动作（编排壳据此执行）。
export const LOAD_CONTEXT_ACTION = Object.freeze({
  NO_TAB: "no-tab",
  SKIP_UNCHANGED: "skip-unchanged",
  ERROR: "error",
  APPLY_PINNED: "apply-pinned",
  BLOCKED_STREAMING: "blocked-streaming",
  APPLY_LIVE: "apply-live"
} as const);

// 动作计划（resolveNoTabPlan / resolveLoadContextAction 的输出形态）。
// 可选字段只在其动作需要时出现，与旧分支的返回对象逐字段一致。
export interface LoadContextPlan {
  action: (typeof LOAD_CONTEXT_ACTION)[keyof typeof LOAD_CONTEXT_ACTION];
  clearTabUrl?: boolean;
  clearContext?: boolean;
  resetView?: boolean;
  message?: unknown;
  returnValue: boolean;
  applyToMainContext?: boolean;
}

// 失败分支的用户可见文案（loadContextState 的兜底与 ensureCurrentContextForSend
// 的三次失败闸共用同一句，收敛为常量防漂移）。
export const NO_TAB_MESSAGE = "找不到当前标签页。";
export const CONTEXT_READ_FAILED_MESSAGE = "当前页面上下文读取失败。";

// pinned 判定（疑义记录，本轮不改行为）：loadContextState 用严格相等
//（pinnedContext === true），ensureCurrentContextForSend 用真值判断。当前
// conversation-store 只会写入字面量 true，两者实际等价，但严格度不同是历史
// 现状——为保证行为逐字节保持，分别提供两个谓词，调用点各用其原始语义。
export function isPinnedContextStrict(currentConversationMeta: CurrentConversationMetaLike | null | undefined): boolean {
  return currentConversationMeta?.pinnedContext === true;
}

export function isPinnedContextTruthy(currentConversationMeta: CurrentConversationMetaLike | null | undefined): boolean {
  return Boolean(currentConversationMeta?.pinnedContext);
}

// 决策点一（消息往返之前）：无可用标签页。此时不能发 ai-sidepanel-get-state
//（tabId 缺失），直接走失败清理。clearTabUrl 为 true：no-tab 分支连 liveTabUrl
// 一起清（error 分支刚用 tab.url 刷新过它，故为 false，见 resolveLoadContextAction）。
export function resolveNoTabPlan({ hasPinnedConversation = false, silent = false } = {}): LoadContextPlan {
  return {
    action: LOAD_CONTEXT_ACTION.NO_TAB,
    clearTabUrl: true,
    // pinned 对话的主上下文（contextData/currentContextKey）被对话锁定，不清
    clearContext: !hasPinnedConversation,
    // 静默轮询（silent）不打扰消息区；pinned 对话同样不重置视图
    resetView: !silent && !hasPinnedConversation,
    message: NO_TAB_MESSAGE,
    returnValue: false
  };
}

// 决策点二（消息往返之后）：按响应分类 + 运行时标志给出动作计划。
// 输入全部来自编排壳已拉到的数据：
//   response              sendRuntimeMessage 的结果（含 .catch 兜底对象，可为 null）
//   hasPinnedConversation isPinnedContextStrict(sidepanelState.currentConversationMeta)
//   silent                loadContextState 的静默标志（轮询/补水路径为 true）
//   isStreaming           chatRuntime.isStreaming()
//   hasPendingUserPrompt  chatRuntime.hasPendingUserPrompt()
// 输出计划字段：
//   clearTabUrl         是否连 liveTabUrl 一起清（仅 no-tab 为 true）
//   clearContext        失败时是否连主上下文一起清（!pinned）
//   resetView / message 失败时是否 resetConversationView 及所用文案
//   applyToMainContext  成功时 live 快照是否进一步应用到主上下文
//                      （pinned / 流式守卫为 false：只落地 live 快照）
//   returnValue         loadContextState 的返回值契约
export interface ResolveLoadContextActionOptions {
  response?: LoadContextResponse | null;
  hasPinnedConversation?: boolean;
  silent?: boolean;
  isStreaming?: boolean;
  hasPendingUserPrompt?: boolean;
}

export function resolveLoadContextAction({
  response = null,
  hasPinnedConversation = false,
  silent = false,
  isStreaming = false,
  hasPendingUserPrompt = false
}: ResolveLoadContextActionOptions = {}): LoadContextPlan {
  // 候选5：content 状态未变 → 保持现状不动（不 applyContextPayload、不重渲染、
  // 不刷新 live 快照、不转 spinner）。liveContextData 仍持有带 signature 的
  // 上次全量 payload：既是下一轮 ifSignature 的来源，也是等待轮询
  // （subtitle-wait）的判定数据源——返回 true 让轮询按旧快照继续判 pending，
  // ASR 完成时签名必然变化（subtitleFetchState/body.length），全量快照自然到位。
  // 注意 unchanged 是严格 === true（真值但非 true 的字段不构成短路）。
  if (response?.ok && response?.payload?.unchanged === true) {
    return { action: LOAD_CONTEXT_ACTION.SKIP_UNCHANGED, returnValue: true };
  }

  // 往返失败 / 无 payload：清 live 快照（pinned 对话保留主上下文），非静默且
  // 非 pinned 时重置消息区视图。message 透传响应里的 error（可为任意真值，
  // 与旧代码一致不做 String 化），缺失时落到通用文案。
  if (!response?.ok || !response.payload) {
    return {
      action: LOAD_CONTEXT_ACTION.ERROR,
      clearTabUrl: false,
      clearContext: !hasPinnedConversation,
      resetView: !silent && !hasPinnedConversation,
      message: response?.error || CONTEXT_READ_FAILED_MESSAGE,
      returnValue: false
    };
  }

  // pinned 对话：live 快照只做数据源（轮询判定 / 后续补水），不进主上下文、
  // 不触发对话恢复；旧代码此分支与流式守卫分支的执行体逐字节相同。
  if (hasPinnedConversation) {
    return { action: LOAD_CONTEXT_ACTION.APPLY_PINNED, applyToMainContext: false, returnValue: true };
  }

  // 流式守卫：回复渲染中或有待发送 prompt 时冻结主上下文，避免中途换上下文
  // 打断进行中的对话；live 快照照常落地供后续使用。
  if (isStreaming || hasPendingUserPrompt) {
    return { action: LOAD_CONTEXT_ACTION.BLOCKED_STREAMING, applyToMainContext: false, returnValue: true };
  }

  // 正常路径：live 快照落地并应用到主上下文；上下文变化时由编排壳恢复最近
  // 对话并重渲染初始态（applyContextPayload 的返回值决定）。
  return { action: LOAD_CONTEXT_ACTION.APPLY_LIVE, applyToMainContext: true, returnValue: true };
}
