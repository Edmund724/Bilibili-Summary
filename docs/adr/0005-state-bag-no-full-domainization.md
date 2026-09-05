# core/state.ts 状态袋不再全域化——只做 playerAi 单切片

core/state.ts 以「Readonly 业务字段 + setter 白名单」的状态袋聚合 reader/clip/ui（原 playerAi）
四个命名空间（见 docs/state-contract.md）。曾有提案将其按域全部拆出（reader 归 reader/、clip 归
subtitle/ 等）。我们决定：**状态袋不做全域化，只把完全内聚的 playerAi 单切片迁出**——迁至
`extension/ai/player-ai-state.ts`，其余命名空间维持现状。

## 理由

- **编译期只读契约已兜底误写面**：TS `Readonly` 业务字段 + setter 白名单使直接写业务字段在
  `tsc --noEmit` 即失败，域归属搬迁并不能进一步缩小误写面，收益只剩「文件归属美学」。
- **ui 命名空间是弱聚合、无属主**：7 个字段散布 8 个文件读写，没有单一域可承载；拆出去只会
  变成 N 个单字段状态袋，聚合本身消失，比现状更差。
- **clip 的真解耦点在读面不在写面**：写面已被字幕接受事务收口（subtitle/commit.js 的
  acceptSubtitle 是 subtitleFetchState → "ready" 的唯一写入点，无字幕原因经逆事务
  commitNoSubtitle 写入）；真正的耦合是 reader/lifecycle 对 clip 15 个字段的渲染读依赖。
- **reader 命名空间迁出会牵动 Settings 接口的跨进程归属**：options 页与 background 也读
  reader 相关设置，命名空间搬迁会把这些跨进程读写一并卷入，超出状态袋议题的边界。

## 考虑过的方案

- **全域化拆分**（reader → reader/、clip → subtitle/、ui → 各消费点）：ui 无属主、clip 解耦点
  错位、reader 牵动跨进程 Settings 归属，三块各自失败，全域化不成立。
- **保持四命名空间原状不动**：playerAi 是唯一的例外——全仓只有 `ai/player-ai.ts` 一个业务
  读写方，外加 `core/message-handler.ts` 一处 `setSuppressedUntil`；它是纯内聚切片，迁出零
  牵连（defaults.ts 零改动），放着不迁只是留下一处「core 袋里住着 ai 域私有状态」的错位。

## 后果

- core/state.ts 收敛为三命名空间（reader/clip/ui）+ settings；playerAi 命名空间由
  `ai/player-ai-state.ts` 提供（同构的 Readonly + setter 形状），`state.playerAi` /
  `playerAiState`（core 版）别名移除。
- core/message-handler.ts 对 player-AI 的唯一写入改走意图级 `suppressUntil(timestamp)`，
  ai 域外的调用方不接触具体槽位；player-ai 动态 chunk 的 S3 分层不受影响（message-handler
  仍只静态依赖状态微模块，不依赖 player-ai.js 本体）。
- 架构评审（含 AI 代理）不得再提议 reader/clip/ui 命名空间的归属搬迁。
- 重开条件：若未来要动 clip，正确切入点是 lifecycle 渲染的数据来源（参数注入/快照传递），
  而非状态归属搬迁。
