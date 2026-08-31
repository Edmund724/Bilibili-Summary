// 样式注入器（S3 分层）：阅读表（styles/reader.css + styles/reader-gate.css）
// 与播放器 AI 表（styles/player-ai.css）不再经 manifest 常驻注入，改由本模块
// 在对应能力启用时挂载。
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

const mounted = new Map<string, HTMLLinkElement>();

function getReaderStylePaths(): string[] {
  return ["entry/styles/reader.css", "entry/styles/reader-gate.css"];
}

export function isReaderStylesMounted(): boolean {
  return getReaderStylePaths().every((path) => mounted.has(path));
}

export function ensureReaderStyles(): void {
  getReaderStylePaths().forEach((path) => mountStyleLink(path));
}

export function removeReaderStyles(): void {
  getReaderStylePaths().forEach((path) => unmountStyleLink(path));
}

export function isPlayerAiStylesMounted(): boolean {
  return mounted.has("entry/styles/player-ai.css");
}

export function ensurePlayerAiStyles(): void {
  mountStyleLink("entry/styles/player-ai.css");
}

export function removePlayerAiStyles(): void {
  unmountStyleLink("entry/styles/player-ai.css");
}

function mountStyleLink(path: string): void {
  if (mounted.has(path)) {
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL(path);
  link.dataset.bocStyle = "1";
  (document.head || document.documentElement).appendChild(link);
  mounted.set(path, link);
}

function unmountStyleLink(path: string): void {
  const link = mounted.get(path);
  if (!link) {
    return;
  }
  link.remove();
  mounted.delete(path);
}
