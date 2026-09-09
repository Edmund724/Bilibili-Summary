# 06: chrome-runtime-acceptance

**What to build:** 在真实 Chrome 120+ 浏览器中完成 2.1.0 运行时验收，证明工具栏入口、页面内 Digest、权限、Offscreen ASR、Service Worker 生命周期、DNR 规则和资源上限符合本任务约束。

**Blocked by:** #05 `chrome-compatibility-and-docs`

**Status:** ready-for-agent

- [ ] 卸载/重载扩展后，工具栏图标点击与页面内 Digest 按钮在视频页和稍后再看页都以等价方式打开同一阅读面板
- [ ] 快速重复点击、活动标签页切换、多个视频标签页和迟到 ASR 响应不会投递到错误标签页
- [ ] 无字幕视频授权并抓取真实音频，实际 ASR 请求使用 Manifest 已声明的窄 host 权限和生效的 Referer/Origin 规则
- [ ] 主动终止或等待 Service Worker 重启后，Offscreen 创建、ASR 消息和动态 DNR 规则恢复正常，无重复规则和残留资源
- [ ] 人为触发文件创建、后台终止和 ASR 失败，确认错误可见、错误被清理且音频累积下载量/内存/转换并发不超过 ticket 约定上限
- [ ] `npm run build`、`npm run typecheck`、`npm test` 在最终代码上全部通过
- [ ] 不修改现有 release zip；以上验收通过后才由用户重新生成并检查 2.1.0 release 包
