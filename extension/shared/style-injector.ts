// 样式注入器（S3 分层）：阅读表（styles/reader.css + styles/reader-gate.css）、
// 播放器 AI 表（styles/player-ai.css）、设置分区表（styles/reader-settings.css，
// arch-slim-4/04）与对话分区表（styles/reader-chat.css，arch-slim-4/07）不再经
// manifest 常驻注入，改由本模块在对应能力启用时挂载。
//
// 挂载机制：<link rel="stylesheet" href="chrome.runtime.getURL(...)">。link
// 挂进页面 DOM 后由页面渲染管线加载，属页面侧资源访问——三份样式表依赖
// manifest WAR 里的 "entry/styles/*" 放行（matches 限 www.bilibili.com）。
//
// 为什么不用 fetch + textContent/adoptedStyleSheets：内容脚本建 link 的样式
// 参与级联顺序与原 manifest css 注入一致（同为文档级样式表，晚挂则靠后），
// 且无需在 JS 里维护 CSS 文本；adoptedStyleSheets 还要在每个宿主元素上挂接
// 并复刻级联位置，收益为零。
//
// 幂等/防泄漏：挂载记录存 Map，重复挂同路径直接跳过；移除按引用摘 link 并
// 从 Map 删除。移除不是「卸载语义」——数据留在浏览器样式缓存，重挂几乎零
// 成本（这正是「关→开」二进宫无闪变的关键：样式数据已在内存，重挂即生效）。
//
// 挂载记录与设置表的 ready promise 挂 globalThis 而非模块级变量：两轮构建
//（scripts/build-content.js）把常驻底座在轮 B 懒 chunk 区重复一份，本模块在
// content-main 与 chunks/ 共享 chunk 里各是一个实例——挂载点本就分居两侧
//（常驻 entry/content.ts 的直达阅读 URL 路径、懒加载区 reader/shell.ts 的进入
// 事务），各记各的 Map 会让同一路径被注入两个 <link>，且一侧 removeReaderStyles
// 摘不掉另一侧那个（退出阅读模式后样式表残留）。隔离世界的 globalThis 在同一
// 扩展的全部 content 模块间唯一，两侧对齐到同一份记录（与 shared/messaging.ts
// 的页内分发槽、reader/reader-bus.ts 的槽表、core/state.ts 的状态单例同款
// 先例）。

interface StyleInjectorSlots {
  mounted: Map<string, HTMLLinkElement>;
  // 设置分区表的首挂 ready promise（null = 尚未首挂）；同表跨实例共享，
  // 后求值的实例经 whenReaderSettingsStylesReady 等的是同一份。
  readerSettingsReady: Promise<void> | null;
}

const STYLE_SLOT_KEY = "__BOC_STYLE_INJECTOR__";

function styleSlots(): StyleInjectorSlots {
  const host = globalThis as unknown as Record<string, StyleInjectorSlots | undefined>;
  return (host[STYLE_SLOT_KEY] ??= { mounted: new Map(), readerSettingsReady: null });
}

function getReaderStylePaths(): string[] {
  return ["entry/styles/reader.css", "entry/styles/reader-gate.css"];
}

export function isReaderStylesMounted(): boolean {
  return getReaderStylePaths().every((path) => styleSlots().mounted.has(path));
}

export function ensureReaderStyles(): void {
  getReaderStylePaths().forEach((path) => mountStyleLink(path));
}

export function removeReaderStyles(): void {
  getReaderStylePaths().forEach((path) => unmountStyleLink(path));
}

export function isPlayerAiStylesMounted(): boolean {
  return styleSlots().mounted.has("entry/styles/player-ai.css");
}

export function ensurePlayerAiStyles(): void {
  mountStyleLink("entry/styles/player-ai.css");
}

export function removePlayerAiStyles(): void {
  unmountStyleLink("entry/styles/player-ai.css");
}

// 设置分区表（arch-slim-4/04）：随 ui/settings-panel chunk 按需装载（模块顶层
// ensure，抽屉首次打开才动态 import 该 chunk）。onload 门控：首挂时等 link load
// 再渲染抽屉内容（~50ms 兜底超时），首帧零闪变；重挂命中 mounted Map 即时渲染。
// 与 reader/player-ai 表不同：exitReaderShell 不摘除——设置表数据留在浏览器
// 样式缓存，二进宫免闪变（同 reader 主表「link 数据在缓存」口径）。
export function ensureReaderSettingsStyles(): void {
  const path = "entry/styles/reader-settings.css";
  const slots = styleSlots();
  const isFirstMount = !slots.mounted.has(path);
  const link = mountStyleLink(path);
  if (!isFirstMount) {
    return;
  }
  // link 可能已缓存命中（load 已触发过或同步完成），readyState/监听双口径。
  slots.readerSettingsReady = new Promise<void>((resolve) => {
    const done = () => resolve();
    if (link.sheet) {
      done();
      return;
    }
    link.addEventListener("load", done, { once: true });
    link.addEventListener("error", done, { once: true });
    // 兜底：load 事件异常不达（如宿主扩展上下文异常）时放行渲染，闪变概率
    // 换可用性——体验优先（grilling Q7 决策）。
    window.setTimeout(done, 50);
  });
}

export function whenReaderSettingsStylesReady(): Promise<void> {
  return styleSlots().readerSettingsReady ?? Promise.resolve();
}

// 对话分区表（arch-slim-4/07）：随对话域首次激活按需装载，不建 onload 门控
//（1-2 帧无样式窗口只落在未激活的静默空态上）。挂载点两个：setReaderDigestTab
// 的 chat 分支同步 ensure（盖住 tab 点击/解释卡/快捷动作全部入口），reader/
// chat-tab.ts 模块顶层兜底（盖住未来入口）。与设置表同口径：exitReaderShell
// 不摘除，数据留在浏览器样式缓存，二进宫免闪变。
export function ensureReaderChatStyles(): void {
  mountStyleLink("entry/styles/reader-chat.css");
}

export function removeReaderChatStyles(): void {
  unmountStyleLink("entry/styles/reader-chat.css");
}

export function isReaderChatStylesMounted(): boolean {
  return styleSlots().mounted.has("entry/styles/reader-chat.css");
}

function mountStyleLink(path: string): HTMLLinkElement {
  const { mounted } = styleSlots();
  let link = mounted.get(path);
  if (link) {
    return link;
  }
  link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL(path);
  link.dataset.bocStyle = "1";
  (document.head || document.documentElement).appendChild(link);
  mounted.set(path, link);
  return link;
}

function unmountStyleLink(path: string): void {
  const { mounted } = styleSlots();
  const link = mounted.get(path);
  if (!link) {
    return;
  }
  link.remove();
  mounted.delete(path);
}
