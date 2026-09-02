// reader 对话 tab（reader/chat-tab.ts）的按需加载器（PR5 二级惰性）。
//
// 为什么惰性：对话 tab 的组合根 + 三个重建壳（lists/notices/popovers）连着
// chat/* 内核（~2000 行），只在用户首次切到「AI 对话」tab（或解释卡片的
// 「去对话追问」/概览笔记按钮触达对话 seam）时才有职责。作为 reader 域内的二级惰性，经
// createLazyLoader（promise 缓存 + 失败清缓存可重试）动态 import
// reader/chat-tab.js——esbuild 把它切进独立动态 chunk，不拖进 reader/index
// 主 chunk。
//
// 「未装载」的语义约定（消费方依赖它做等价跳过）：模块未加载 ⇒ 对话功能从未
// 启用 ⇒ closeReadingView 的断流收口是 no-op（lifecycle 经 isReaderChatTabLoaded
// 判断后再 load）。
//
// 为什么直接写相对路径：本模块身处 ESM 主包模块图内，动态 import() 的相对路径
// 按扩展自身 URL 解析（与 core/lazy-reader.ts 同款，见其头注）。
import { createLazyLoader } from "../shared/lazy-import.js";

// 对话 tab 组合根对外的窄接口（懒加载消费方——ui-renderer / lifecycle /
// overview——只依赖这三个入口，不触达组合根内部编排）。
export interface ReaderChatTabDomain {
  // 激活对话 tab：首次调用走 init（组装 + 加载 + 渲染 + 消费待解释意图）；
  // 已初始化时走重开/重进的恢复路径（工单 08：重开从会话历史恢复），并顺带
  // 消费可能新写入的待解释意图。runQuickActionPrompt 传 consumeIntent:false
  // 跳过意图消费（避免与快捷动作发送互相踩踏）。
  ensureChatTabActivated(opts?: { consumeIntent?: boolean }): Promise<void>;
  // 会话收尾（closeReadingView 清理清单调用）：断流收口（工单 08 决议：关闭
  // 即断流，重开从会话历史恢复；不做后台续跑）+ 摘全局触发源 + 关 popover。
  closeChatSession(): void;
  // player-ai 快捷动作消费 seam（工单 08 决议语义）：定位/聚焦对话 tab +
  // startNewConversation + 输入框填快捷提示词 + 自动发送。返回是否受理成功。
  runQuickActionPrompt(prompt: string): Promise<boolean>;
}

const loader = createLazyLoader<ReaderChatTabDomain>(() => import("../reader/chat-tab.js"));

// 按需加载 reader/chat-tab.ts 并激活（重复调用共享同一 promise / 同一实例）。
export function ensureReaderChatTab(): Promise<ReaderChatTabDomain> {
  return loader.load();
}

// 模块是否已存在加载请求（含仍在加载中）。lifecycle 的关闭收口用它区分
// 「未装载可跳过」与「已装载需继续走异步路径」。
export function isReaderChatTabLoaded(): boolean {
  return loader.isLoaded();
}
