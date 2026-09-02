// 待解释意图（PR3 契约叶子）：字幕侧「去对话追问」与 AI 对话 tab 之间的交接面。
//
// 生产方：解释卡片（reader/explain-card.js）底部的「去对话追问」按钮——用户在
// 字幕句里选中词/句 → 选区下方浮出「解释」→ 点开后卡片就地给解释，想继续追问时
// 点这个按钮，把选中片段 + 所在整句记进本叶子并切到 AI 对话 tab；
// 消费方：AI 对话 tab（reader/chat-tab.js）激活时 peek → 渲染引用卡 → 自动发送
// → 发送受理成功才 consume（一次意图只发一次，被闸拦下时保持 pending 可重试）。
//
// 为什么是独立零依赖叶子（对照 ai/player-ai-state.ts 的 pending 请求模式）：
// 写入方与读取方分属不同动态分包（卡片随 reader 域装载，对话组合根走
// core/lazy-chat-tab 的二级惰性），意图必须住在两边都买得起的常驻叶子上，
// 任何一方都无需为读写一个意图装载对方重域。
//
// 单槽 pending（后写覆盖先写）：用户连着追问两句，以最后一句为准——对话 tab
// 每次激活只自动发送一条待解释请求，语义明确。

// 形状契约（PR5 依赖，字段名勿随意改）：
//   from      —— 选中句起始秒（条目 data-seconds），供对话侧时间戳 pill / 引用定位
//   content   —— 选中所在整句纯文本（.boc-reading-text 的 textContent trim），
//                始终是解释的上下文锚点
//   selection —— 用户实际选中的词/短语（选区文本 trim）；整句选中或无选区时省略，
//                消费方据此区分「解释一个词」与「解释整句」两种提示词
//   createdAt —— 记录时间（Date.now()），供 PR5 判过期/排序（本 PR 不消费）
export interface ReaderExplainIntent {
  from: number;
  content: string;
  selection?: string;
  createdAt: number;
}

let pendingIntent: ReaderExplainIntent | null = null;

// 记录/覆盖待解释意图（intent 外部对象后续变更不影响已存快照）。
// selection 与整句相同（全选一句）时归一化掉：两种写法在消费端语义一致，
// 不必让下游各自判等。
export function setPendingExplainIntent(intent: ReaderExplainIntent): void {
  const content = String(intent?.content || "");
  const selection = String(intent?.selection || "").trim();
  pendingIntent = {
    from: Number(intent?.from) || 0,
    content,
    createdAt: Number(intent?.createdAt) || Date.now()
  };
  if (selection && selection !== content) {
    pendingIntent.selection = selection;
  }
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
