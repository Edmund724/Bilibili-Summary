# 02: toolbar-icon-opens-digest

**What to build:** 点击扩展工具栏图标时，以当前活动 B 站视频标签页为目标打开页面内 Digest 面板；该入口与页面内 Digest 按钮使用同一阅读壳事务和激活语义。

**Blocked by:** #01 `async-await-promise-migration`

**Status:** ready-for-agent

- [ ] 工具栏 action click 使用与页面内 Digest 按钮相同的 reader-enter 事务，不创建 popup、Side Panel 或第二套打开流程
- [ ] 目标标签页只取 `chrome.action.onClicked` 事件提供的活动标签页；消息载荷中的 `tabId` 不能覆盖或伪造目标
- [ ] 仅向受支持的 B 站视频/稍后再看页面派发打开请求，并拒绝或忽略跨标签页消息混入
- [ ] 重复点击、活动标签页切换和页面内按钮路径不会把 Digest 请求投递到错误标签页
- [ ] 新增或更新的测试覆盖 action 入口、页面按钮等价性、目标和消息来源边界
- [ ] `npm run build`、`npm run typecheck` 与相关测试通过
