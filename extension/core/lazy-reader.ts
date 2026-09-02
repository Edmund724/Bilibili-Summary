// reader 域（reader/index.ts facade 及其 LAYOUT/SYNC/LIFECYCLE 闭包）的按需
// 加载器（候选02 分层惰性）。
//
// 为什么惰性：reader 域（~50KB）只在进入阅读模式 / reader 交互 / presenter
// 通知到达且阅读视图打开时才有职责。候选02 之前它被 message-handler 与
// player-ai 的静态 import（reader/index barrel）拖进常驻闭包，经 esbuild 提升
// 为 93KB 共享静态 chunk。分层后这里成为动态 import 边：esbuild 会把 facade
// 连同 lifecycle/sync 切进独立 chunk，只在首次
// ensureReaderDomain() 时才下载。
//
// 写法与 core/lazy-player-ai.ts、subtitle/lazy.ts 同款：加载器本体收拢于
// shared/lazy-import.ts 的 createLazyLoader（手写 promise 缓存 + 失败清缓存
// 可重试的共享工厂）。
//
// 为什么直接写相对路径：本模块身处 ESM 主包模块图内，动态 import() 的相对
// 路径按扩展自身 URL 解析（bootstrap 已用 chrome.runtime.getURL 的绝对路径
// 拉起主包），无需也不应再经 getURL 拼绝对路径。
//
// 失败语义：加载失败清空缓存 promise，允许下次触发重试（例如扩展刚更新、
// 旧 chunk 404 的过渡窗口内先失败、刷新后可恢复）。
//
// 「未装载」的语义约定（消费方依赖它做等价性跳过）：模块未加载 ⇒ 阅读视图
// 从未打开 ⇒ presenter 通知的 reader 侧处理（停止同步/重渲染）在本域内的
// 效果都是 no-op，消费方据此跳过装载（isReaderDomainLoaded）。

interface ReaderDomain {
  enterReaderMode(): void;
  closeReadingView(): void;
  waitForVideoMetadata(timeoutMs?: number): Promise<void>;
  seekReadingTarget(seconds: number | string, options?: { resumePlayback?: boolean }): number | null;
}

import { createLazyLoader } from "../shared/lazy-import.js";

const loader = createLazyLoader<ReaderDomain>(() => import("../reader/index.js"));

// 按需加载 reader/index.ts facade，同一文档内重复调用共享同一 promise。
export function ensureReaderDomain(): Promise<ReaderDomain> {
  return loader.load();
}

// 模块是否已存在加载请求（含仍在加载中）。消费方用它区分「未装载可跳过」
// 与「已装载需继续走异步路径」。
export function isReaderDomainLoaded(): boolean {
  return loader.isLoaded();
}
