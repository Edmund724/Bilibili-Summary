# Chrome 扩展合规与 2.1.0 发布准备

本任务把 Chrome 扩展规范审计发现的问题拆成可独立验收的实施票，并明确 2.1.0 发布前的文档、真实浏览器与最终打包边界。

## 已完成的产品决策

- 工具栏图标点击与页面内 Digest 按钮点击等价：两者都进入同一个阅读壳事务，不新建 Chrome Side Panel。
- 当前 Manifest 没有 `default_popup`，因此工具栏入口使用 action click；实现必须只使用 action 事件给出的当前标签页。
- 最低支持版本统一声明为 Chrome 120；只发布 Chrome/Chromium，不声明 Firefox 支持。
- 2.1.0 的 `package.json`、Manifest 和内部版本常量已经一致；本次只同步锁文件的顶层版本字段。
- release 包不在本任务中重新生成。完成全部实施与真实 Chrome 验收后，由用户执行最终打包。

## 工作流与依赖

1. 先清理 Promise 链，降低后续异步入口和消息桥接的行为风险。
2. 在干净的异步基础上接入工具栏 action 入口与阅读壳事务。
3. 收紧 Offscreen 与 Service Worker 的职责边界，避免 Offscreen 直接调用不支持的 Chrome API。
4. 完成 ASR 域名、DNR 生命周期、累计资源与规则重建约束。
5. 最后统一兼容性、权限、数据和缓存声明，供真实浏览器验收使用。
6. 全部 ticket 完成后，在真实 Chrome 上验收，再由用户重新打包 release。

```text
01 完成 ─┬─> 02 完成 ─┬─> 05 完成 ─> 06 完成（含用户最终打包）
         │             │
01 完成 ─┴─> 03 完成 ─┴─> 04 完成
```

## 非目标

- 不重新引入 Side Panel、popup 或 Firefox 变体。
- 不修改或删除现有 release zip。
- 不把版本同步、README/ADR 声明重复建成实施票。
- 不扩展到与本审计无关的 UI、AI 或打包重构。

## 完成定义

- 六张实施票均完成并通过各自验收。
- `npm run build`、`npm run typecheck`、`npm test` 全部通过。
- 真实 Chrome 120+ 上完成两个入口等价、权限授权、Offscreen ASR、Service Worker 重启、DNR 与资源上限验收。
- 2.1.0 的最终 release zip 由用户基于通过验收的代码重新生成。
