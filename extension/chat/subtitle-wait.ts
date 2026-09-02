// extension/chat/subtitle-wait.ts — 一键总结「等待抓取/音频转写完成」的轮询状态机。
//
// 从 sidepanel.js 提取（与 chat-runtime 同一套拆分手法；PR5 自
// extension/pages/sidepanel-subtitle-wait.ts 迁入 chat 域，逻辑零语义改动）：
// 组合根只负责组装 deps，本模块拥有轮询/失效/清理的全部时序状态。模块顶层零
// 副作用，可在 Node 测试环境直接 evaluate（见 tests/chat/subtitle-wait.test.js）。
//
// 为什么存在：一键总结发送前若 content 侧正在抓取或做小时级 ASR 转写
// （subtitleFetchState === "loading" 且字幕体为空），把空 subtitleBody 直接发
// 给模型会让它凭标题+热评编造"无公开字幕"的总结。这里等待上下文就绪再放行
// 发送流程，轮询为主，content 的 boc-subtitle-status 广播（asr-done/asr-failed）
// 到达时由 sidepanel 调 kick() 立即补一轮。
//
// 时序约定（测试锁定，改动前先读）：
//   - wait() 重复触发：新等待使旧等待立即 resolve false（最后一次发送生效）；
//   - kick() 与轮询去重：同一时刻最多一轮 pollContext 在跑；
//   - finish（就绪/失败/失效）后挂着的定时器必须作废，notice 必须清理。

import type { ChatSessionContextSnapshot } from "./chat-state.js";

// 「上下文是否仍在抓取/转写中」的判定（sidepanel 组装 pollContext 用，纯函数可测）。
// 两个信号缺一不可互为兜底：
//   - 快照的 subtitleFetchState：主信号。content 侧在转写进行中也可能因辅助
//     抓取失败等边界把状态清掉（历史上 resetClipState 置 idle 曾导致提前放行
//     空字幕、模型编造"无公开字幕"总结）；
//   - asrTranscribingActive：兜底信号。sidepanel 收到 content 的
//     boc-subtitle-status(asr-transcribing) 广播置 true，收到 asr-done/asr-failed
//     置 false。转写广播仍活跃时，即使快照状态被清也继续等待。
// 字幕体非空即视为就绪，不受上述信号影响。
export function isContextPending(
  snapshot: ChatSessionContextSnapshot | null | undefined,
  { asrTranscribingActive = false }: { asrTranscribingActive?: boolean } = {}
): boolean {
  if (!snapshot) {
    return false;
  }
  const body = Array.isArray(snapshot.subtitleBody) ? snapshot.subtitleBody : [];
  if (body.length > 0) {
    return false;
  }
  return snapshot.subtitleFetchState === "loading" || asrTranscribingActive === true;
}

export interface CreateSubtitleWaiterDeps {
  pollContext: () => Promise<{ ok: boolean; pending: boolean }>;
  showWaitingNotice: () => void;
  removeNotice: () => void;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
  pollIntervalMs: number;
}

export interface SubtitleWaiter {
  wait: () => Promise<boolean>;
  kick: () => void;
}

/**
 * createSubtitleWaiter(deps) — 工厂返回轮询状态机。
 *
 * deps 语义（与迁移前 JSDoc 一致）：
 *   pollContext:      () => Promise<{ok: boolean, pending: boolean}>
 *                     sidepanel 组装：loadContextState(silent) + contextData 的
 *                     subtitleFetchState/subtitleBody 折算成「读取成败 + 是否仍在抓取/转写」。
 *   showWaitingNotice: () => void     等待期间的用户提示（消息区一条 notice）。
 *   removeNotice:      () => void     finish 时清理提示。
 *   setTimer / clearTimer:             可注入定时器（测试手动推进）。
 *   pollIntervalMs:    number         轮询间隔。
 */
export function createSubtitleWaiter(deps: CreateSubtitleWaiterDeps): SubtitleWaiter {
  const {
    pollContext,
    showWaitingNotice,
    removeNotice,
    setTimer,
    clearTimer,
    pollIntervalMs
  } = deps;

  // 单调等待代币：只认最新一次 wait()，旧等待在 finish 前先失效
  let token = 0;
  let activeFinish: ((ok: boolean) => void) | null = null;
  let kickCurrent: (() => void) | null = null;

  function wait(): Promise<boolean> {
    if (activeFinish) {
      activeFinish(false);
    }
    return new Promise((resolve) => {
      let timer: number | null = null;
      let ticking = false;
      const currentToken = ++token;
      const finish = (ok: boolean) => {
        if (currentToken !== token) {
          return;
        }
        activeFinish = null;
        kickCurrent = null;
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        removeNotice();
        resolve(ok);
      };
      activeFinish = finish;
      const tick = async () => {
        if (ticking) {
          return;
        }
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        ticking = true;
        try {
          const outcome = await pollContext();
          if (currentToken !== token) {
            return;
          }
          if (!outcome?.ok) {
            finish(false);
            return;
          }
          if (!outcome.pending) {
            finish(true);
            return;
          }
          showWaitingNotice();
          timer = setTimer(() => {
            timer = null;
            void tick();
          }, pollIntervalMs);
        } finally {
          ticking = false;
        }
      };
      kickCurrent = () => {
        if (currentToken === token) {
          void tick();
        }
      };
      void tick();
    });
  }

  return {
    wait,
    kick: () => {
      if (kickCurrent) {
        kickCurrent();
      }
    }
  };
}
