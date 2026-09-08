// extension/logging.ts
// Debug-gated logging helpers. Single source of truth for logInfo / logWarn /
// logError so modules can be self-contained without importing the DOM-heavy reader-shell.js.
//
// 调试门由宿主注册（registerDebugGate，接线见 ./debug-log-gate.ts）：本模块
// 保持纯叶子——不 import core/state（SW/offscreen 里 state.settings 恒为缺省
// 克隆，读它会让用户开的调试日志在这两个宿主永远静默），也不碰 chrome.*。
// 未注册时缺省关。
//
// 门挂 globalThis 而非模块级变量：两轮构建（scripts/build-content.js）把常驻
// 底座在轮 B 懒 chunk 区重复一份，本模块在 content-main 与 chunks/ 共享 chunk
// 里各是一个实例——注册发生在常驻包实例（content.ts 的 registerDebugLogGate），
// 而抓取链/reader/对话用的是懒加载区那份，模块级门在两侧互不通用，用户开了
// 「调试日志」也捞不到 [BOC] 行。隔离世界的 globalThis 在同一扩展的全部
// content 模块间唯一，两侧经它对齐到同一份门（与 shared/messaging.ts 的页内
// 分发槽、reader/reader-bus.ts 的槽表同款先例）。SW/offscreen 单实例宿主不受
// 影响（各 context 有各自的 globalThis）。
//
// 槽用可变对象而非直接放函数：后注册覆盖先注册的语义与旧实现逐字一致，且
// minified 体积最小（SW 包体积守卫余量以字节计）。

interface DebugGateSlot {
  gate: () => boolean;
}

// 槽键命名约定（跨实例共享槽一律 `*_SLOT_KEY = "__BOC_...__"`）：
// scripts/build-content.js 的 assertSharedSlotsInBothRegions 按此约定扫源码，
// 断言每个槽键在常驻包与懒加载区产物里都出现。
const DEBUG_GATE_SLOT_KEY = "__BOC_LOG_GATE__";

const sharedGateSlot = ((globalThis as unknown as Record<string, DebugGateSlot | undefined>)[DEBUG_GATE_SLOT_KEY] ??= {
  gate: () => false
});

// 宿主启动时注册调试门判定；后注册覆盖先注册。
export function registerDebugGate(gate: () => boolean): void {
  sharedGateSlot.gate = gate;
}

export function shouldDebugLog(): boolean {
  return sharedGateSlot.gate();
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
