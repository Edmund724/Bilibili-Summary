// 阅读视图开关状态访问器（候选02 分层惰性：自 page-frame.js 迁出的常驻微模块）。
//
// isReaderViewOpen 是纯 state 读取（state.reader.readingViewOpen），但它被
// ai/player-ai.js、subtitle/fetcher.js、core/message-handler.js 等域外模块
// 高频使用。原先它住在 page-frame.js（LAYOUT 重文件），任何使用方静态 import
// 都会把整个 reader 域拖进常驻闭包（player-ai 动态 chunk 因此被迫与 reader
// 域共享提升）。本模块与 ./scroll-state.js 同类：只依赖 core/state.js 的
// 常驻叶子，不 import reader 域任何其他模块。
import { state } from "../core/state.js";

// 阅读视图开关状态查询（读 state.reader；供 facade 对外转发）。
// 不变式：readingViewOpen=true 只可能由 enterReaderMode（reader 域内）写入，
// 因此「视图打开 ⇒ reader 域已装载」；消费方可据此在域未装载时安全跳过。
export function isReaderViewOpen() {
  return state.reader.readingViewOpen;
}
