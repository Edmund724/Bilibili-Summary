// Reader 静态呈现层的按需加载器（候选3 常驻瘦身）。
//
// reader/presentation.js 含 hydrateReaderStateFromSettings / applyReadingViewPresentation
// / renderReadingStatus 等函数（digest-only-ui：步进器模板/绑定已随排版档位机制
// 退役）。它们在普通页启动路径被 content.js 与 init-essentials.js 静态引用，会把
// validators 拖入常驻。本模块把它改为动态 import 边：普通页不加载，
// 只在进入阅读模式或阅读视图已打开时设置变更才加载。
//
// 加载器语义与 core/lazy-reader.ts 一致：同文档内重复调用共享同一 promise，失败
// 清缓存可重试。

import { createLazyLoader } from "../shared/lazy-import.js";
import type { Settings } from "../core/defaults.js";

interface PresentationDomain {
  hydrateReaderStateFromSettings(settings?: Partial<Settings>): void;
  applyReadingViewPresentation(): void;
  renderReadingStatus(text: string | number | null | undefined): void;
}

const loader = createLazyLoader<PresentationDomain>(() => import("../reader/presentation.js"));

export function hydrateReaderStateFromSettings(settings?: Partial<Settings>): Promise<void> {
  return loader.load().then((mod) => mod.hydrateReaderStateFromSettings(settings));
}

export function applyReadingViewPresentation(): Promise<void> {
  return loader.load().then((mod) => mod.applyReadingViewPresentation());
}

export function renderReadingStatus(text: string | number | null | undefined): Promise<void> {
  return loader.load().then((mod) => mod.renderReadingStatus(text));
}
