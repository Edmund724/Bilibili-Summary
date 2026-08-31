// ladder.ts — 聊天「阶梯」分派策略（ADR-0001）的深模块：
// 预算内单次流式 → 超预算 Map-Reduce 分段编排（含追问压缩、成本护栏）→
// 单次溢出转 Map-Reduce 重试一次。所有依赖经 deps 注入（含 postMessage
// 所用的 port），便于在无 chrome 环境下逐分支注入 fake 做测试。
// offscreen.js 只负责接线：abort controller、空闲超时、cost-guard Promise 簿记。
// 溢出语义（候选 03 起）：streamChat 仅在 context-length 溢出时抛带
// .overflow 标记的错误，本模块 catch 查标记分流；其余失败经 port error 回吐。
import { streamChat as _streamChat } from "./client.js";
import { buildBudgetPlan as _buildBudgetPlan } from "./budgeter.js";
import { orchestrateMapReduce as _orchestrateMapReduce } from "./map-reduce.js";
import { resolveFollowupContext as _resolveFollowupContext } from "./followup-router.js";
import { trimRecentTurns as _trimRecentTurns } from "./followup-context.js";
import { buildCostGuardNotice as _buildCostGuardNotice } from "./cost-guard.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatContext {
  subtitleBody?: unknown[];
  chapters?: unknown[];
  [key: string]: unknown;
}

export interface ChatMsg {
  context?: ChatContext;
  history?: ChatMessage[];
  prompt?: string;
  thinkingLevel?: string;
  [key: string]: unknown;
}

export interface ChatProvider {
  id?: string;
  apiKey?: string;
  [key: string]: unknown;
}

export interface ChatPort {
  postMessage(message: unknown): void;
}

export interface BudgetPlan {
  mode: "single" | "map-reduce";
  estimatedCalls?: number;
  estimatedTokens?: number;
}

export interface StreamChatArgs {
  provider: ChatProvider;
  context: ChatContext;
  userPrompt: string;
  history: ChatMessage[];
  thinkingLevel?: string;
  port: ChatPort;
  signal: AbortSignal | string | null;
  onActivity?: () => void;
}

export type StreamChatFn = (args: StreamChatArgs) => Promise<unknown>;

export interface OrchestrateMapReduceArgs {
  provider: ChatProvider;
  context: ChatContext;
  plan: BudgetPlan;
  port: ChatPort;
  signal: AbortSignal | string | null;
  thinkingLevel?: string;
  onProgress: (notice: string) => void;
}

export type OrchestrateMapReduceFn = (args: OrchestrateMapReduceArgs) => Promise<unknown>;

export interface ResolveFollowupContextArgs {
  context: ChatContext;
  plan: BudgetPlan;
  history: ChatMessage[];
  userPrompt: string;
}

export type ResolveFollowupContextFn = (args: ResolveFollowupContextArgs) => Promise<ChatContext | null>;

export type BuildBudgetPlanFn = (args: { body: unknown[]; chapters: unknown[] }) => BudgetPlan;

export interface CostGuardNotice {
  shouldPrompt: boolean;
  message: string;
}

export type BuildCostGuardNoticeFn = (args: { estimatedCalls?: number; estimatedTokens?: number }) => CostGuardNotice;

export type TrimRecentTurnsFn = (history?: ChatMessage[]) => ChatMessage[];

export interface RunLadderChatArgs {
  msg: ChatMsg;
  provider: ChatProvider;
  port: ChatPort;
  signal: AbortSignal | string | null;
}

export interface RunLadderChatDeps {
  streamChat?: StreamChatFn;
  orchestrateMapReduce?: OrchestrateMapReduceFn;
  resolveFollowupContext?: ResolveFollowupContextFn;
  buildBudgetPlan?: BuildBudgetPlanFn;
  buildCostGuardNotice?: BuildCostGuardNoticeFn;
  trimRecentTurns?: TrimRecentTurnsFn;
  askCostGuard: (port: ChatPort, message: string) => Promise<unknown>;
  onActivity?: () => void;
  pauseIdleTimeout?: () => void;
}

/**
 * 执行阶梯分派。args：
 * - msg: offscreen-chat 端口收到的 chat 消息（context / history / prompt / thinkingLevel）
 * - provider: 已注入 apiKey 的 provider 对象
 * - port: 回吐 notice / error / stopped 的端口
 * - signal: 本次请求的 AbortSignal（由 offscreen 的 abort controller 提供）
 * deps：streamChat / orchestrateMapReduce / resolveFollowupContext / buildBudgetPlan /
 *       buildCostGuardNotice / trimRecentTurns / askCostGuard，以及两个簿记回调：
 * - onActivity(): 收到流式活动时重挂空闲超时（offscreen.armIdleTimeout）
 * - pauseIdleTimeout(): 等待用户成本确认期间暂停空闲超时计时
 * 全部可注入（默认用真实模块），便于在无 chrome 环境下逐分支注入 fake 做测试；
 * askCostGuard 依赖 offscreen 的 Promise 簿记，必须由 offscreen 注入。
 */
