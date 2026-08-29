// LAYOUT（page-frame.js / player-host.js）调用 SYNC 域的反环 seam 叶子。
//
// sync.js 在模块加载时经 registerSyncAdapter 注册其函数表；LAYOUT 两域的函数
//（moveReadingMainInline 的滚动回调、bindReadingViewVideo 的同步回调）经
// callSync 在调用时解析，保证依赖图无环（LAYOUT 层永不静态 import sync.js）。
// 注册槽位与两个函数逐字节搬自原 reader-impl.js（原 :152-165，callSync 原为
// 模块私有，现因两域共用而显式导出）。

let syncAdapter = null;

export function registerSyncAdapter(adapter) {
  syncAdapter = adapter || null;
}

export function callSync(name, ...args) {
  return syncAdapter?.[name]?.(...args);
}
