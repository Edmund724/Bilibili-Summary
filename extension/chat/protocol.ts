// offscreen → 宿主聊天通道的出向流式事件协议（唯一地址，ticket 08 收口）。
// 七个流式事件（token/reasoning/notice/stream-reset/done/stopped/error）的引擎
// 侧定义单源在 ai/types.ts（StreamChatEvent——chatCompletion onEvent 回调的
// 「引擎事件」语义，与「端口消息」是两层），本文件以 type-only import 组合线上
// 形状，不复制定义：
//   - 全体成员可携带 cachedContextKey（offscreen 单槽字幕体缓存的当前 key 回执，
//     由 entry/offscreen.ts 的 withCachedContextKey 在回吐出口统一附加；宿主读
//     它推进 lastAckedContextKey，后续追问省略整份 subtitleBody）；
//   - error 事件在线上可带类型化 code（字幕体缺失路径的 "subtitle-body-missing"，
//     宿主据此重置 lastAcked），引擎侧 StreamErrorEvent 不含 code，此处只加宽；
//   - cost-guard 事件（offscreen 发起 Map-Reduce 前的成本护栏确认）不在引擎
//     事件之列，在本文件声明。
//
// 两端接线：宿主消费侧 chat-runtime.ts 的 ChatPortMessage 从这里 re-export
// （分派分支对载荷的宽容解析照旧，不依赖类型上的 unknown，联合收窄不影响
// 运行时）；生产侧 ai/client.ts / ai/map-reduce.ts 的 port 回吐与
// entry/offscreen.ts 的回吐包装都标注本联合——加事件只改这里，漏发/typo/
// 形状漂移编译期拦截。入向（宿主 → offscreen 的 chat / stop /
// cost-guard-confirm）单源在 shared/messaging-protocol.ts，不在本文件。
// 端口名常量供宿主 connect 与 offscreen onConnect 同址判定，禁止手写
// 字面量（注释除外）。

import type {
  StreamDoneEvent,
  StreamErrorEvent,
  StreamNoticeEvent,
  StreamReasoningEvent,
  StreamResetEvent,
  StreamStoppedEvent,
  StreamTokenEvent
} from "../ai/types.js";

// 宿主（sidepanel / reader 对话 tab）↔ offscreen 文档直连的聊天 port 名
export const OFFSCREEN_CHAT_PORT_NAME = "offscreen-chat" as const;

// 回执增广：offscreen 每条 chat 回执都附带其单槽字幕体缓存当前确认的 key
//（字幕体缺失等错误回执不带，宿主据 error.code 显式重置）。
interface ChatReceipt {
  cachedContextKey?: string;
}

// error 事件的线上形状：引擎只承诺 error 文案，字幕体缺失路径额外带 code。
type PortErrorEvent = StreamErrorEvent & { code?: string };

// cost-guard 事件：offscreen 发起 Map-Reduce 前请求成本确认，宿主经
// port.postMessage({ action: "cost-guard-confirm", ok }) 回执（入向形状在
// messaging-protocol）。message 宿主侧按 unknown 宽容读取
//（String(msg.data?.message || 兜底文案)），生产端恒发 string。
export interface ChatCostGuardEvent {
  type: "cost-guard";
  data?: { message?: unknown };
}

// offscreen → 宿主的出向 port 消息联合（七流式事件 + cost-guard，全体可携带
// cachedContextKey 回执）。载荷字段与既有线格式逐一对齐，不加不删。
export type ChatPortMessage =
  | (StreamTokenEvent & ChatReceipt)
  | (StreamReasoningEvent & ChatReceipt)
  | (StreamNoticeEvent & ChatReceipt)
  | (StreamResetEvent & ChatReceipt)
  | (StreamDoneEvent & ChatReceipt)
  | (StreamStoppedEvent & ChatReceipt)
  | (PortErrorEvent & ChatReceipt)
  | (ChatCostGuardEvent & ChatReceipt);

// 出向回吐侧的 port 窄视图（chrome.runtime.Port 的 postMessage 半边，
// offscreen 回吐包装 / ai 流式适配器 / map-reduce 编排共用）
export interface ChatPort {
  postMessage(message: ChatPortMessage): void;
}
