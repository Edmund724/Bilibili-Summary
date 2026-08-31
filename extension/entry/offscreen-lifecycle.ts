// offscreen-lifecycle.ts — offscreen 文档自身生命周期的纯判定（可测）。
//
// 同一 offscreen 文档承载聊天（"offscreen-chat"）与 asr-decode 双通道：
// asr-decode 任务到达终态（done / error / 断连取消）后，若聊天通道已无
// 存活端口，文档再无承载，自关以释放渲染进程；还有聊天端口时保留。
//
// 纯函数放独立模块：entry/offscreen.ts 顶层挂满 chrome 事件监听，不可在
// Node 测试环境导入。

// currentChatCount 为 0（无存活聊天端口）→ 关；NaN/undefined（计数异常）
// → 不关，保守保留文档。
export function shouldCloseAfterAsrTask(currentChatCount: unknown): boolean {
  return Number(currentChatCount) <= 0;
}
