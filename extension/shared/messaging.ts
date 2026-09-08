// extension/shared/messaging.ts
// 所有 context 共用的消息传输层：chrome.runtime.sendMessage 的 Promise 化封装
// （sendRuntimeMessage）与通用 offload 任务通道（sendOffloadMessage）。
// content script / offscreen / sidepanel / options / reader / subtitle / ai 等
// 全部经此发消息。本文件是 shared 叶子，不得 import core/* 或任何域模块
// （ui/reader/ai/subtitle/bilibili），供所有 context 安全复用。

import type {
  BackgroundMessage,
  ContentScriptMessage,
  OffloadTaskMessage,
  OffloadTaskResponse,
  ResponseOf,
  SendResponse
} from "./messaging-protocol.js";

// 局部类型：不依赖 ambient chrome 声明，避免并行迁移中 chrome 类型文件冲突。
interface Runtime {
  sendMessage(message: unknown, responseCallback?: (response: unknown) => void): void;
  lastError?: { message?: string };
}

// 泛型化（arch-slim-2/02）：返回类型由消息字面量经 ResponseOf<M> 静态推断，
// 消费点不再手猜响应形状（响应形状断言已全仓清零，扫描断言见
// tests/shared/messaging-response-scan.test.js）。唯一的 unknown cast 收在
// 传输边界本处——线格式 resp 是 unknown，响应形状由服务端处理器实现为事实
// 锚点、经调用点的消息类型静态承诺。
export function sendRuntimeMessage<M extends BackgroundMessage | ContentScriptMessage>(
  message: M
): Promise<ResponseOf<M>> {
  return new Promise((resolve, reject) => {
    try {
      (chrome.runtime as Runtime).sendMessage(message, (resp) => {
        if ((chrome.runtime as Runtime).lastError) {
          reject(new Error((chrome.runtime as Runtime).lastError?.message));
          return;
        }
        resolve(resp as ResponseOf<M>);
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
// 并存、互不影响）。入参为完整线格式报文（含 type: "offload-task"，调用点
// 字面量直写， arch-slim-2/02 起不再内部拼装+断言）；执行器异常原样透传。
export function sendOffloadMessage(
  message: OffloadTaskMessage
): Promise<OffloadTaskResponse> {
  return sendRuntimeMessage(message);
}

// 局部类型：port 只需要 postMessage 一个方法（chrome.runtime.Port 结构兼容）。
interface PostMessageLikePort {
  postMessage(message: unknown): void;
}

// ===== 页内消息分发原语（arch-slim-2/09）=====
// content script 页内触发源（ui/digest-button.ts 的工具栏点击 / 失同步自愈）
// 与 runtime onMessage 监听器共用同一条处理器路径：content script 的
// chrome.runtime.sendMessage 不会回环到本文档自己的监听器，页内源必须直接调
// 用分发主体才能复用同一处理逻辑（handler 单源，消息形状不变）。
//
// 分发主体（完整路由表）是 entry/message-handler.ts 的组合根知识，住在那里；
// 本文件只持「注册槽 + 转发」的原语壳——于 bindRuntimeEvents 时由组合根把
// dispatchContentScriptMessage 注册进来，页内源一律经这里调用。这样
// ui/digest-button.ts 取分发原语只依赖 shared 叶子，不建 ui → entry 的静态
// 边（shared 不 import entry/core/域模块的叶子纪律不变）。未注册时返回
// false，与「无人处理该消息」同义。
type ContentMessageDispatcher = (rawMessage: unknown, sendResponse: SendResponse) => boolean;

// 注册槽必须挂 globalThis 而非模块级变量：两轮构建（scripts/build-content.js）
// 把常驻底座在轮 B 懒 chunk 区重复一份，本模块在 content-main 与 chunks/ 共享
// chunk 里各是一个实例，模块级槽在两侧互不通用——注册发生在常驻包实例，而
// 页内源（ui/digest-button.ts）拿的是懒 chunk 实例，槽为 null 时分发静默
// 返回 false（digest 点击无反应的症状）。隔离世界的 globalThis 在同一扩展的
// 全部 content 模块间唯一，注册与调用经它对齐到同一个槽。
const DISPATCHER_SLOT_KEY = "__BOC_CONTENT_SCRIPT_DISPATCHER__";

function dispatcherHost(): Record<string, ContentMessageDispatcher | null | undefined> {
  return globalThis as unknown as Record<string, ContentMessageDispatcher | null | undefined>;
}

// 组合根（entry/message-handler.ts 的 bindRuntimeEvents）注册分发主体；
// 幂等（重复注册以后注册者为准，而 bindRuntimeEvents 自带防重复绑定）。
export function registerContentScriptDispatcher(dispatcher: ContentMessageDispatcher): void {
  dispatcherHost()[DISPATCHER_SLOT_KEY] = dispatcher;
}

// 页内源的分发入口：语义与 runtime onMessage 监听器完全一致（返回值同为
// 「是否异步回包」——true 表示处理器持有 sendResponse，调用方须保持通道）。
export function dispatchContentScriptMessage(
  rawMessage: unknown,
  sendResponse: SendResponse
): boolean {
  const dispatcher = dispatcherHost()[DISPATCHER_SLOT_KEY];
  return dispatcher ? dispatcher(rawMessage, sendResponse) : false;
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
