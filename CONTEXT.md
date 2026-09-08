# Bilibili-Summary 上下文

B 站视频「一键总结」浏览器扩展的领域词表。统一代码、讨论、issue 里的命名，避免同义词漂移。

## 术语

### 内容与载体

**视频**:
B 站上的一条视频，由 `bvid` 与分P `cid` 唯一标识。
代码名：`state.clip` / `bvid` / `bilibili/video-id-shared.js`
_Avoid_: 稿件、作品

**分P**:
一个视频下的多段内容单元，以 `cid` 标识。
代码名：`pageIndex` / `pageTitle` / `pickPageFromPages`（reader/page-context.js）——自有抽象沿用 B 站 API 的 page 词根，Avoid 只约束中文行文与新增抽象。
_Avoid_: Part、页、集数

**字幕**:
视频的一条字幕轨；整理后每条字幕是 `{from, to, content}`（秒级时间戳 + 文本）。无字幕轨时经语音识别（ASR）生成，仍是字幕。
代码名：`subtitleBody` / `subtitle` / `subtitle/fetcher.js` / `subtitleLang` / `subtitleList` / `updateReadingSubtitleTailSpacer` / `ReadingSubtitleItem` / `data-boc-reader-subtitle-visible`——字幕列表常驻 Digest 面板「字幕」标签，transcript 词根已对齐字幕。
_Avoid_: 转录、transcript

**章节**:
视频自带的分段 `{from, to, title}`。
代码名：`chapters` / `normalizeChapters`
_Avoid_: 目录、分段、集

**时刻文本**:
视频时间「秒 ↔ 时刻文本」的唯一换算约定：展示格式统一不补零（`2:30`，小时位同理），解析容错与是否带小时段（withHours 政策）单源收口。提示词教学格式与 UI 渲染格式必须出自同一实现，禁止两套约定靠注释对齐。
代码名：`formatAnalysisClock` / `formatCompactTimestamp`（统一后退役并入时刻文本单源模块）/ `parseTimestampSeconds`
_Avoid_: 补零/不补零双约定并存、各处手写 withHours 启发式、第三套解析器

**字幕接受**:
一段字幕成为当前视频生效字幕的唯一事务：稳定排序（from 升序，读路径二分依赖）→ 写 state → `fetchState="ready"` → 清 `noSubtitleReason` → 刷新派生内容（笔记/SRT/TXT）→ 通知 reader（`subtitle-ready`，emit 单点在事务内——调用方补发通知或直调渲染即双渲染）。四个写入点（CC 缓存命中/网络新抓/ASR 缓存命中/转写完成）与无字幕出口（逆事务：清空 + `empty` + 原因）都必须经此收口，禁止手抄序列。事务带可选 runId 代次自检（M23 runId 协调）：调用方传入自己的抓取代次，写 state 前与 `fetchRunId` 比对，代次已被 URL 变化编排递增/新一轮抓取推进则抛 STALE_RUN 让位——旧视频字幕不得写进已重置的 state。递增单点在 URL 变化编排（`handleUrlChange` 感知 clip 签名变化处）同步先行，早于 reset 与新视频 refreshClip 的动态装载链；未传 runId（ASR 收尾路径，自有 isStale 视频键门控）不校验。
代码名：`subtitle/commit.js`（接受与无字幕出口的唯一入口；DOM 渲染回调由 fetcher 注入，保持静态图无环）/ `runId` 自检（`AcceptSubtitleArgs.runId` / `CommitNoSubtitleArgs.runId`）
_Avoid_: 落账、提交、写入字幕、手抄接受序列、reset 内递增 fetchRunId（须同步先行于装载链，否则新视频抓取可能被迟到的递增误杀）

**原始字幕缓存**:
按时间戳/章节切好的原始字幕段，可随取随用；仅在压缩摘要之外的细节追问时按需检索注入。宿主注记（arch-review-2026-09/05）：storage 真实宿主是 SW，offscreen（Map-Reduce/追问链）经 `segment-cache` 消息族读写——offscreen 侧唯一出站点 `ai/segment-cache-proxy.ts`，SW 端 `ai/segment-cache-handler.ts` 直调 segment-cache 单源（键位装配在 SW 完成）。
代码名：`ai/segment-cache.js`（`boc_lvs_raw_*`）/ `ai/raw-retrieval.js`
_Avoid_: 长记忆、向量库

**Digest 面板**:
阅读模式的唯一呈现形态：右栏固定定位面板，三标签（字幕 / 概览 / AI 对话）。不接管页面、不搬播放器；贴栏 rect 由锚点链决定，失败逐级降级（贴播放器 → 居中浮层）。ADR-0006。
代码名：`#boc-reading-view` / `#boc-reading-digest-panel` / `reader/digest-host.ts` / `--boc-digest-*` / `data-boc-digest-float`
口语同义词：侧边栏（用户行文用词，指同一面板）
_Avoid_: 阅读视图整页接管、播放器槽、rail/stage、剪枝

**右栏锚点**:
Digest 面板贴栏定位的参考节点，按优先级串行试探的右栏候选链（新版 `.right-container-inner` 起，旧版 `#reco_list` 止），有效判据 = 存在 + 宽度 ≥ 280 + 未滚出视口。唯一随 B 站改版会坏的面板依赖；坏的表现是降级跑位，不是功能失效。
代码名：`ANCHOR_SELECTORS` / `findDigestAnchor`（reader/digest-host.ts）
_Avoid_: 宿主、播放器宿主（那是 video-probe 的概念）

