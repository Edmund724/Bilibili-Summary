// sidepanel-subtitle-wait.js — 一键总结「等待抓取/音频转写完成」的轮询状态机。
//
// 从 sidepanel.js 提取（与 sidepanel-chat-runtime 同一套拆分手法）：sidepanel
// 只负责组装 deps，本模块拥有轮询/失效/清理的全部时序状态。模块顶层零副作用，
// 可在 Node 测试环境直接 evaluate（见 tests/sidepanel/subtitle-wait.test.js）。
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

/**
 * @param {object} deps
 *   pollContext:      () => Promise<{ok: boolean, pending: boolean}>
 *                     sidepanel 组装：loadContextState(silent) + contextData 的
 *                     subtitleFetchState/subtitleBody 折算成「读取成败 + 是否仍在抓取/转写」。
 *   showWaitingNotice: () => void     等待期间的用户提示（消息区一条 notice）。
 *   removeNotice:      () => void     finish 时清理提示。
 *   setTimer / clearTimer:             可注入定时器（测试手动推进）。
 *   pollIntervalMs:    number         轮询间隔。
 * @returns {{
 *   wait: () => Promise<boolean>,  // true=上下文就绪可发送；false=读取失败或被新等待顶掉
 *   kick: () => void               // 广播到达时提前触发一轮轮询（无等待时no-op）
 * }}
 */
export function createSubtitleWaiter(deps) {
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
  let activeFinish = null;
  let kickCurrent = null;

  function wait() {
    if (activeFinish) {
      activeFinish(false);
    }
    return new Promise((resolve) => {
      let timer = null;
      let ticking = false;
      const currentToken = ++token;
      const finish = (ok) => {
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
