# 扩展仅支持 Chrome（Chromium），移除 Firefox 兼容

「一键总结」依赖 sidePanel（Chrome 114+）与 offscreen（Chrome 109+）两个 Chrome 专属 API，Firefox 下核心功能（侧边栏、offscreen 解码/转写）本就无法工作。我们决定：**发布只出 Chrome 单变体**；删除整套 Firefox 兼容——manifest 的 `browser_specific_settings.gecko`、build_release.py 的 Firefox 变体（sidebar_action 改写、sidePanel 权限摘除、打包期对 options.css/validators.js 的字符串补丁）以及 background/popup 里的 `globalThis.browser.sidebarAction.open()` 调用。

## 考虑过的方案

- **继续双变体发布**：Firefox 用户能装上但核心功能不可用；且打包期字符串补丁（改写 validators.js 的归一化函数、追加 CSS）极脆，重构时容易静默失效。
- **抽象 sidePanel/offscreen 的跨浏览器适配层**：为一个无法工作的目标建适配器——两个能力在 Firefox 没有对应物，接缝后没有第二个真实适配器（一适配器 = 假设接缝）。

## 后果

- build_release.py 只产出 chrome 变体；manifest 不再携带 gecko 块；侧边栏打开统一走 chrome.sidePanel。
- 代码里不允许再出现 `browser.*` 命名空间或 sidebar_action 分支。
- 重开条件：若未来要支持 Firefox，必须先解决 sidePanel 与 offscreen 两个能力的替代（内置 sidebar + 事件页后台），属能力问题而非配置问题。
