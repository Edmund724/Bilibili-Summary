# background 不做运行时惰性加载——收益走打包 minify 与源码拆链

MV3 service worker 在平台层面**不支持动态 `import()`**（Chrome 官方文档明确说明；crbug.com/40760920 至今未实现）。我们决定：**SW 的静态 import 图保持全静态**，体积与解析成本优化只走两条路——多入口打包 minify（scripts/build.js）与源码级拆链（把「为小用途拖入大模块」的静态边拆掉，例如 provider-store 的静音 WAV 探针不再拖入整个 chunker.js、连通性测试移出 SW）。动态 import 惰性化只允许在页面环境使用（content script、offscreen 文档、扩展页面）。

## 考虑过的方案

- **冷处理器内动态 import**（曾在本轮架构评审中提出）：平台直接禁止，写入即失效。
- **冷处理器整体搬离 SW**（挪去 offscreen/sidepanel）：消息往返变多、时序复杂化，为平台限制付架构代价，不值。

## 后果

- SW 冷启动解析量的下降来自 minify（177.5KB raw → 约 60KB 级）与拆链，而非运行时惰性。
- 架构评审（含 AI 代理）不得再提议 SW 运行时惰性化，除非 crbug/40760920 落地（重开条件）。
- content 与 offscreen 的惰性分包不受本 ADR 约束，仍是推荐手段。