**阅读壳**:
Digest 面板进入与退出阅读形态的唯一事务。按意图三档（open 进入 / restore 恢复 / focus-chat 进对话）执行「先挂阅读样式表、再翻 body/html 属性」的无闪变时序，含摘除播放器快捷按钮、suppress 抑制窗口与 restore 档的 shell 完好性自查；退出为逆事务。全部入口（按钮/编排触发、恢复、进对话）与关闭出口都必须经此收口，禁止手抄序列。
代码名：`enterReaderShell` / `exitReaderShell`（intent 三档）/ `reader/shell.ts`；承载消息 `reader-enter` / `reader-restore` / `reader-enter-chat` / `reader-close`
_Avoid_: popup- 词根消息名、进入阅读模式手抄序列

### 总结流程

**笔记**:
最终产出的、面向收藏与复习的完整 Markdown 总结。
代码名：`notes/` 目录（`notes/render.js` 的 `buildMarkdown`）/ `hasFinalNote`（判定已成稿）
_Avoid_: 总结、摘要、回答

**音频分片**:
长音频按固定时长切出的上传单元（5 分钟/片，WAV）。与「分段小结」互不相干：分片是 ASR 的上传/转写单元，小结是字幕的压缩产物。
代码名：`asr/chunker.js` / `decideChunks` / `ASR_MSG_CHUNK_RESULT` / `mergeChunkResults`
_Avoid_: 与「分段小结」混用

**分段小结**:
把一段字幕忠实压缩成的中间产物，保留事实、时间点与前后关系，供归并与追问检索。（与「音频分片」区分：分片是上传单元，小结是压缩产物。）
代码名：`buildSegmentPrompt` / `formatSegmentItem` / `ai/segment-cache.js`（`boc_lvs_summary_*`）/ `SEGMENT_SUMMARY_CHARS`
_Avoid_: 小总结、chunk 摘要

**归并**:
把多段小结按下一条「素材预算」合并成更接近成稿材料的层叠操作。
代码名：`ai/reduce.js` / `shouldReduce` / `buildReduceGroups` / `buildReducePrompt` / `reduceSummaries` / `REDUCE_GROUP_INPUT_CHARS` / `REDUCE_TRIGGER_CHARS`——归并 = Map-Reduce 的 Reduce 阶段（ADR-0001）。
_Avoid_: 合并、merge

**素材预算**:
单次请求允许塞给模型的原视频文字量上限。溢出（err.overflow）时的编排级兜底：入口侧预算（单段输入 / 归并组输入）按 0.5 倍收紧整轮重跑一次，仍溢出才报错；段小结缓存 key 按预算档隔离（`_b50` 后缀），段边界漂移不串内容。
代码名：`ai/budgeter.js`（`MATERIAL_BUDGET_CHARS`）/ `buildMaterial` / `buildBudgetPlan` 的 options / `OVERFLOW_RETRY_BUDGET_SCALE`
_Avoid_: 窗口、配额、限额

**阶梯**:
素材在预算内直接一次成稿；超出预算才进入「分段 + 归并」。分派实现在 ai/ladder.js。
代码名：`ai/ladder.js` / `runLadderChat`
_Avoid_: 降级、回退

**概览**:
Digest 面板三大标签之一（对应 YouTube Digest 的 Overview）：段落总结 + 章节列表 + 金句 + 完整笔记一节。视频无自带章节时由 AI 分章。
_Avoid_: 总览

**金句**:
AI 从字幕中挑选的佳句，收录在概览页章节下方，带时间戳。
_Avoid_: 名句、摘抄

**压缩摘要**:
追问时常驻上下文的有界形式（分段小结 + 笔记），取代把原始字幕整篇重发。
代码名：`compressedSummaryMarkdown` / `buildCompressedSummary` / `ai/followup-context.js`
_Avoid_: 缓存摘要、记忆、上下文摘要

### 平台与密钥

**激活平台**:
「当前选中的 AI 平台 + 其 API Key」的唯一解析：providerId 给定 = 精确匹配（AI 对话链），缺省 = 设置 defaultModel → 首个启用平台回落（概览/选区解释链）。requiresKey 平台密钥缺失在解析期即报可读错误。概览、选区解释、AI 对话三条链共用一条 `resolve-ai-provider` 单趟消息，禁止再手抄 providers-list + provider-key 的多趟解析链。
代码名：`resolveActiveProvider`（content 侧消费壳）/ `resolveProviderWithKey`（offscreen 消费壳）/ `createAiResolvedProviderHandler`（SW 处理器，策略单源）
_Avoid_: 手抄多趟解析链、第二份解析实现

### AI 对话

**拆除会话**:
把「当前会话」从对话视图与存储中摘除的唯一事务：断流通知先于任何 await 与落盘 → 清会话 id/meta/历史 → 需要时做 live 上下文回填。删除单个会话、清空全部、恢复最新、开启新会话、发送前上下文失配各出口都必须经此收口，禁止手抄序列（与「字幕接受」「阅读壳」同款收口纪律）。
代码名：`detachCurrent` / `repopulateLive`（conversation-store 内部原语）
_Avoid_: 清会话、重置对话、手抄拆除序列
