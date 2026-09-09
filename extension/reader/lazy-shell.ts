// reader/shell.ts（阅读壳唯一事务）的按需加载器（arch-slim-2/09）。
//
// 为什么惰性：shell 静态边拆除（ADR-0003 拆边方针）。message-handler 的四个
// reading-view 消息分支与 URL 跳转入口原先静态 import 本域的
// enterReaderShell / enterReaderShellOnUrlNavigation / exitReaderShell，把
// reader/shell.ts（13.5KB raw）借道拖进常驻包（约 1-2KB min，连带
// ai/player-ai-state）。改经本加载器后 shell 随 reader 域动态 chunk 按需下载：
// reader-enter 本来就要装载 reader 域，shell 随行净增≈0。
//
// 写法与 reader/lazy-reader.ts 同款：加载器本体收拢于 shared/lazy-import.ts
// 的 createLazyLoader（手写 promise 缓存 + 失败清缓存可重试的共享工厂）。
//
// 为什么直接写相对路径：本模块身处 ESM 主包模块图内，动态 import() 的相对
// 路径按扩展自身 URL 解析（bootstrap 已用 chrome.runtime.getURL 的绝对路径
// 拉起主包），无需也不应再经 getURL 拼绝对路径。
//
// 失败语义：加载失败清空缓存 promise，允许下次触发重试；消费方（message-handler
// 的消息分支）捕获后按「logWarn + ok:false 回包 / 状态栏失败文案」口径降级。
import { createLazyLoader } from "../shared/lazy-import.js";
import type {
  EnterReaderShellOptions,
  EnterReaderShellOnUrlNavigationOptions,
  ReaderShellIntent
} from "./shell.js";

// shell 的意图档类型随装载边对外透出（type-only，零运行时边）：消费方
//（entry/message-handler 的意图表）不直接静态 import shell 本体，守住
// shell-sequence 守卫的「调用方闭包」约束（shell 静态调用方仅 ui 两文件）。
export type { ReaderShellIntent };

// 阅读壳对外的窄接口（本加载器消费方只触达进入事务入口与事务收敛等待，
// 壳完好性自查 isReaderShellIntact 的消费方——ui/digest-button.ts——走自己的
// 静态轻边，不经本加载器）。
interface ReaderShellDomain {
  enterReaderShell(options: EnterReaderShellOptions): Promise<void>;
  enterReaderShellOnUrlNavigation(options: EnterReaderShellOnUrlNavigationOptions): Promise<void>;
  exitReaderShell(): Promise<void>;
}

const loader = createLazyLoader<ReaderShellDomain>(() => import("./shell.js"));

// 按需加载 reader/shell.ts，同一文档内重复调用共享同一 promise。
export function ensureReaderShell(): Promise<ReaderShellDomain> {
  return loader.load();
}
