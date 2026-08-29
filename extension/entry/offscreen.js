// offscreen.js — 隐藏后台页面，负责 SSE 流式请求，避免 Side Panel 被冻结。
// 同时是 "asr-decode" 端口的接线层：ASR 音频「下载 → 解码 → 切片 → 转写」
// 全链路在 ./offscreen-asr.js（service worker 无 AudioContext，解码 + 重采样
// 在本 context 用 OfflineAudioContext 完成；转写引擎与适配器也加载在本
// context——音频字节与 API Key 都不出 offscreen，跨 port 只回传转写文本结果）。
// 本文件只保留端口接线与分发、聊天通道、空闲超时、以及文档自关闭簿记。
import { runLadderChat } from "../ai/ladder.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { shouldCloseAfterAsrTask } from "./offscreen-lifecycle.js";
import { createAsrDecodeHandler } from "./offscreen-asr.js";
import { ASR_DECODE_PORT_NAME, ASR_DECODE_ACTION } from "../asr/protocol.js";

let activeAbortController = null;
let pendingCostGuard = null;
let idleTimeoutId = null;
var STREAM_IDLE_TIMEOUT_MS = 90000;

// 同一文档双通道存活计数：聊天（"offscreen-chat" 端口）用计数维护，
// 解码任务（"asr-decode" 端口）用存活端口集合维护——终态判定要排除
// 本次任务的端口自身（done/error 时它还连着），集合比计数少一分监听
// 注册时序依赖。asr-decode 任务终态后由 maybeCloseSelfAfterAsr 据此决定
// 是否自关文档（判定纯函数在 ./offscreen-lifecycle.js）。
let currentChatCount = 0;
const activeAsrPorts = new Set();

// asr-decode 任务执行器（下载/解码/切片/转写全链路在 ./offscreen-asr.js）：
// 任务终态（断连取消 / done / error）经 onTaskTerminal 回调交回本文件的
// maybeCloseSelfAfterAsr 自关判定。
const handleAsrDecodeTask = createAsrDecodeHandler({
  onTaskTerminal: maybeCloseSelfAfterAsr
});

function armIdleTimeout(abortController, port) {
  clearIdleTimeout();
  idleTimeoutId = setTimeout(function () {
    if (abortController && !abortController.signal.aborted) {
      abortController.abort();
      port.postMessage({
        type: "error",
        error: "请求超时（90 秒未返回任何数据），已自动中断"
      });
    }
  }, STREAM_IDLE_TIMEOUT_MS);
}

function clearIdleTimeout() {
  if (idleTimeoutId) {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === ASR_DECODE_PORT_NAME) {
    activeAsrPorts.add(port);
    port.onDisconnect.addListener(() => {
      activeAsrPorts.delete(port);
    });
    port.onMessage.addListener((msg) => {
      if (!msg || msg.action !== ASR_DECODE_ACTION) return;
      handleAsrDecodeTask(msg.task || {}, port);
    });
    return;
  }
  if (!port || port.name !== "offscreen-chat") {
    return;
  }
  // 聊天通道计数：asr-decode 终态自关判定的输入（见 maybeCloseSelfAfterAsr）
  currentChatCount += 1;

  port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.action === "stop") {
      abortActiveRequest();
      return;
    }
    if (msg.action === "cost-guard-confirm") {
      if (pendingCostGuard) {
        const resolve = pendingCostGuard.resolve;
        pendingCostGuard = null;
        resolve(msg.ok !== false);
      }
      return;
    }
    if (msg.action !== "chat") return;

    try {
      abortActiveRequest();
      activeAbortController = new AbortController();

      const resolved = await resolveProviderWithKey(port, msg.providerId);
      if (resolved.error) {
        clearActiveRequestState();
        return;
      }
      const { provider, apiKey } = resolved;

      armIdleTimeout(activeAbortController, port);

      // 阶梯分派策略（预算内单次流式 → 超预算 Map-Reduce → 追问压缩/成本护栏）
      // 在 ai/ladder.js（策略模块由 ladder 自行引入默认实现）；此处只接线：
      // 注入依赖本文件簿记的 askCostGuard 与空闲超时回调。abort controller、
      // 空闲超时与 cost-guard 的 Promise 簿记仍留在本文件。
      await runLadderChat(
        {
          msg,
          provider: { ...provider, apiKey },
          port,
          signal: activeAbortController.signal
        },
        {
          askCostGuard,
          onActivity: function () { armIdleTimeout(activeAbortController, port); },
          pauseIdleTimeout: clearIdleTimeout
        }
      );
    } catch (e) {
      port.postMessage({ type: "error", error: String(e?.message || e) });
    } finally {
      clearIdleTimeout();
      clearActiveRequestState();
    }
  });

  port.onDisconnect.addListener(() => {
    currentChatCount -= 1;
    if (pendingCostGuard) {
      const resolve = pendingCostGuard.resolve;
      pendingCostGuard = null;
      resolve(false);
    }
    abortActiveRequest();
    clearIdleTimeout();
    clearActiveRequestState();
  });
});

