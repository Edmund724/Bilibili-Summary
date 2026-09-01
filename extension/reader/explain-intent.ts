// 句上「解释」的待处理意图（PR3 契约叶子）。
//
// 生产方：字幕 tab 的句上浮层「解释」按钮（ui/ui-renderer.js 绑定）——记录
// 选中字幕句并切到 AI 对话 tab；消费方：PR5 的 AI 对话 tab（占位期由
// ui-renderer 的 renderReadingChatIntent 展示引用卡，对话功能落地后发送时
// consumePendingExplainIntent 取走）。
//
// 为什么是独立零依赖叶子（对照 ai/player-ai-state.ts 的 pending 请求模式）：
// 写入方（ui-renderer，常驻惰性 chunk）与读取方（PR5 对话 tab，reader/ai 动态
// chunk）分属不同分包，意图必须住在两边都买得起的常驻叶子上，任何一方都无需
// 为读写一个意图装载对方重域。
//
// 单槽 pending（后写覆盖先写）：用户连点两句「解释」，以最后一句为准——
// 对话 tab 上线后每次只自动发送一条待解释请求，语义明确。

// 形状契约（PR5 依赖，字段名勿随意改）：
//   from      —— 选中句起始秒（条目 data-seconds），供对话侧时间戳 pill / 引用定位
//   content   —— 选中句纯文本（.boc-reading-text 的 textContent trim）
//   createdAt —— 记录时间（Date.now()），供 PR5 判过期/排序（本 PR 不消费）
export interface ReaderExplainIntent {
  from: number;
  content: string;
  createdAt: number;
}

let pendingIntent: ReaderExplainIntent | null = null;

// 记录/覆盖待解释意图（intent 外部对象后续变更不影响已存快照）。
export function setPendingExplainIntent(intent: ReaderExplainIntent): void {
  pendingIntent = {
    from: Number(intent?.from) || 0,
    content: String(intent?.content || ""),
    createdAt: Number(intent?.createdAt) || Date.now()
  };
}

// 只读窥视（占位卡渲染 / PR5 预检），不消费；返回副本防外部改写内部状态。
export function peekPendingExplainIntent(): ReaderExplainIntent | null {
  return pendingIntent ? { ...pendingIntent } : null;
}

// 消费：取走并清空（保证一次意图只被发送一次）；无 pending 时返回 null。
export function consumePendingExplainIntent(): ReaderExplainIntent | null {
  const intent = pendingIntent;
  pendingIntent = null;
  return intent ? { ...intent } : null;
}

// 清除（关闭阅读视图等会话收尾时调用，避免跨会话残留旧意图）。
export function clearPendingExplainIntent(): void {
  pendingIntent = null;
}
