// ui/digest-button.ts 的按需加载器（统一 Digest 阅读模式 PR1）。
//
// 为什么惰性：Digest 按钮只在 /video/ 播放页有职责，且其水合等待链
// （poll <video> + SETTLE_DELAY_MS）不应急着在 watchlater 等支持的普通页上跑。
// content.ts 在 getSettings().then 的非阅读模式分支触发装载（与 loadPlayerAi
// 同款动态 import 边），分包后本模块随动态 chunk 按需下载。
//
// 为什么直接写相对路径：本模块身处 ESM 主包模块图内，动态 import() 的相对
// 路径按扩展自身 URL 解析（bootstrap 已用 chrome.runtime.getURL 的绝对路径
// 拉起主包），无需也不应再经 getURL 拼绝对路径。
//
// 失败语义：加载失败清空缓存 promise，允许下次触发重试（与 lazy-player-ai 一致）。
//
// 「未加载」的语义约定（消费方依赖它做等价性判断）：模块未加载 ⇒ 按钮从未
// 挂上 ⇒ removeDigestButton 是 no-op。装载面：content.ts 的 getSettings().then
// 两个分支（非阅读模式 + 阅读模式直达）都装载本模块——直达分支装载不为按钮
// （自查守卫在阅读模式下恒摘除），为的是视图失同步自愈与「关闭视图后补回
// 按钮」（见 ui/digest-button.ts 头注）；按钮注入本身由 syncDigestButton 按
// isReaderViewOpen/isReaderMode 守卫，两种路径下都不会在阅读模式开着时挂出。
interface DigestButtonDomain {
  removeDigestButton(): void;
}

import { createLazyLoader } from "../shared/lazy-import.js";

const loader = createLazyLoader<DigestButtonDomain>(() => import("../ui/digest-button.js"));

// 按需加载 ui/digest-button.ts，同一文档内重复调用共享同一 promise。
export function loadDigestButton(): Promise<DigestButtonDomain> {
  return loader.load();
}

// 模块是否已存在加载请求（含仍在加载中）。消费方用它区分「未加载可跳过」
// 与「已加载/加载中需继续走异步路径」。
export function isDigestButtonLoaded(): boolean {
  return loader.isLoaded();
}
