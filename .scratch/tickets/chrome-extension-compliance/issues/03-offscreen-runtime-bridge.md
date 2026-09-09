# 03: offscreen-runtime-bridge

**What to build:** 收紧 Offscreen 文档职责，使其只负责 Web API 工作并通过 `chrome.runtime` 与 Service Worker 协作；所有扩展级 API 由后台侧可靠执行。

**Blocked by:** #01 `async-await-promise-migration`

**Status:** ready-for-agent

- [ ] Offscreen 文档不再直接调用 Storage、Offscreen 关闭接口或其他扩展级 Chrome API，只保留标准 Web API 与 `chrome.runtime` 消息能力
- [ ] 创建 Offscreen 文档、读取会话/持久数据、关闭文档和控制快捷动作的请求均由 Service Worker 执行并明确返回成功或失败
- [ ] Offscreen 文档创建失败不再被吞掉；原始错误能准确回到调用链并进入现有可读错误处理
- [ ] 后台消息入口校验发送者来源、内部消息 schema 和标签页归属，拒绝未知或跨标签页请求而不执行副作用
- [ ] ASR quick action 的 Offscreen 与内容脚本消息使用同一目标约束，防止跨标签页或迟到响应污染当前视频
- [ ] 测试覆盖成功关闭、后台重启、创建失败、非法消息、迟到响应和跨标签页场景
- [ ] `npm run build`、`npm run typecheck` 与 `npm test` 通过
