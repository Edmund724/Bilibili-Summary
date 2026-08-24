# 13: 最终集成验证 & 回归冒烟

**What to build:**
- 在 B 站视频页、稍后观看页、阅读视图、AI 侧边栏、popup、options 全链路手动/自动化验证
- 确认无 `state.xxx` 引用断裂、无 module import 顺序问题、无 defaults 加载失败
- 提交统一的 architecture review 更新

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12

**Status:** ready-for-agent

- [ ] 视频页面板可弹出、字幕可抓取、可复制/下载
- [ ] 稍后观看页功能正常
- [ ] 阅读视图可打开、字幕同步、播放器联动正常
- [ ] AI 侧边栏可打开、对话正常
- [ ] popup 设置读取正常
- [ ] options AI 预设列表渲染正常
- [ ] background service worker 无报错
- [ ] 无 `state.xxx` 引用断裂
- [ ] 无 module import 顺序问题
- [ ] architecture review 文档已更新

## Comments

- 2025-08-24: 静态集成验证完成，发现并修复 2 个 ES module import 缺失导致的运行时 ReferenceError：
  - `extension/reader.js` 补充导入 `normalizeReaderTheme`、`normalizeReaderFontScale`、`normalizeReaderLetterSpacing`、`normalizeReaderLineHeight`、`normalizeReaderContentWidth`、`normalizeReaderTranscriptVisible`
  - `extension/formatters.js` 补充导入 `normalizeFixedPropertyType`、`isFixedPropertyRowEffectivelyEmpty`、`normalizeNotePlaceholderSections`
- 已确认 `extension/defaults.js` 已删除，`manifest.json` 中 `content_scripts` 与 `background` 均为 module 类型。
- 已确认 `state.xxx` 引用无断裂，所有访问属性均在 `state.js` 的领域 state / stateTarget 中定义。
- 已确认 `content-classic.js` bundle 与模块版本在 `DEFAULT_SETTINGS`、`state` Proxy、`hydrateReaderStateFromSettings` 等关键逻辑上一致。
- 已更新 `architecture-review.html`，新增 Implementation Status 节，标记 Candidates 1/2/5/6/7 已完成，Candidate 8 部分完成。
- 以下项目需要实际浏览器环境手动验证：
  - 视频页 / 稍后再看页 / 阅读视图 / AI 侧边栏 / popup / options 全链路功能
  - background service worker 启动与消息路由
  - content-classic.js 动态注入后的运行状态
