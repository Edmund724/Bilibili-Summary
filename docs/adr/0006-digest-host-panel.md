# 阅读模式采用右栏 Digest 面板，整页接管退役

阅读模式曾有两条路线：**整页接管**（把 B 站 main 节点就地搬进扩展壳、播放器挂进扩展布局、剪枝页面噪声分支）与 **右栏 Digest 面板**（不碰 B 站 DOM，面板贴右栏 fixed 定位）。我们决定：**阅读模式 = 右栏 Digest 面板**——`reader/digest-host.ts` 负责算右栏 rect 并写进 `#boc-reading-view` 的四个 CSS 变量（`--boc-digest-left/top/width/height`），面板 `position: fixed` 贴栏；锚点失效或视口过窄时降级为居中浮层。整页接管体系（player-host、hover-chrome、page-frame、剪枝门控）全部退役。

本裁决取代旧 ADR 中依赖整页接管的描述：ADR-0004（shadow DOM 边界）的结论本身不受影响——**Digest 面板仍留在 light DOM**（`#boc-reading-view` 是扩展自有子树，与 B 站节点同文档），但 ADR-0004 事实依据 2 描述的「B 站 main 节点就地搬移」链路已不存在，阅读模式不再搬移任何 B 站节点。

## 理由

- **不离开原页面**：阅读只是观看之外的伴随动作，用户随时要看视频本体、滚动推荐、切分P；整页接管把这些全藏进了壳内，退出阅读模式的往返成本高。
- **保留弹幕与评论**：B 站原生互动（弹幕、评论、点赞投币）原样留在页面上，阅读面板不与它们争空间——面板只占右栏推荐列表的位置。
- **播放器不搬迁**：播放器宿主链是全扩展对 B 站 DOM 最脆弱的依赖。不碰播放器 = 不再需要挂载等待、布局稳定性判定、控制条接管、宿主复位重试（playerRetryTimer 等全部随之退役）；video 事件经 `video-bind.ts` 直接绑定，同步链比接管期短一个域。

## 锚点链与降级链

锚点候选按优先级串行试探（`digest-host.ts` 的 `ANCHOR_SELECTORS`）：新版右栏 `.right-container-inner` → `.right-container` → 合集态 `.playlist-container--right` → 旧版 `#reco_list` / `#viewbox_report` / `.up-info-container`。有效判据是「存在 + `rect.width >= 280`（滤掉隐藏副本）+ 未滚出视口」。命中后面板**占「锚点左缘 → 视口右界」整条右侧**——B 站容器有最大宽度，宽屏下锚点右缘与窗口右缘之间是大片死区，面板填充之；右界取 `documentElement.clientWidth`（不含经典滚动条，页面滚动条保持可用）。纵向钳进一屏：top 跟锚点但不出视口（下限 0），底缘贴视口底，内容超高由面板内部滚动消化。`readerContentWidth` 档位（narrow 340 / standard 380 / wide 440）作贴栏宽度下限——可填宽度不足档位宽时左缘向左延伸补足；float 档强制浮层。

降级链（每级只在前一级失败时进入）：

1. **锚点全落空但视口够宽且有播放器** → 贴播放器右缘（`findReaderPlayerHost` 现查宿主 rect）。
2. **窄窗（< 1000px）/ 连播放器都没有 / `readerContentWidth="float"`** → 居中浮层：不写变量，改设 `data-boc-digest-float="1"`，回落 reader.css 浮层基础样式。

重算机制：resize/scroll 事件经 rAF 合帧 + 脏检查快照；SPA 换页换掉锚点节点由 800ms 定时自查重锚（刻意不用 MutationObserver，弹幕会把它打爆）；锚点变化经 ResizeObserver 观察。

## player-host 退役理由

整页接管的 player-host 同时承担播放器搬迁、布局调度、控制条接管与 video 事件基座。面板形态下前三者失去意义（播放器根本不动），只剩 video 事件绑定——它沉到 `video-bind.ts`（约 70 行，AbortController 绑定 + 端口回调），调度思路（rAF 合帧 + 脏检查）由 digest-host 继承。保留 player-host 只会留一个空壳域，徒增分层成本。

## 明确不做

- **不收起评论区/弹幕**：面板定位只读右栏 rect，不给页面加任何遮挡或让位规则；B 站布局、播放器与推荐栏一律不动。
- **不为稍后再看页造锚点**：稍后再看等无右栏页面走降级链即可（贴播放器或浮层），不为其维护专属锚点选择器。

## 对抗面

面板形态把对 B 站改版的依赖收敛到**锚点选择器链**这唯一一处。B 站改版换掉右栏类名时，坏的表现是锚点落空、面板走降级链（位置跑偏成浮层或贴播放器），**不是功能失效**——字幕渲染、同步、seek、概览、对话都不经过锚点。修法是往 `ANCHOR_SELECTORS` 追加新选择器，一处改动。

## 后果

- LAYOUT 层收敛为 `video-bind.js + digest-host.js` 两域；reader 状态里的 `readingNativePageMode` 及消费分支删除。
- `readerContentWidth` 语义为面板宽度档（旧整页主体宽度档位归一为 standard）：贴栏形态占满锚点左缘到视口右缘，档位宽作下限。
- ADR-0004 的事实依据 2（main 节点搬移）失效，但 light DOM 结论对 Digest 面板继续成立；shadow 迁移的重开条件不变。

## 修订（2026-09-07：面板重锚自查 800ms → 2s）

「800ms 定时自查重锚」节拍降为 2s（`digest-host.ts` 的 `REANCHOR_INTERVAL_MS` 改本地常量）：核实事件路径（resize/scroll 的 rAF 合帧 + `applyDigestRect` 每拍锚点比对换锚）自带重锚后，定时自查只是「用户完全不动 + 无 observer 事件」期间的兜底，面板跑位是降级表现而非功能失效（与本 ADR「对抗面」一节的定性一致），2s 自愈可接受；按钮自愈（`shared/self-heal.ts` 800ms）是功能失效恢复，语义本就独立，不再共用单源常量。决策与验收记录见 `.scratch/tickets/arch-slim-4/issues/06-p2-digest-host-one-pass.md`。
