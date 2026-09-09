// UI 壳（面板 + 阅读视图模板）的按需加载器（候选3 常驻瘦身；
// arch-slim-2/09 自 core/ 搬回 ui/：加载器跟随被加载模块的目录）。
//
// ui/ui-renderer.js 承担 buildUiHtml / bindUiEvents / ensureUiReady
// 等壳构建与事件绑定逻辑，静态引用方较多时会被 esbuild 提升为常驻共享 chunk。
// 本模块把它改为动态 import 边：普通页启动不构建壳，只在面板打开或进入阅读
// 模式前才加载。
//
// 加载器语义与 reader/lazy-reader.ts / ai/lazy-player-ai.ts 一致：同文档内重复
// 调用共享同一 promise（createLazyLoader 缓存），并发触发不会构建两次；失败
// 清缓存，下次触发可重试。

import { createLazyLoader } from "../shared/lazy-import.js";

interface UiDomain {
  ensureUiReady(options?: { forceRecreate?: boolean }): void;
}

const loader = createLazyLoader<UiDomain>(() => import("./ui-renderer.js"));

// 按需确保 UI 壳存在。返回的 promise 在壳构建/复用完成后 resolve。
export async function ensureUiReady(options?: { forceRecreate?: boolean }): Promise<void> {
  const ui = await loader.load();
  ui.ensureUiReady(options);
}
