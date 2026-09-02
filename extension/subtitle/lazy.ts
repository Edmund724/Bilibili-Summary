// 总结链（subtitle/fetcher.js 抓取编排 + subtitle/ui.js + notes/render.js 及其
// 独占依赖）的按需加载器（候选02 分层惰性）。
//
// 为什么惰性：抓字幕/笔记渲染链（~20KB）只在首次抓字幕（clip-refresh、刷新
// 抓取按钮、URL 变化自动刷新、阅读模式进入后的后台刷新）时才有职责。候选02
// 之前它经 message-handler / ui-renderer 的静态 import 常驻。分层后这里成为
// 动态 import 边：esbuild 把 fetcher 连同其独占依赖切进独立 chunk，只在首次
// ensureSummarizeChain() 时才下载。一键总结热路径（点击 AI 键 → clip-refresh）
// 上的装载是本地 chunk 动态 import（~10ms），被两轮消息往返完全掩盖。
//
// 写法与 core/lazy-player-ai.js、core/lazy-reader.js 同款：加载器本体收拢于
// shared/lazy-import.js 的 createLazyLoader（手写 promise 缓存 + 失败清缓存
// 可重试的共享工厂）。双入口（fetcher + ui）用 Promise.all 并行装载，与
// fetcher.js 的 ASR 回退装载同款。
//
// 为什么直接写相对路径：本模块身处 ESM 主包模块图内，动态 import() 的相对
// 路径按扩展自身 URL 解析（bootstrap 已用 chrome.runtime.getURL 的绝对路径
// 拉起主包），无需也不应再经 getURL 拼绝对路径。
//
// 失败语义：加载失败清空缓存 promise，允许下次触发重试。
//
// 消费约定：链内函数（refreshClip/loadSubtitle/resetClipState/buildClipSnapshotPayload/
// onSubtitleChange/copyMarkdown/downloadSubtitle）不静态 import fetcher/ui，
// 一律 `ensureSummarizeChain().then((chain) => chain.xxx())`；promise 缓存天然
// 去重并发调用。reader 侧的 requestSubtitleRefresh（presenter seam）在无
// handler 时也会先 ensure 本链再转发——链装载成功路径上的 initSummarizeChain
// 会把 refreshClip 注册进 seam，闭环成立。

import { createLazyLoader } from "../shared/lazy-import.js";

export interface SummarizeChain {
  refreshClip(): Promise<void>;
  loadSubtitle(
    url: string,
    lang: string,
    runId?: number,
    subtitleId?: string,
    forceRefresh?: boolean
  ): Promise<void>;
  resetClipState(options?: { keepFetchState?: boolean }): void;
  onSubtitleChange(event: Event): Promise<void>;
  copyMarkdown(): Promise<void>;
  // PR3：阅读模式字幕 tab「复制」——复制字幕纯文本（transcript，buildTxt 管线）
  copySubtitleTranscript(): Promise<void>;
  downloadSubtitle(): Promise<void>;
  buildClipSnapshotPayload(): Record<string, unknown>;
  readVideoDescription(): string;
}

async function loadSummarizeChain(): Promise<SummarizeChain> {
  // fetcher（抓取编排 + resetClipState）与 ui（clip 快照 payload / 复制下载回调）
  // 同属链层，一次 ensure 全部就位；两文件间本就互相引用（ui → fetcher），
  // 并行装载只是把等待重叠。
  const [fetcher, chainUi] = await Promise.all([import("./fetcher.js"), import("./ui.js")]);
  // 顶层副作用迁移（原 fetcher.js 模块求值时的 subscribeSubtitleRefresh(refreshClip)）：
  // 该注册依赖「fetcher 总在启动时装载」的假设。链改为按需装载后，注册时机
  // 与装载绑定——ensure 成功路径上执行一次（subscribeSubtitleRefresh 自带
  // 去重，重复调用安全）。
  (fetcher as { initSummarizeChain(): void }).initSummarizeChain();
  // 合并成单一 chain 门面：两模块导出无重名（fetcher=抓取编排，ui=payload/交互）。
  return { ...fetcher, ...chainUi } as SummarizeChain;
}

const chainLoader = createLazyLoader(loadSummarizeChain);

// 按需装载总结链，同一文档内重复调用共享同一 promise。
export function ensureSummarizeChain(): Promise<SummarizeChain> {
  return chainLoader.load();
}
