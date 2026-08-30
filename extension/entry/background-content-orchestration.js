// background-content-orchestration.js — SW 侧「content 注入恢复 + 触发重试」编排。
//
// 从 entry/background.js 提取（拆分手法同 pages/sidepanel-subtitle-wait.js）：
// background 只组装真实 chrome API（版本探针 / 资源注入 / 整页 reload / 消息
// 收发 / URL 二次确认）传入工厂，本模块拥有全部时序与错误分类决策。模块顶层
// 零 chrome 依赖（仅 shared/utils 的 sleep 作默认延时、shared 的错误哨兵常量），
// 可在 Node 测试环境直接 evaluate（tests/entry/background-orchestration.test.js
// 用 vi.useFakeTimers 锁定下列时序契约，改动前先读）：
//   - 探针单发失败/空版本按 probeAttempts×probeRetryDelayMs 重试（默认 3×100ms），
//     全程落空返回空串（=「未读到版本」）；
//   - 注入后就绪轮询 readyPolls 次（默认 5），首轮不等、其余间隔
//     readyPollIntervalMs（默认 150ms）；
//   - 轮询耗尽且此前读到过「旧版本」→ 整页 reload + 等 tab complete +
//     停顿 reloadSettleDelayMs（默认 120ms）+ 再注入 + 再轮询；二次耗尽抛
//     「扩展脚本未能和当前页面同步…」；探针全程无版本则跳过 reload 直接抛；
//   - 注入报错命中 DUPLICATE_CLASSIC_INJECTION_SENTINEL（浏览器对重复 classic
//     注入抛出的全局词法冲突，非代码主动 throw）视为「已注入」吞掉，其余上抛；
//   - 触发阅读视图按 triggerRetries×triggerRetryDelayMs（默认 12×300ms）重试，
//     仅「Receiving end does not exist」一类错误走「确保 content 就绪」兜底
//     （兜底失败不中止重试）；关闭阅读视图同节奏重试，错误一律静默并每轮按
//     URL 的 boc_reader 参数二次确认。

import { sleep } from "../shared/utils.js";
import {
  DUPLICATE_CLASSIC_INJECTION_SENTINEL,
  RECEIVING_END_MISSING_SENTINEL
} from "../shared/content-error-sentinels.js";

/**
 * 创建 background 侧 content 注入恢复编排（返回闭包函数，无共享可变状态）。
 *
 * @param {object} deps
 *   单发副作用（background 接线注入真实 chrome API，均以 tabId 为首参）：
 *     probeOnce:          () => Promise<string>  单发版本探针：读页面 content 版本
 *                         哨兵，空串=未读到；API 抛错由编排吞掉重试。
 *     injectAssets:       () => Promise<void>    单发资源注入（CSS + classic
 *                         bootstrap），注入错误原样抛给编排做哨兵分类。
 *     reloadTab:          () => Promise<void>    整页 reload。
 *     waitForTabComplete: (tabId, { polls }) => Promise<boolean>  等 tab 加载完成
 *                         （shared/tab-utils.js，轮询耗尽返回 false）。
 *     sendMessageToTab:   (tabId, message) => Promise<object>  向 tab 发消息。
 *     isTabReaderModeOff: () => Promise<boolean>  按 URL 的 boc_reader 参数判定
 *                         是否已退出阅读视图。
 *     canInject:          (tabId) => boolean  注入前置守卫（scripting 能力可用
 *                         且 tabId 有效；为假时 ensureReaderContentReady 直接返回）。
 *     expectedVersion:    string  期望 content 版本（= SW 侧 manifest version）。
 *   时序参数（默认值 = 现网行为）：
 *     delay = sleep, probeAttempts = 3, probeRetryDelayMs = 100,
 *     readyPolls = 5, readyPollIntervalMs = 150, reloadWaitPolls = 40,
 *     reloadSettleDelayMs = 120, triggerRetries = 12, triggerRetryDelayMs = 300
 * @returns {{
 *   ensureReaderContentReady: (tabId) => Promise<void>,
 *   probeContentScriptVersion: (tabId) => Promise<string>,
 *   injectReaderContent: (tabId) => Promise<void>,
 *   triggerReaderModeInTab: (tabId, readerUrl?, retries?, delayMs?) => Promise<boolean>,
 *   triggerReaderModeCloseInTab: (tabId, retries?, delayMs?) => Promise<boolean>
 * }}
 */
