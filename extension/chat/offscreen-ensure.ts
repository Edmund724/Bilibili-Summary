// extension/chat/offscreen-ensure.ts — 聊天通道 offscreen 文档的 ensure（sidepanel
// split 模式抽出的可测模块，依赖全部走全局 chrome，测试里 stub 即可；PR5 自
// extension/pages/sidepanel-offscreen-ensure.ts 迁入 chat 域，逻辑零语义改动）。
//
// offscreen 是扩展级共享文档，与 sidepanel 页面无生命周期绑定：任何扩展上下文
// （sidepanel 过渡期 / 未来 reader 对话 tab）都连同一个 "offscreen-chat" 端口。
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
import { OFFSCREEN_URL, OFFSCREEN_CREATE_REASON } from "../shared/offscreen-constants.js";

export async function ensureChatOffscreenDocument(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
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
      // reason 统一取 BLOBS（shared/offscreen-constants.js）：同一文档由本处
      // 与 background asr-decode-prepare 共同创建/复用，先到者定 reason；
      // 不能用 AUDIO_PLAYBACK（无真实播放 30s 强制关闭，会打断长视频解码）。
      reasons: [OFFSCREEN_CREATE_REASON],
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
