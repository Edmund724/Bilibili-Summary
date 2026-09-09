# 05: chrome-compatibility-and-docs

**What to build:** 统一用户文档、架构决策和发布元数据中的 Chrome 120+ 兼容性、Digest 两个入口、权限用途、数据流向与缓存边界声明，消除 Side Panel 和 Firefox 兼容的过时描述。

**Blocked by:** #02 `toolbar-icon-opens-digest`、#03 `offscreen-runtime-bridge`、#04 `asr-audio-permission-rule-lifecycle`

**Status:** ready-for-agent

- [ ] README 与相关架构决策明确最低 Chrome 120 / Chromium、不支持 Firefox，不再把功能写成依赖 Chrome Side Panel
- [ ] 文档明确页面内 Digest 按钮与工具栏图标点击等价，且设置、字幕、概览、对话和笔记都位于页面内 Digest 面板
- [ ] 文档逐项、具体说明 Manifest 权限和 host 权限的用户用途，不使用“为扩展工作所需”之类笼统 justification
- [ ] 数据使用声明准确说明本地存储/同步、ASR 音频的触发条件、传输目标和无字幕以外不抓取音频的边界
- [ ] 文档声明字幕 segment cache 的最大项数、最大字节数和待写并发上限，并与实现实际常量保持一致；即使平台暂无上限也明确写明当前行为
- [ ] Chrome Web Store 相关元数据若属于本项目发布流程，则同步描述/权限说明，不承诺尚未完成或与实现不一致的能力
- [ ] 相关文档、类型检查和项目构建校验通过