function abortActiveRequest() {
  if (activeAbortController && !activeAbortController.signal.aborted) {
    activeAbortController.abort();
  }
  activeAbortController = null;
}

// asr-decode 任务终态（done / error / 断连取消）后的自关判定，三处终态
// 共用本函数（offscreen-asr.js 经 onTaskTerminal 回调触达），不得各写一份。
// 本文档同时承载聊天与解码：聊天端口还在（currentChatCount > 0）或有其他
// 解码任务在跑（刷新竞态下新任务可能已连上本文档）时保留；否则文档已无
// 承载，自关以释放渲染进程。调用时终态消息必须已 postMessage 发完——文档
// 关闭后无法再 postMessage。
function maybeCloseSelfAfterAsr(port) {
  // 排除本次终态任务的端口：done/error 时它还连着（页面收到终态后才
  // 断连收尾），断连取消时可能已被断连监听移出——Set.delete 幂等，
  // 两种时序都正确。
  activeAsrPorts.delete(port);
  if (activeAsrPorts.size > 0 || !shouldCloseAfterAsrTask(currentChatCount)) {
    return;
  }
  try {
    const closing = chrome.offscreen.closeDocument();
    // closeDocument 返回 Promise：异步失败（如文档已被并发关闭）同样仅记录
    if (closing && typeof closing.catch === "function") {
      closing.catch((error) => {
        logWarn("[BOC] offscreen closeDocument after asr task failed", {
          error: getErrorMessage(error)
        });
      });
    }
  } catch (error) {
    logWarn("[BOC] offscreen closeDocument after asr task failed", {
      error: getErrorMessage(error)
    });
  }
}

function clearActiveRequestState() {
  activeAbortController = null;
}

// 向侧边栏弹成本护栏确认，等待其回复 { action: "cost-guard-confirm", ok: boolean }。
// 断连时 resolve(false)（视为取消）。
function askCostGuard(port, message) {
  return new Promise((resolve) => {
    pendingCostGuard = { resolve };
    port.postMessage({ type: "cost-guard", data: { message } });
  });
}

// 取「选中的平台 + 其 API Key」：provider 来自 ai-providers-list，key 来自 get-ai-provider-key。
// 任一缺失（平台不存在 / key 读取失败 / 需要 key 但未配置）返回带 error 的对象；成功返回 { provider, apiKey }。
async function resolveProviderWithKey(port, providerId) {
  const providersResp = await chrome.runtime.sendMessage({ type: "ai-providers-list" });
  const list = (providersResp?.providers || []).filter(p => p.enabled);
  const provider = list.find(p => p.id === providerId) || null;
  if (!provider) {
    port.postMessage({ type: "error", error: "未找到选中的平台" });
    return { error: true };
  }

  const keysResp = await chrome.runtime.sendMessage({ type: "get-ai-provider-key", providerId });
  if (!keysResp?.ok) {
    port.postMessage({ type: "error", error: keysResp?.error || "读取 API Key 失败" });
    return { error: true };
  }
  const apiKey = String(keysResp.apiKey || "").trim();
  if (provider.requiresKey !== false && !apiKey) {
    port.postMessage({ type: "error", error: "该平台 API Key 未配置" });
    return { error: true };
  }
  return { provider: { ...provider, apiKey }, apiKey };
}
