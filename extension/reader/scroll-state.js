// 阅读视图滚动状态微模块。
//
// 这是 SYNC（./sync.js）与 LAYOUT（./page-frame.js + ./player-host.js）的共享
// 叶子模块：拥有手动滚动暂停与程序化滚动两个截止时间的唯一声明与读写函数。
// 放在独立叶子里，让 SYNC 与 LAYOUT 共享同一份状态而不需要访问器穿越
// reader-impl 的闭包 seam，也保持依赖图无环——本模块不 import reader 域内
// 任何其他模块（LAYOUT 仍然不得 import SYNC）。
// 函数体原样搬自 reader-impl.js 旧有的五个 set*/is*/reset* 访问器，行为零变化。

let manualScrollPauseUntil = 0;    // readingManualScrollPauseUntil
let programmaticScrollUntil = 0;   // readingProgrammaticScrollUntil

export function isManualScrollPaused() {
  return Date.now() < manualScrollPauseUntil;
}

export function resetManualScrollPause() {
  manualScrollPauseUntil = 0;
}

export function isProgrammaticScrolling() {
  return Date.now() <= programmaticScrollUntil;
}

export function setManualScrollPaused(until) {
  manualScrollPauseUntil = until;
}

export function setProgrammaticScrollUntil(until) {
  programmaticScrollUntil = until;
}
