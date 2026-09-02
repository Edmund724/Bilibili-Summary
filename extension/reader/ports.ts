// Reader 域唯一显式端口（候选06「端口半边」）。
//
// 本模块是 reader 依赖图的最底层叶子：不 import reader 域内任何模块，只被
// LAYOUT（video-bind.js）与 SYNC（sync.js）引用，承载全部
// 「逆依赖方向」的回调——即下层域需要上层域服务、而依赖图禁止静态 import
// 边的场景。它替换了此前的两个隐式注册槽：
//   1. sync-adapter.js 的 registerSyncAdapter/callSync（`?.[` 可选链解析，
//      适配器缺失时静默返回 undefined——已随本端口删除该文件）；
//   2. player-host.js 的 setReadingSubtitleFlush 基座槽（无实现时静默返回
//      true——player-host 已随整页接管退役删除）。
//
// 层图（保持既有方向不变，ports.js 为叶子）：
//   ports.js   显式方法集（本文件，零依赖叶子）
//   LAYOUT     video-bind.js + digest-host.js        → ports
//   SYNC       sync.js                               → LAYOUT + ports
//   LIFECYCLE  lifecycle.js                          → SYNC + LAYOUT（并在
//              模块求值时单点注册端口实现）
//
// 方法集只从真实调用点推导，禁止预留死槽位：
//   - noteManualReaderInteraction     LAYOUT(video-bind) → SYNC      阅读视图手动滚动/滚轮暂停跟随
//   - syncReadingViewPlayback         LAYOUT(video-bind) → SYNC     视频事件驱动的播放↔字幕同步
//   - flushReadingSubtitleToIndex   SYNC → LIFECYCLE               字幕分批渲染的同步补渲染
// （旧 callSync 注册表里其余名字——startReadingViewSync/stopReadingViewSync/
// updateReaderFollowState/resetManualScrollPause/setProgrammaticScrollUntil——
// 从无 callSync 调用点，属死注册，不进端口；它们本来就经合法静态边消费。）
//
// 纪律：
//   - 缺失即抛错：未注册（或注册表缺方法）时调用任何端口方法直接抛错，
//     禁止静默 undefined/true 回退；
//   - 单点注册：reader 域组装根 lifecycle.js 在模块求值时一次性注册全部实现
//     （LIFECYCLE → SYNC 是合法边，sync.js 的函数声明在该时刻已提升完整）；
//   - 重复注册报错：二次 registerReaderPorts 直接抛错，防止实现被静默覆盖。
//     模块加载是同步的，lifecycle 注册先于任何事件回调，运行期不会遇到
//     「未注册」窗口。

// 端口方法名全集（冻结）：注册校验与测试都以此为准。
export const READER_PORT_METHODS = Object.freeze([
  "noteManualReaderInteraction",
  "syncReadingViewPlayback",
  "flushReadingSubtitleToIndex"
]);

export type ReaderPortImpls = {
  noteManualReaderInteraction: (...args: unknown[]) => unknown;
  syncReadingViewPlayback: (...args: unknown[]) => unknown;
  flushReadingSubtitleToIndex: (...args: unknown[]) => unknown;
};

let portImpls: ReaderPortImpls | null = null;

// reader 域组装根（lifecycle.js）启动时的唯一注册入口。
// 注册表必须精确覆盖方法集：缺方法抛错（防实现缺失静默化），多出未知键也
// 抛错（防拼写漂移悄悄绕过显式方法集）。
export function registerReaderPorts(impls: ReaderPortImpls) {
  if (portImpls) {
    throw new Error("[BOC] reader 端口重复注册：只允许 lifecycle 启动时单点注册一次。");
  }
  if (!impls || typeof impls !== "object") {
    throw new Error("[BOC] reader 端口注册缺少实现表。");
  }
  const missing = READER_PORT_METHODS.filter((name) => typeof impls[name as keyof ReaderPortImpls] !== "function");
  if (missing.length > 0) {
    throw new Error(`[BOC] reader 端口注册缺少方法：${missing.join(", ")}`);
  }
  const unknown = Object.keys(impls).filter((name) => !READER_PORT_METHODS.includes(name));
  if (unknown.length > 0) {
    throw new Error(`[BOC] reader 端口注册含未知方法：${unknown.join(", ")}（方法集见 READER_PORT_METHODS）`);
  }
  portImpls = { ...impls };
}

// 取已注册实现；缺失直接抛错（不静默）。刻意不用可选链索引写法，
// 杜绝「`?.[` 式静默端口调用」回潮。
function requirePortMethod(name: keyof ReaderPortImpls) {
  const handler = portImpls ? portImpls[name] : null;
  if (typeof handler !== "function") {
    throw new Error(`[BOC] reader 端口方法 ${name} 未注册（应由 lifecycle 启动时单点注册）。`);
  }
  return handler;
}

// 显式方法集：逐个列出、不做动态名字分发。LAYOUT/SYNC 域只经本对象回调
// reader 上层域，方法签名与被替换的旧 callSync/flush 槽逐一对应。
export const readerPorts = {
  // LAYOUT(video-bind) → SYNC：阅读视图 scroll/wheel 的手动交互通知。
  noteManualReaderInteraction(...args: unknown[]) {
    return requirePortMethod("noteManualReaderInteraction")(...args);
  },
  // LAYOUT(video-bind) → SYNC：视频 timeupdate/seeked/loadedmetadata 驱动同步。
  syncReadingViewPlayback(...args: unknown[]) {
    return requirePortMethod("syncReadingViewPlayback")(...args);
  },
  // SYNC → LIFECYCLE：跳转/跟随目标未上屏时的同步补渲染（分批渲染任务的
  // 实现属主是 lifecycle.js，经此端口供给 sync.js）。
  flushReadingSubtitleToIndex(...args: unknown[]) {
    return requirePortMethod("flushReadingSubtitleToIndex")(...args);
  }
};
