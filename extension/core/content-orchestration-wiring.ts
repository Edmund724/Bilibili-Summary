// extension/core/content-orchestration-wiring.ts
// SW / sidepanel 共享的 content 注入恢复接线。
// 把真实 chrome API 触点组装进 background-content-orchestration 工厂，
// 两侧各自 import 所需函数；本模块拥有全部 chrome 副作用，工厂仍零 chrome 依赖。

import { sendMessageToTab, waitForTabComplete } from "../shared/tab-utils.js";
import { createBackgroundContentOrchestrator } from "../entry/background-content-orchestration.js";

const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

// 版本探针单发：读页面里 content 主包置的版本哨兵，空串 = 未读到；API 抛错
// 交给编排层吞掉重试，单发自身不 try/catch。
function probeContentScriptVersionOnce(tabId: number) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => (globalThis as Record<string, unknown>).__BOC_CONTENT_SCRIPT_LOADED__ || ""
  }).then((probe) => String(probe?.[0]?.result || ""));
}

async function injectReaderAssets(tabId: number) {
  // S3 分层：修复注入语义是「补齐整页样式」（页面可能被 manifest 注入路径
  // 遗漏，阅读模式可能正处于开启状态），因此常驻表 + 阅读表全量注入；播放器
  // AI 表不需要——它只随 ai/player-ai.js 模块装载挂载，与内容脚本注入无关。
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["entry/styles/panel.css", "entry/styles/reader.css", "entry/styles/reader-gate.css"]
  });

  await chrome.scripting.executeScript({
    // 候选4 分包后这里注入 classic bootstrap：它置版本哨兵后异步拉起 ESM
    // 主包（manifest.content_scripts 指向同一文件，注入语义一致）。重复注入
    // 由 bootstrap 的 __BOC_CONTENT_BOOTSTRAP_STARTED__ 标志挡住；classic 重复
    // 注入的词法冲突哨兵（见 shared/content-error-sentinels.js）由编排层吞掉。
    target: { tabId },
    files: ["entry/content-bootstrap.iife.js"]
  });
}

async function isTabReaderModeOff(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) {
    return false;
  }
  try {
    return new URL(tab.url).searchParams.get("boc_reader") !== "1";
  } catch {
    return false;
  }
}

export const {
  ensureReaderContentReady,
  probeContentScriptVersion,
  injectReaderContent,
  triggerReaderModeInTab,
  triggerReaderModeCloseInTab
} = createBackgroundContentOrchestrator({
  // 单发副作用（chrome API 触点）
  probeOnce: probeContentScriptVersionOnce,
  injectAssets: injectReaderAssets,
  reloadTab: (tabId: number) => chrome.tabs.reload(tabId),
  waitForTabComplete,
  sendMessageToTab,
  isTabReaderModeOff,
  // 前置守卫：无 scripting 能力或无 tabId 时，编排按「无事可做」直接返回
  //（与抽离前 ensureReaderContentReady 开头的 `!chrome.scripting || !tabId` 等价）。
  canInject: (tabId: number) => Boolean(chrome.scripting) && Boolean(tabId),
  expectedVersion: EXPECTED_CONTENT_SCRIPT_VERSION
});
