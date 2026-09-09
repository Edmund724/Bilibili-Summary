# 01: async-await-promise-migration

**What to build:** 将扩展运行时代码中的 Promise `.then()` 链改为等价的 `async`/`await` 流程，保持消息响应、顺序、错误传播和用户行为不变。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 审计发现的扩展运行时 Promise 链已全部转换，生产扩展代码中不再残留 `.then()` 链式调用
- [ ] `runtime.onMessage` 等异步消息处理在返回异步响应时保留正确的通道生命周期，不让消息静默无响应
- [ ] 并发、顺序和错误处理语义与迁移前等价，失败不会被新增 `try/catch` 静默吞掉
- [ ] `npm run build`、`npm run typecheck` 与 `npm test` 通过
