// UI 壳（面板 + 阅读视图模板）的按需加载器（候选3 常驻瘦身）。
//
// ui/ui-renderer.js 承担 buildUiHtml / bindUiEvents / ensureUiReady / setBusyState
// 等壳构建与事件绑定逻辑，静态引用方较多时会被 esbuild 提升为常驻共享 chunk。
// 本模块把它改为动态 import 边：普通页启动不构建壳，只在面板打开或进入阅读
// 模式前才加载。
//
// 加载器语义与 core/lazy-reader.ts / core/lazy-player-ai.ts 一致：同文档内重复
// 调用共享同一 promise（createLazyLoader 缓存），并发触发不会构建两次；失败
// 清缓存，下次触发可重试。

import { createLazyLoader } from "../shared/lazy-import.js";

interface UiDomain {
  ensureUiReady(options?: { forceRecreate?: boolean }): void;
}

const loader = createLazyLoader<UiDomain>(() => import("../ui/ui-renderer.js"));

// 按需确保 UI 壳存在。返回的 promise 在壳构建/复用完成后 resolve。
export function ensureUiReady(options?: { forceRecreate?: boolean }): Promise<void> {
  return loader.load().then((ui) => ui.ensureUiReady(options));
}