export function createBackgroundContentOrchestrator(deps) {
  const {
    probeOnce,
    injectAssets,
    reloadTab,
    waitForTabComplete,
    sendMessageToTab,
    isTabReaderModeOff,
    canInject,
    expectedVersion,
    delay = sleep,
    probeAttempts = 3,
    probeRetryDelayMs = 100,
    readyPolls = 5,
    readyPollIntervalMs = 150,
    reloadWaitPolls = 40,
    reloadSettleDelayMs = 120,
    triggerRetries = 12,
    triggerRetryDelayMs = 300
  } = deps;

  // 版本探针（带重试）：单发失败或拿到空版本都再试，最多 probeAttempts 次、
  // 间隔 probeRetryDelayMs；全程落空返回空串，由调用方按「未读到版本」处理。
  async function probeContentScriptVersion(tabId) {
    for (let attempt = 0; attempt < probeAttempts; attempt++) {
      try {
        const version = await probeOnce(tabId);
        if (version) {
          return version;
        }
      } catch {
        // ignore probe failures
      }
      if (attempt < probeAttempts - 1) {
        await delay(probeRetryDelayMs);
      }
    }
    return "";
  }

  // 资源注入（CSS + classic bootstrap）。重复 classic 注入会让浏览器抛全局
  // 词法冲突（DUPLICATE_CLASSIC_INJECTION_SENTINEL，由引擎生成、非代码主动
  // throw），该情况等同「已注入」吞掉；其余错误原样上抛。
  async function injectReaderContent(tabId) {
    try {
      await injectAssets(tabId);
    } catch (error) {
      const message = String(error?.message || "");
      if (!message.includes(DUPLICATE_CLASSIC_INJECTION_SENTINEL)) {
        throw error;
      }
    }
  }

  // 注入后的就绪轮询：readyPolls 次（首轮不等、其余间隔 readyPollIntervalMs），
  // 读到期望版本返回 true，耗尽返回 false（善后归调用方）。
  async function pollContentReady(tabId) {
    for (let attempt = 0; attempt < readyPolls; attempt++) {
      if (attempt > 0) {
        await delay(readyPollIntervalMs);
      }
      const version = await probeContentScriptVersion(tabId);
      if (version === expectedVersion) {
        return true;
      }
    }
    return false;
  }

  // 主编排：确保目标 tab 的 content 主包与当前扩展版本一致。
  // 路径：版本一致 → 直接就绪；不一致 → 注入 → 轮询；仍失败且此前读到过
  // 「旧版本」（扩展更新版本偏斜）→ 整页 reload + 等加载完 + 补注入 + 再轮询；
  // 二次耗尽抛错。探针全程拿不到版本说明页面没跑过任何 content script，
  // reload 救不了，同样落到最终抛错。
  async function ensureReaderContentReady(tabId) {
    if (!canInject(tabId)) {
      return;
    }

    const loadedVersion = await probeContentScriptVersion(tabId);
    if (loadedVersion === expectedVersion) {
      return;
    }

    await injectReaderContent(tabId);
    if (await pollContentReady(tabId)) {
      return;
    }

    if (loadedVersion && loadedVersion !== expectedVersion) {
      await reloadTab(tabId);
      const ready = await waitForTabComplete(tabId, { polls: reloadWaitPolls });
      if (!ready) {
        throw new Error("扩展更新后页面未及时恢复，请刷新浏览器网页重试");
      }
      await delay(reloadSettleDelayMs);
      await injectReaderContent(tabId);
      if (await pollContentReady(tabId)) {
        return;
      }
    }

    throw new Error("扩展脚本未能和当前页面同步，请刷新浏览器网页重试");
  }

  // 触发阅读视图：triggerRetries×triggerRetryDelayMs 重试。仅「Receiving end
  // does not exist」一类错误（content 尚未挂上接收端）才走「确保 content 就绪」
  // 兜底后重试（兜底失败不中止）；其余错误与 ok:false 响应静默进入下一轮。
  // 全部耗尽返回 false（调用方给出用户文案）。
  async function triggerReaderModeInTab(tabId, readerUrl = "", retries = triggerRetries, delayMs = triggerRetryDelayMs) {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (attempt > 0) {
        await delay(delayMs);
      }

      try {
        const response = await sendMessageToTab(tabId, {
          type: "popup-trigger-reading-view",
          readerUrl
        });
        if (response?.ok) {
          return true;
        }
      } catch (error) {
        const message = String(error?.message || "");
        if (message.includes(RECEIVING_END_MISSING_SENTINEL)) {
          try {
            await ensureReaderContentReady(tabId);
          } catch {
            // keep retrying
          }
          continue;
        }
      }
    }

    return false;
  }

  // 关闭阅读视图：triggerRetries×triggerRetryDelayMs 重试。错误一律忽略（消息
  // 端口被提前关闭等瞬时失败），每轮通过 URL 的 boc_reader 参数二次确认是否
  // 已退出；确认退出返回 true，耗尽返回 false。
  async function triggerReaderModeCloseInTab(tabId, retries = triggerRetries, delayMs = triggerRetryDelayMs) {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (attempt > 0) {
        await delay(delayMs);
      }

      try {
        const response = await sendMessageToTab(tabId, {
          type: "popup-close-reading-view"
        });
        if (response?.ok) {
          return true;
        }
      } catch (error) {
        // 忽略瞬时失败（消息端口被提前关闭等），下方会通过 URL 二次确认。
      }

      if (await isTabReaderModeOff(tabId)) {
        return true;
      }
    }

    return false;
  }

  return {
    ensureReaderContentReady,
    probeContentScriptVersion,
    injectReaderContent,
    triggerReaderModeInTab,
    triggerReaderModeCloseInTab
  };
}
