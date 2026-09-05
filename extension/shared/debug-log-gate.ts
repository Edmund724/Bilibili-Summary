// extension/shared/debug-log-gate.ts
// 调试日志门的三宿主接线（SW / offscreen / content 启动时各调一次）：
// 初始读一遍设置 + storage.onChanged 保活，把开关喂给 shared/logging 的
// 注册门——logging 自身保持无 chrome、无 core 依赖的纯叶子。修复点：此前
// 门读 state.settings，SW/offscreen 里无人 setSettings，用户开的调试日志在
// 这两个宿主永远静默。键名 enableDebugLogs 归 DEFAULT_SETTINGS（core/defaults.js）
// 所有，存储区与 settings-store 同为 sync；本叶子按叶子纪律不 import core/*。

import { registerDebugGate } from "./logging.js";

export function registerDebugLogGate(): void {
  // 宿主差异容忍：storage 不可用（如仅 stub runtime 的测试环境）时直接返回，
  // 门维持缺省关——调试日志是诊断辅助，接线本身绝不致命。
  if (typeof chrome === "undefined" || !chrome.storage?.sync?.get || !chrome.storage?.onChanged?.addListener) {
    return;
  }
  let enabled = false;
  registerDebugGate(() => enabled);
  chrome.storage.sync.get("enableDebugLogs").then((data) => {
    enabled = Boolean((data as { enableDebugLogs?: unknown })?.enableDebugLogs);
  }).catch(() => {
    // 读失败维持缺省关：调试日志是诊断辅助，不该为它抛未处理拒绝。
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.enableDebugLogs) {
      enabled = Boolean(changes.enableDebugLogs.newValue);
    }
  });
}
