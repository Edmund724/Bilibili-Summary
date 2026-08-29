// sidepanel-offscreen-ensure.js — 聊天通道 offscreen 文档的 ensure（sidepanel
// split 模式抽出的可测模块，依赖全部走全局 chrome，测试里 stub 即可）。
//
// 历史行为：sidepanel 只在 init 时创建一次 offscreen 文档；文档意外死亡
// （崩溃 / 被系统回收）后，"offscreen-chat" 端口连上即断、聊天静默失效，
// 直到重开侧边栏。这里把 init 的创建参数原样抽成 ensure：init 与每次聊天
// 发送前（connectPort）都调用，文档缺失时重建，发送路径自愈。
//
// 判定实现：先用 chrome.runtime.getContexts 查 OFFSCREEN_DOCUMENT 是否已
// 存在（Chrome 116+），已存在直接返回，不依赖 createDocument 的异常文本；
// getContexts 不可用（Chrome 114/115）或查询失败时降级为直接尝试创建，
// createDocument 抛错（含“文档已存在”）仅 logWarn 不上抛——调用方无论
// 结果如何都继续 connect，由连接结果兜底（维持历史行为，不阻断发送）。

import { logWarn } from "../shared/logging.js";
import { getErrorMessage } from "../shared/error-helpers.js";

export const CHAT_OFFSCREEN_PATH = "entry/offscreen.html";

export async function ensureChatOffscreenDocument() {
  const url = chrome.runtime.getURL(CHAT_OFFSCREEN_PATH);
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url]
    });
    if (Array.isArray(contexts) && contexts.length > 0) {
      return true;
    }
  } catch {
    // getContexts 不可用（Chrome <116）或查询失败：降级为直接尝试创建
  }
  try {
    await chrome.offscreen.createDocument({
      url,
      reasons: ["DOM_SCRAPING"],
      justification: "Run AI stream fetch in background to avoid Side Panel freeze when tab is hidden."
    });
    return true;
  } catch (error) {
    // 文档已存在（查询降级路径）或创建失败：不算发送失败，connect 兜底
    logWarn("[BOC] ensureChatOffscreenDocument createDocument failed", {
      error: getErrorMessage(error)
    });
    return false;
  }
}
