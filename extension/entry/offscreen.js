// offscreen.js — 隐藏后台页面，负责 SSE 流式请求，避免 Side Panel 被冻结。
// 同时是 "asr-decode" 端口的接线层：ASR 音频「下载 → 解码 → 切片 → 转写」
// 全链路在 ./offscreen-asr.js（service worker 无 AudioContext，解码 + 重采样
// 在本 context 用 OfflineAudioContext 完成；转写引擎与适配器也加载在本
// context——音频字节与 API Key 都不出 offscreen，跨 port 只回传转写文本结果）。
// 本文件只保留端口接线与分发、聊天通道、空闲超时、以及文档自关闭簿记。
//
// 候选04：两族任务链按需动态装载。AI 半边（../ai/ladder.js → map-reduce →
// … → notes/render 渲染器）与 ASR 半边（./offscreen-asr.js → engine /
// adapters / chunker …）互不相干，静态全量打包会让每次任务冷启动都解析
// ~100KB 用不上的模块。offscreen 是页面环境，动态 import() 完全合法
// （ADR-0003 只约束 service worker），两族各自经 shared/lazy-import.js 的
// promise 缓存懒加载器按需拉取：
//   - ASR 族：首个 asr-decode 任务消息到达时装载，loadFn 内一次性装配任务
//     执行器（工厂只跑一次）；promise 缓存保证并发首连只加载一次，失败清
//     缓存可重试（如扩展刚更新后旧 chunk 404 的过渡窗口）。
//   - AI 族：首条 "chat" 消息到达时装载 runLadderChat（模块级无状态函数，
//     拉到即用）。
// 装载失败的错误沿各自既有消息通道回报（ASR：ASR_MSG_ERROR；聊天：
// { type: "error" }），不崩文档。文档自关闭簿记不感知装载状态：asr-decode
// 端口在 onConnect 时即计入 activeAsrPorts、聊天端口在 onConnect 时即计入
// currentChatCount（同步，先于任何消息），而装载只能由某个端口的任务消息
// 触发——触发装载的端口必已入集，故任一分支「装载中」期间其他任务的终态
// 判定都会因 size>0 / currentChatCount>0 保留文档，不会被提前关闭。
import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { shouldCloseAfterAsrTask } from "./offscreen-lifecycle.js";
import { ASR_DECODE_PORT_NAME, ASR_DECODE_ACTION, ASR_MSG_ERROR } from "../asr/protocol.js";
// 候选5：聊天字幕体单槽缓存（纯逻辑在 ./offscreen-subtitle-slot.js，可测）。
import { createSubtitleBodySlot } from "./offscreen-subtitle-slot.js";
// 候选04：ASR / AI 两族任务链的懒加载器工厂（promise 缓存、失败可重试）。
import { createLazyLoader } from "../shared/lazy-import.js";

let activeAbortController = null;
let pendingCostGuard = null;
let idleTimeoutId = null;
var STREAM_IDLE_TIMEOUT_MS = 90000;

// 候选5：聊天字幕体单槽缓存。SP 侧只在 lastAckedContextKey 变化时随消息携带
// 全量 subtitleBody，后续追问由本槽补齐；槽随本文档生灭，文档被回收后 SP 的
// port 断连会重置其 lastAcked，时序缝隙里漏网的缺失消息走 settle 的错误回执。
const subtitleSlot = createSubtitleBodySlot();

// 同一文档双通道存活计数：聊天（"offscreen-chat" 端口）用计数维护，
// 解码任务（"asr-decode" 端口）用存活端口集合维护——终态判定要排除
// 本次任务的端口自身（done/error 时它还连着），集合比计数少一分监听
// 注册时序依赖。asr-decode 任务终态后由 maybeCloseSelfAfterAsr 据此决定
// 是否自关文档（判定纯函数在 ./offscreen-lifecycle.js）。
let currentChatCount = 0;
const activeAsrPorts = new Set();

// ASR 族懒加载：load() 返回「已注入 onTaskTerminal 的任务执行器」——动态
// import 与工厂装配都在 loadFn 内，工厂只执行一次。任务终态（断连取消 /
// done / error）经 onTaskTerminal 回调交回本文件的 maybeCloseSelfAfterAsr
// 自关判定。
const asrHandlerLoader = createLazyLoader(async () => {
  const { createAsrDecodeHandler } = await import("./offscreen-asr.js");
  return createAsrDecodeHandler({ onTaskTerminal: maybeCloseSelfAfterAsr });
});

