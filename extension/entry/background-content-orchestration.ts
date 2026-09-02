// background-content-orchestration.ts — SW 侧「content 注入恢复 + 触发重试」编排。
//
// 从 entry/background.js 提取：background 只组装真实 chrome API 传入工厂，
// 本模块拥有全部时序与错误分类决策。模块顶层零 chrome 依赖（仅 shared/utils
// 的 sleep 作默认延时、shared 的错误哨兵常量），可在 Node 测试环境直接 evaluate。

import { sleep } from "../shared/utils.js";
import {
  DUPLICATE_CLASSIC_INJECTION_SENTINEL,
  RECEIVING_END_MISSING_SENTINEL
} from "../shared/content-error-sentinels.js";

export interface BackgroundContentOrchestratorDeps {
  probeOnce: (tabId: number) => Promise<string>;
  injectAssets: (tabId: number) => Promise<void>;
  reloadTab: (tabId: number) => Promise<void>;
  waitForTabComplete: (tabId: number, options: { polls: number }) => Promise<boolean>;
  sendMessageToTab: (tabId: number, message: unknown) => Promise<{ ok?: boolean }>;
  isTabReaderModeOff: (tabId: number) => Promise<boolean>;
  canInject: (tabId: number) => boolean;
  expectedVersion: string;
  delay?: (ms: number) => Promise<void>;
  probeAttempts?: number;
  probeRetryDelayMs?: number;
  readyPolls?: number;
  readyPollIntervalMs?: number;
  reloadWaitPolls?: number;
  reloadSettleDelayMs?: number;
  triggerRetries?: number;
  triggerRetryDelayMs?: number;
}

export interface BackgroundContentOrchestrator {
  ensureReaderContentReady: (tabId: number) => Promise<void>;
  probeContentScriptVersion: (tabId: number) => Promise<string>;
  injectReaderContent: (tabId: number) => Promise<void>;
  triggerReaderModeInTab: (
    tabId: number,
    readerUrl?: string,
    retries?: number,
    delayMs?: number
  ) => Promise<boolean>;
  triggerReaderModeCloseInTab: (tabId: number, retries?: number, delayMs?: number) => Promise<boolean>;
}

export function createBackgroundContentOrchestrator(deps: BackgroundContentOrchestratorDeps): BackgroundContentOrchestrator {
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

  async function probeContentScriptVersion(tabId: number): Promise<string> {
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

  async function injectReaderContent(tabId: number): Promise<void> {
    try {
      await injectAssets(tabId);
    } catch (error) {
      const message = String((error as Error)?.message || "");
      if (!message.includes(DUPLICATE_CLASSIC_INJECTION_SENTINEL)) {
        throw error;
      }
    }
  }

  async function pollContentReady(tabId: number): Promise<boolean> {
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

  async function ensureReaderContentReady(tabId: number): Promise<void> {
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

  async function triggerReaderModeInTab(
    tabId: number,
    readerUrl = "",
    retries = triggerRetries,
    delayMs = triggerRetryDelayMs
  ): Promise<boolean> {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (attempt > 0) {
        await delay(delayMs);
      }

      try {
        const response = await sendMessageToTab(tabId, {
          type: "reader-enter",
          readerUrl
        });
        if (response?.ok) {
          return true;
        }
      } catch (error) {
        const message = String((error as Error)?.message || "");
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

  async function triggerReaderModeCloseInTab(
    tabId: number,
    retries = triggerRetries,
    delayMs = triggerRetryDelayMs
  ): Promise<boolean> {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (attempt > 0) {
        await delay(delayMs);
      }

      try {
        const response = await sendMessageToTab(tabId, {
          type: "reader-close"
        });
        if (response?.ok) {
          return true;
        }
      } catch (error) {
        // 忽略瞬时失败（消息端口被提前关闭等），下方通过 URL 二次确认。
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
