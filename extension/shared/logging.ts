// extension/logging.ts
// Debug-gated logging helpers. Single source of truth for logInfo / logWarn /
// logError so modules can be self-contained without importing the DOM-heavy reader-shell.js.
//
// 调试门由宿主注册（registerDebugGate，接线见 ./debug-log-gate.ts）：本模块
// 保持纯叶子——不 import core/state（SW/offscreen 里 state.settings 恒为缺省
// 克隆，读它会让用户开的调试日志在这两个宿主永远静默），也不碰 chrome.*。
// 未注册时缺省关。

let debugGate: () => boolean = () => false;

// 宿主启动时注册调试门判定；后注册覆盖先注册。
export function registerDebugGate(gate: () => boolean): void {
  debugGate = gate;
}

export function shouldDebugLog(): boolean {
  return debugGate();
}

export function logInfo(...args: unknown[]): void {
  if (shouldDebugLog()) {
    console.info(...args);
  }
}

export function logWarn(...args: unknown[]): void {
  if (shouldDebugLog()) {
    console.warn(...args);
  }
}

export function logError(...args: unknown[]): void {
  if (shouldDebugLog()) {
    console.error(...args);
  }
}