// AI 族懒加载：首条 "chat" 消息到达时拉 ../ai/ladder.js 的 runLadderChat。
const ladderLoader = createLazyLoader(async () => {
  const { runLadderChat } = await import("../ai/ladder.js");
  return runLadderChat;
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
      dispatchAsrDecodeTask(msg.task || {}, port);
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

    // 候选5：先结算字幕体。SP 侧 lastAckedContextKey 命中时消息不带
    // subtitleBody，由单槽缓存补写进 msg.context；槽缺失/key 不匹配直接回
    // 错误且不带 cachedContextKey——SP 据此重置 lastAcked，让下一条消息重发
    // 全文（本条不自动重发，避免失败风暴）。
    const settled = subtitleSlot.settle(msg);
    if (!settled.ok) {
      port.postMessage({ type: "error", error: settled.error, code: settled.code });
      return;
    }
    // 自此所有 chat 回执都附带 cachedContextKey（槽内已确认的 key）：SP 读它
    // 推进 lastAckedContextKey，后续追问省略 subtitleBody。包装只劫持
    // postMessage，端口事件监听不受影响；下游 ladder/streamChat/map-reduce
    // 只经 port.postMessage 回吐，包装对它们透明。
    const ackedPort = withCachedContextKey(port, settled.contextKey);

    try {
      abortActiveRequest();
      activeAbortController = new AbortController();

      const resolved = await resolveProviderWithKey(ackedPort, msg.providerId);
      if (resolved.error) {
        clearActiveRequestState();
        return;
      }
      const { provider, apiKey } = resolved;

      armIdleTimeout(activeAbortController, ackedPort);

      // 候选04：首次聊天在此动态装载 AI 半边。装载失败抛错走下方既有 catch
      // 通道回报（{ type: "error" }），语义与 runLadderChat 抛错一致，不崩
      // 文档；装载期间空闲超时照常计时（超时 abort 后即使装载完成，
      // runLadderChat 收到已 abort 的 signal 也会退出）。
      const runLadderChat = await ladderLoader.load();

      // 阶梯分派策略（预算内单次流式 → 超预算 Map-Reduce → 追问压缩/成本护栏）
      // 在 ai/ladder.js（策略模块由 ladder 自行引入默认实现）；此处只接线：
      // 注入依赖本文件簿记的 askCostGuard 与空闲超时回调。abort controller、
      // 空闲超时与 cost-guard 的 Promise 簿记仍留在本文件。
      await runLadderChat(
        {
          msg,
          provider: { ...provider, apiKey },
          port: ackedPort,
          signal: activeAbortController.signal
        },
        {
          askCostGuard,
          onActivity: function () { armIdleTimeout(activeAbortController, ackedPort); },
          pauseIdleTimeout: clearIdleTimeout
        }
      );
    } catch (e) {
      ackedPort.postMessage({ type: "error", error: String(e?.message || e) });
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

// asr-decode 任务分发：懒装载 ASR 半边后交任务执行器执行。装载失败沿既有
// ASR_MSG_ERROR 通道回报（页面按普通 ASR 失败展示，不崩文档），并按「error
// 终态」语义交回自关判定——与 handler 内部 catch 的收尾一致（终态消息发完
// 才判定；port 已断开时 postMessage 抛错被吞、判定照走，Set.delete 幂等，
// 两种时序都正确）。
async function dispatchAsrDecodeTask(task, port) {
  let handleAsrDecodeTask;
  try {
    handleAsrDecodeTask = await asrHandlerLoader.load();
  } catch (error) {
    logWarn("[BOC] offscreen-asr.js load failed", { error: getErrorMessage(error) });
    try {
      port.postMessage({
        type: ASR_MSG_ERROR,
        error: "ASR 模块加载失败：" + getErrorMessage(error)
      });
    } catch {
      // port 已断开，忽略
    }
    maybeCloseSelfAfterAsr(port);
    return;
  }
  handleAsrDecodeTask(task, port);
}

function abortActiveRequest() {
  if (activeAbortController && !activeAbortController.signal.aborted) {
    activeAbortController.abort();
  }
  activeAbortController = null;
}

// asr-decode 任务终态（done / error / 断连取消）后的自关判定，三处终态
// 共用本函数（offscreen-asr.js 经 onTaskTerminal 回调触达，装载失败路径在
// 上方 dispatchAsrDecodeTask），不得各写一份。本文档同时承载聊天与解码：
// 聊天端口还在（currentChatCount > 0）或有其他解码任务在跑（刷新竞态下新
// 任务可能已连上本文档）时保留；否则文档已无承载，自关以释放渲染进程。调用
// 时终态消息必须已 postMessage 发完——文档关闭后无法再 postMessage。
// 装载中的分支不会触发本判定（装载由端口消息触发、端口已入集），纯 ASR /
// 纯聊天 / 混合会话的关闭行为与拆分前一致。
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

// 候选5：给 port 的出站消息统一附带 cachedContextKey（本侧单槽缓存当前确认
// 持有的字幕体 key）。SP 从任意一条 chat 回执读它推进 lastAckedContextKey，
// 后续追问省略 subtitleBody。只包装 postMessage 一个入口；事件监听器仍挂
// 在原 port 上（本包装只作为下游回吐的发送通道）。
function withCachedContextKey(port, contextKey) {
  return {
    postMessage: (data) => port.postMessage({ ...data, cachedContextKey: contextKey })
  };
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
