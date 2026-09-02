// 对话 tab 外点关闭的桥接叶子（PR5 风险 6 收口）。
//
// 为什么存在：reader 已有文档级 click 委托（ui-renderer bindUiEvents 的设置面板
// 外点关闭，readingDocumentClickBound 防重绑）；对话 tab 的 popovers 外点关闭
// （reader/chat-popovers.ts handleDocumentClick）若自挂第二个 document 监听会
// 与之双监听互踩。本叶子提供「注册槽」：对话 tab 组合根在激活时注册自己的
// handleDocumentClick、关闭时摘除；ui-renderer 的单一文档级委托在处理自身逻辑
// 的同时转发给本槽。两侧都只买这个零依赖常驻叶（对话域与常驻壳互不静态依赖）。
//
// 语义：同一时刻最多一个注册者（后注册覆盖先注册）；无注册者时转发为 no-op。

type ChatTabOutsideClickHandler = (event: MouseEvent) => void;

let outsideClickHandler: ChatTabOutsideClickHandler | null = null;

// 注册/替换对话 tab 的文档级外点关闭处理体（传 null 摘除）。
export function setChatTabOutsideClickHandler(handler: ChatTabOutsideClickHandler | null): void {
  outsideClickHandler = typeof handler === "function" ? handler : null;
}

// ui-renderer 的单一文档级 click 委托调用：转发给对话 tab 的外点处理体（无则 no-op）。
export function dispatchChatTabOutsideClick(event: MouseEvent): void {
  outsideClickHandler?.(event);
}