export async function runLadderChat(
  { msg, provider, port, signal }: RunLadderChatArgs,
  deps: RunLadderChatDeps
): Promise<void> {
  const streamChat: StreamChatFn = deps.streamChat ?? (_streamChat as unknown as StreamChatFn);
  const orchestrateMapReduce: OrchestrateMapReduceFn = deps.orchestrateMapReduce ?? (_orchestrateMapReduce as unknown as OrchestrateMapReduceFn);
  const resolveFollowupContext: ResolveFollowupContextFn = deps.resolveFollowupContext ?? (_resolveFollowupContext as unknown as ResolveFollowupContextFn);
  const buildBudgetPlan: BuildBudgetPlanFn = deps.buildBudgetPlan ?? (_buildBudgetPlan as unknown as BuildBudgetPlanFn);
  const buildCostGuardNotice: BuildCostGuardNoticeFn = deps.buildCostGuardNotice ?? (_buildCostGuardNotice as unknown as BuildCostGuardNoticeFn);
  const trimRecentTurns: TrimRecentTurnsFn = deps.trimRecentTurns ?? (_trimRecentTurns as unknown as TrimRecentTurnsFn);
  const { askCostGuard, onActivity, pauseIdleTimeout } = deps;

  // 阶梯分派：预算内（≤100k token）走单次流式；超预算走 Map-Reduce 分段编排。
  const plan = buildBudgetPlan({
    body: Array.isArray(msg.context?.subtitleBody) ? msg.context.subtitleBody : [],
    chapters: Array.isArray(msg.context?.chapters) ? msg.context.chapters : []
  });
  if (plan.mode === "map-reduce") {
    // 追问压缩：已有成稿笔记 + 分段小结时，改走「压缩摘要 + 检索注入 + 单次调用」，
    // 不再重跑 Map-Reduce（token 随追问近乎常数）。
    const followupContext = await resolveFollowupContext({
      context: msg.context || {},
      plan,
      history: Array.isArray(msg.history) ? msg.history : [],
      userPrompt: msg.prompt || ""
    });
    if (followupContext) {
      // 近 N 轮 verbatim 封顶：只带最近几轮历史，token 不随追问轮数增长。
      const trimmedHistory = trimRecentTurns(msg.history);
      try {
        await streamChat({
          provider,
          context: followupContext,
          userPrompt: msg.prompt || "",
          history: trimmedHistory,
          thinkingLevel: msg.thinkingLevel,
          port,
          signal,
          onActivity
        });
      } catch (e) {
        // 兜底：压缩摘要 + 检索注入仍意外溢出（HTTP context-length）时，绝不静默无输出。
        // streamChat 仅在溢出时抛带 .overflow 标记的错误（其余失败经 port error 回吐）。
        if (!(e as { overflow?: boolean }).overflow) {
          throw e;
        }
        port.postMessage({ type: "error", error: "追问内容仍超出上下文预算，请换个更具体的问题重试" });
      }
      return;
    }

    // 成本护栏：发起 Map-Reduce 前预估 ≥5 次调用 → 弹确认，可取消。
    const guard = buildCostGuardNotice({
      estimatedCalls: plan.estimatedCalls,
      estimatedTokens: plan.estimatedTokens
    });
    if (guard.shouldPrompt) {
      // 等待用户确认期间暂停空闲超时计时，确认后重新武装。
      pauseIdleTimeout?.();
      const confirmed = Boolean(await askCostGuard(port, guard.message));
      if (!confirmed) {
        port.postMessage({ type: "stopped", reason: "已取消" });
        return;
      }
      onActivity?.();
    }

    await orchestrateMapReduce({
      provider,
      context: msg.context || {},
      plan,
      port,
      signal,
      thinkingLevel: msg.thinkingLevel,
      onProgress: function (notice: string) {
        // 进度回吐 + 每段完成重挂空闲超时（覆盖下一段模型调用）
        port.postMessage({ type: "notice", data: notice });
        onActivity?.();
      }
    });
    return;
  }

  // 单次路径 context-length 溢出 → 自动转 Map-Reduce 重试一次
  //（仅一次：map-reduce 各调用自身更短，再溢出就抛出错误；abort controller 复用，stop 仍可中止）。
  // streamChat 仅在溢出（预算内超限 / HTTP context-length）时抛带 .overflow 标记的错误。
  try {
    await streamChat({
      provider,
      context: msg.context || {},
      userPrompt: msg.prompt || "",
      history: Array.isArray(msg.history) ? msg.history : [],
      thinkingLevel: msg.thinkingLevel,
      port,
      signal,
      onActivity
    });
  } catch (e) {
    if (!(e as { overflow?: boolean }).overflow) {
      throw e;
    }
    await orchestrateMapReduce({
      provider,
      context: msg.context || {},
      plan,
      port,
      signal,
      thinkingLevel: msg.thinkingLevel,
      onProgress: function (notice: string) {
        // 进度回吐 + 每段完成重挂空闲超时（覆盖下一段模型调用）
        port.postMessage({ type: "notice", data: notice });
        onActivity?.();
      }
    });
  }
}
