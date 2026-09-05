// extension/shared/messaging.ts
// 所有 context 共用的消息传输层：chrome.runtime.sendMessage 的 Promise 化封装
// （sendRuntimeMessage）与通用 offload 任务通道（sendOffloadMessage）。
// content script / offscreen / sidepanel / options / reader / subtitle / ai 等
// 全部经此发消息。本文件是 shared 叶子，不得 import core/* 或任何域模块
// （ui/reader/ai/subtitle/bilibili），供所有 context 安全复用。

import type {
  BackgroundMessage,
  ContentScriptMessage,
  OffloadTaskMessage
} from "./messaging-protocol.js";

// 局部类型：不依赖 ambient chrome 声明，避免并行迁移中 chrome 类型文件冲突。
interface Runtime {
  sendMessage(message: unknown, responseCallback?: (response: unknown) => void): void;
  lastError?: { message?: string };
}

export function sendRuntimeMessage(
  message: BackgroundMessage | ContentScriptMessage
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      (chrome.runtime as Runtime).sendMessage(message, (resp) => {
        if ((chrome.runtime as Runtime).lastError) {
          reject(new Error((chrome.runtime as Runtime).lastError?.message));
          return;
        }
        resolve(resp);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// 通用 offscreen 任务通道：发 "offload-task" 消息给 background，按 taskType
// 分发给注册的任务执行器（现承载 asr-decode-prepare / asr-decode-cleanup，
// 见 asr/offscreen-bridge.bg.js：前者建 offscreen 文档 + 为该任务分配独立 id 的
// dnr 防盗链规则，后者按消息携带的 ruleId 只清自己的规则——多任务并发规则
// 并存、互不影响）。消息结构随任务类型定，执行器异常原样透传。
export function sendOffloadMessage<T extends Omit<OffloadTaskMessage, "type">>(
  message: T
): Promise<unknown> {
  return sendRuntimeMessage({ type: "offload-task", ...message } as OffloadTaskMessage);
}

// 局部类型：port 只需要 postMessage 一个方法（chrome.runtime.Port 结构兼容）。
interface PostMessageLikePort {
  postMessage(message: unknown): void;
}

// 「port 已断开则吞掉 postMessage 异常」的收口单源（arch-slim-2/03，原 5 处
// 手抄 try/catch：entry/offscreen-asr.ts ×2、entry/offscreen.ts ×3）。断连后的
// 迟到回执（聊天中途关面板 / SPA 换页 / 刷新 / 任务完成前断连）在 async 消息
// 监听器里会抛 "Attempting to use a disconnected port object" 成 unhandled
// rejection——回执已无接收方，这里统一吞掉，不区分消息类型。
export function safePostMessage(port: PostMessageLikePort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    // port 已断开，回执无接收方，忽略
  }
}
