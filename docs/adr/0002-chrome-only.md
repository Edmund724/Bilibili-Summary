# 扩展仅支持 Chrome（Chromium），移除 Firefox 兼容

「一键总结」当前使用页面内的 Digest 阅读面板，不使用 Chrome Side Panel。工具栏 action 与页面内 Digest 按钮进入同一阅读壳；音频解码与转写仍依赖 Chrome 的 offscreen 能力。我们决定：**只发布 Chrome / Chromium 版本，最低版本为 Chrome 120**；不维护 Firefox 变体，也不保留 `browser_specific_settings.gecko`、`sidebar_action` 或 `browser.sidebarAction.*` 分支。

## 考虑过的方案

- **继续双变体发布**：Firefox 用户能装上但核心功能不可用；打包期的字符串补丁也很脆，重构时容易静默失效。
- **抽象阅读入口 / offscreen 的跨浏览器适配层**：为一个无法工作的目标建适配器。阅读载体与后台音频能力在 Firefox 中没有对应的真实适配器，这条接缝没有第二个实现可验证。
- **改用 Chrome Side Panel**：会增加第二套阅读承载方式。工具栏与页面按钮必须共享进入、退出和标签状态，否则同一视频会出现两个入口行为不一致。

## 后果

- `build_release.py` 只产出 Chrome 变体；Manifest 不再携带 gecko 块。
- Digest 面板通过 `reader-enter` 打开；工具栏 action 与页面内 Digest 按钮调用同一入口，不新增 Side Panel。
- 最低版本声明统一为 Chrome 120。代码里不允许再出现 `browser.*`、Side Panel 或 `sidebar_action` 分支。
- 重开 Firefox 的条件：先提供与 Digest 等价的阅读载体和 offscreen 音频能力替代，并重新验收播放器同步、音频处理与发布范围。这不是只改配置就能完成的工作。
