# Shadow DOM 适用边界——判定：不迁

审计 S4（"面板与阅读视图容器挂 Shadow DOM"）的裁决。结论：**不实施 Shadow DOM 迁移**，扩展自有子树继续留在 light DOM，就地搬移的 B 站节点留在 light DOM。

## 结论

| 对象 | 判定 | 理由 |
| --- | --- | --- |
| 面板 `#boc-panel`、阅读视图 `#boc-reading-view` 等扩展自有子树 | **不迁** | 收益已被 S3 分层兑现大半；迁移的边界成本（事件冒泡、焦点、可访问性、时序）高于剩余收益，见下 |
| 播放器 AI 按钮 `.boc-player-ai-wrap` | 不迁 | 必须活在 B 站播放器子树内（依赖 `closest()` 找宿主），shadow 隔离会切断其与播放器 DOM 的互操作 |
| B 站自身节点（main/播放器/页头页脚） | **不进 shadow** | 事实 1/2 见下；就地搬移节点留在 light DOM |
| B 站 light DOM 门控规则（约 12 KB） | 留在 light DOM | shadow root 内样式表选不到宿主文档元素（事实 1），物理上无法迁 |

### 明确不进 shadow 的事实依据

1. **B 站 light DOM 规则只能留 light**：`body[data-boc-reader-mode="1"] .left-container`、`#playerWrap > *`、`#app`、`.strip-ad-inner`、`#viewbox_report` 等约 12 KB 门控规则的目标是 B 站自己的 light DOM 节点。shadow root 内样式表选不到宿主文档元素，这部分迁不进去。
2. **就地搬移节点留在 light DOM**：阅读视图把 B 站 main 节点就地搬进 `#boc-reading-inline-host`（extension/reader/page-frame.js:188 `inlineHost.appendChild(readingMain)`，退出时原样放回 :199-201）。搬进 shadow root 后 B 站自身 CSS 不再命中这些节点——播放器与视频页基础样式（字体、reset）会掉，是行为改变，不是纯重构。

## 否决方案与理由

- **面板与阅读视图容器整体挂 shadow root**（源报告建议）：Shadow root 内样式表物理上选不到其宿主节点之外的元素——`#playerWrap`、`#viewbox_report` 等门控规则本来就写在宿主文档里，迁移不成立（事实 1）。
- **把阅读视图连同被搬移的 B 站 main 一起迁入 shadow root**：`boc-reading-main` 是 B 站的真实 main 节点（事实 2），搬入 shadow 后 B 站自身的字体/reset 等基础样式不再命中，播放器相关依赖 `closest()`/`getComputedStyle`/`querySelector` 的链式查找也会断——行为改变且风险不可控。
- **shadow root 放扩展自有子树（仅面板/阅读视图壳）**：收益 = 消除与 B 站的样式互污。但互污已经被 S3 分层收窄到只剩少数 `#boc-*` 全局 id 命中面（B 站页面 CSS 对 `#boc-*` 无规则；扩展对 `#boc-*` 外也无规则），剩余收益是理论性的。成本是真实且要付的：
  - 事件冒泡：`bindUiEvents` 在 `#boc-root` 上做事件委托（ui-renderer.js），shadow 内事件冒泡仍能穿透到宿主（retargeting 后 `event.target` 变化、部分事件不穿透），委托与 `composed` 处理都要改；阅读视图对 B 站节点、播放器的直接 `querySelector`/`closest` 链式查找全部失效，需逐点重写。
  - 焦点/可访问性：`aria-*` 关系与焦点序跨 shadow 边界要重新梳理，`body[data-boc-reader-mode]` 上的全局键盘/焦点守卫与 `data-boc-reader-*` 属性继承都要复刻。
  - 时序：阅读视图的构建、`moveReadingMainInline` 的就地搬移、`layoutReaderPlayerHost` 的定位都是对 light DOM 的即席操作，挂 shadow 需同步改挂载时序与所有入口。
  - 与 `document.querySelectorAll` 的剪枝逻辑（`pruneReaderNonKeepBranches`、`hideReaderNoiseNodes`）冲突：shadow 内节点不再被文档级选择器命中，剪枝要重写。
- **adoptedStyleSheets / fetch 注入**：S3 分层时已否决（style-injector.js 注释），无新增理由。

## 后果

- S3 已拿到绝大部分收益（面板 2,122 B、阅读 9,651 B + 门控 20,512 B、播放器 AI 1,727 B 分层为按需挂载），本 ADR 判定不再追加 shadow 改造。
- 扩展自有子树留在 light DOM，与 B 站的样式互污残余面：`#boc-*` 全局 id 与极少数类名。如需进一步收窄，用 scoped 前缀（类名加 `boc-` 前缀 + 属性选择器）即可，成本远低于 shadow 迁移。
- 若未来要做 shadow 迁移，需先解决上述事件冒泡、焦点、可访问性、时序四类问题（见否决理由），且只限于扩展自有子树，B 站节点永不进 shadow。
