// Reader 呈现属性单一事实源（候选06 属性表半边）。
//
// 「阅读模式开着 + 排版设置」由一组 data-boc-reader-* / data-boc-reading-* 页面
// 属性表达。历史上同一份字段清单在 5 处手抄且已漂移：
//   1. 写入方 presentation.js（applyReadingViewPresentation）；
//   2. closeReadingView 的移除清单（lifecycle.js）——漏了 subtitle-visible；
//   3. 守卫清理 clearReaderModePageState（page-state.js）——body 侧只有 3 项；
//   4. 守卫 observer 的两份 attributeFilter（page-state.js）——body 侧同样过窄；
//   5. storage 变更监听键清单（init-essentials.js）——仍盯旧键
//      readerChapterVisibility，实际读写键 readerChapterVisible 不在清单。
// 本表是这些清单的唯一声明处，五个消费方一律从表派生；「真实差异」用字段标志
// （clearOnClose / clearOnGuard / watchedByGuard）显式化，不再靠各处手抄对齐。
//
// 纯常量模块：零 import（连 core/state 都不碰），readValue 是注入 reader 状态
// 对象的纯函数。content / pages / reader 任意侧都可安全 import，无循环依赖。

import type { ReaderState } from "../core/state.js";

export type ReaderPresentationFieldKind =
  | "presentation"
  | "derived"
  | "enter-flag"
  | "view-flag"
  | "settings";

export interface ReaderPresentationTargets {
  html: string | null;
  body: string | null;
  readingView: string | null;
}

export interface ReaderPresentationField {
  id: string;
  kind: ReaderPresentationFieldKind;
  targets: ReaderPresentationTargets;
  datasetKeys: ReaderPresentationTargets;
  storageKey: string | null;
  legacyStorageKey: string | null;
  watchedByGuard: boolean;
  clearOnGuard: boolean;
  clearOnClose: boolean;
  clearViewOnClose: boolean;
  writtenByApply: boolean;
  readValue: ((reader: ReaderState) => string) | null;
}

// ===== 字段条目各键的含义 =====
//   id              逻辑名（表内唯一），也是 readValue/派生清单的关联键。
//   kind            字段归属：
//                     "presentation" 排版设置属性（storage 设置驱动，
//                                    applyReadingViewPresentation 写入）；
//                     "derived"      阅读期派生属性（has-chapters，由
//                                    lifecycle.updateReaderChapterPresence 写入）；
//                     "enter-flag"   进入标记（mode / reading-active，由组合根
//                                    content.js、message-handler.js 与
//                                    enterReaderMode 写入，apply 不负责）；
//                     "view-flag"    视图内同步标志（follow，由 sync.js 写入）；
//                     "settings"     无属性的纯 storage 监听键（player-ai 两键，
//                                    只为 bindSettingsWatcher 的键清单服务）。
//   targets         作用目标 → 该目标上的连字符属性名；不在该目标落位为 null。
//                     html = documentElement，body = document.body，
//                     readingView = #boc-reading-view（短名属性）。
//   datasetKeys     与 targets 同序的 dataset 驼峰键（attr 去掉 "data-" 转驼峰；
//                   不变量测试会校验两者一致，防手抄漂移）。
//   storageKey      对应 chrome.storage 设置键（无则 null）。注意章节可见性
//                   实际读写的是布尔键 readerChapterVisible（8c2e4ff 从旧键
//                   readerChapterVisibility 改名而来）。
//   legacyStorageKey 旧版设置键：settings-store 仍会归一化/落盘它（兼容旧存
//                   储数据），storage 监听需继续覆盖（无则 null）。
//   watchedByGuard  守卫 observer（page-state.bindNormalPageStateGuard）是否把
//                   该属性列入 attributeFilter（守卫只 observe html/body）。
//   clearOnGuard    守卫清理（clearReaderModePageState，含启动时非阅读页收敛）
//                   是否移除该属性。
//   clearOnClose    closeReadingView 是否移除该属性的页面级落位（html/body）。
//                   close 与守卫清理的范围差由本标志与 clearOnGuard 的组合
//                   显式声明。
//   clearViewOnClose  readingView 上的短名镜像是否随 close 清除。排版字段的
//                   短名镜像不清：#boc-reading-view 是常驻模板壳，close 只把
//                   它复位到关闭基线（class/aria/ready），短名属性由下次 open
//                   的 apply/updateReaderChapterPresence 全量重写，且无任何
//                   close→open 窗口期消费方；视图内标志 follow 则必须清。
//   writtenByApply  applyReadingViewPresentation 是否写入；为 true 时必须提供
//                   readValue，为 false 时 readValue 必须为 null。
//   readValue       (reader) => DOM 值：state.reader → 属性值的换算。只在
//                   writtenByApply 字段上存在，属「值怎么算」的呈现逻辑，
//                   随字段声明进表以免写入方再抄一份取值清单。
export const READER_PRESENTATION_FIELDS: ReaderPresentationField[] = [
  // —— 排版设置五标量（顺序即 apply 的写入顺序，迁移前逐字一致）——
  {
    id: "theme",
    kind: "presentation",
    targets: { html: "data-boc-reader-theme", body: "data-boc-reader-theme", readingView: "data-theme" },
    datasetKeys: { html: "bocReaderTheme", body: "bocReaderTheme", readingView: "theme" },
    storageKey: "readerTheme",
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => reader.readingTheme
  },
  {
    id: "fontScale",
    kind: "presentation",
    targets: { html: "data-boc-reader-font-scale", body: "data-boc-reader-font-scale", readingView: "data-font-scale" },
    datasetKeys: { html: "bocReaderFontScale", body: "bocReaderFontScale", readingView: "fontScale" },
    storageKey: "readerFontScale",
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => reader.readingFontScale
  },
  {
    id: "letterSpacing",
    kind: "presentation",
    targets: { html: "data-boc-reader-letter-spacing", body: "data-boc-reader-letter-spacing", readingView: "data-letter-spacing" },
    datasetKeys: { html: "bocReaderLetterSpacing", body: "bocReaderLetterSpacing", readingView: "letterSpacing" },
    storageKey: "readerLetterSpacing",
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => reader.readingLetterSpacing
  },
  {
    id: "lineHeight",
    kind: "presentation",
    targets: { html: "data-boc-reader-line-height", body: "data-boc-reader-line-height", readingView: "data-line-height" },
    datasetKeys: { html: "bocReaderLineHeight", body: "bocReaderLineHeight", readingView: "lineHeight" },
    storageKey: "readerLineHeight",
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => reader.readingLineHeight
  },
  {
    id: "contentWidth",
    kind: "presentation",
    targets: { html: "data-boc-reader-content-width", body: "data-boc-reader-content-width", readingView: "data-content-width" },
    datasetKeys: { html: "bocReaderContentWidth", body: "bocReaderContentWidth", readingView: "contentWidth" },
    storageKey: "readerContentWidth",
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => reader.readingContentWidth
  },
  {
    id: "chapterVisibility",
    kind: "presentation",
    targets: { html: "data-boc-reader-chapter-visibility", body: "data-boc-reader-chapter-visibility", readingView: "data-chapter-visibility" },
    datasetKeys: { html: "bocReaderChapterVisibility", body: "bocReaderChapterVisibility", readingView: "chapterVisibility" },
    storageKey: "readerChapterVisible",
    legacyStorageKey: "readerChapterVisibility",
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => (reader.readingChapterVisible ? "auto" : "hide")
  },
  {
    id: "hasChapters",
    kind: "derived",
    // 非 storage 设置：由 state.clip.chapters 派生，无对应键。
    targets: { html: "data-boc-reader-has-chapters", body: "data-boc-reader-has-chapters", readingView: "data-has-chapters" },
    datasetKeys: { html: "bocReaderHasChapters", body: "bocReaderHasChapters", readingView: "hasChapters" },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    // apply 不写它：写入方是 lifecycle.updateReaderChapterPresence（renderReadingView
    // 按章节数据调用）。表只声明它的目标/清理职责，防止移除清单再漂移。
    writtenByApply: false,
    readValue: null
  },
  {
    id: "subtitleVisible",
    kind: "presentation",
    targets: { html: "data-boc-reader-subtitle-visible", body: "data-boc-reader-subtitle-visible", readingView: "data-subtitle-visible" },
    datasetKeys: { html: "bocReaderSubtitleVisible", body: "bocReaderSubtitleVisible", readingView: "subtitleVisible" },
    storageKey: "readerTranscriptVisible",
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    // 修正走样：旧 closeReadingView 手抄清单漏了 subtitle-visible（153b976
    // 引入该属性时只加了写入、漏补 close 清单；守卫清理清单与 CSS 消费方均按
    // 可清除对待）。close 与守卫在此对齐，避免关闭后残留陈旧值。
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: true,
    readValue: (reader) => (reader.readingSubtitleVisible ? "1" : "0")
  },
  // —— 进入标记：apply 不写（组合根/enterReaderMode 写 "1"），close/守卫都清 ——
  {
    id: "mode",
    kind: "enter-flag",
    targets: { html: "data-boc-reader-mode", body: "data-boc-reader-mode", readingView: null },
    datasetKeys: { html: "bocReaderMode", body: "bocReaderMode", readingView: null },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: false,
    readValue: null
  },
  {
    id: "readingActive",
    kind: "enter-flag",
    // 变体前缀 data-boc-reading-*（非 reader-*），只在 body 上（CSS 隐藏
    // 播放器原生字幕层依赖它）。
    targets: { html: null, body: "data-boc-reading-active", readingView: null },
    datasetKeys: { html: null, body: "bocReadingActive", readingView: null },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: true,
    clearOnGuard: true,
    clearOnClose: true,
    clearViewOnClose: false,
    writtenByApply: false,
    readValue: null
  },
  // —— 视图内同步标志：守卫不感知（非页面级状态），仅 close 时清 ——
  {
    id: "follow",
    kind: "view-flag",
    targets: { html: null, body: null, readingView: "data-boc-reader-follow" },
    datasetKeys: { html: null, body: null, readingView: "bocReaderFollow" },
    storageKey: null,
    legacyStorageKey: null,
    watchedByGuard: false,
    clearOnGuard: false,
    clearOnClose: true,
    // readingView 短名镜像随 close 清除
    clearViewOnClose: true,
    // 写入方是 sync.updateReaderFollowState（auto/off/manual）。
    writtenByApply: false,
    readValue: null
  },
  // —— 纯 storage 监听键：无属性落位，只为 bindSettingsWatcher 键清单服务 ——
  // 播放器 AI 快捷动作的开关/提示词变化需要立即触发设置回读与 requestPlayerAiSync。
  {
    id: "enablePlayerAiQuickAction",
    kind: "settings",
    targets: { html: null, body: null, readingView: null },
    datasetKeys: { html: null, body: null, readingView: null },
    storageKey: "enablePlayerAiQuickAction",
    legacyStorageKey: null,
    watchedByGuard: false,
    clearOnGuard: false,
    clearOnClose: false,
    clearViewOnClose: false,
    writtenByApply: false,
    readValue: null
  },
  {
    id: "playerAiQuickPrompt",
    kind: "settings",
    targets: { html: null, body: null, readingView: null },
    datasetKeys: { html: null, body: null, readingView: null },
    storageKey: "playerAiQuickPrompt",
    legacyStorageKey: null,
    watchedByGuard: false,
    clearOnGuard: false,
    clearOnClose: false,
    clearViewOnClose: false,
    writtenByApply: false,
    readValue: null
  }
];

// 按标志 × 作用目标派生连字符属性名清单（模块顶层计算一次的常量）。
// readingView 列额外要求 clearViewOnClose：clearOnGuard/clearOnClose 表达的是
// 页面级（html/body）清理职责，readingView 短名镜像是否随清理删除由
// clearViewOnClose 单独把关（守卫永不触碰视图，其 readingView 列因此恒空）。
type AttrFlag = "clearOnClose" | "clearOnGuard" | "watchedByGuard";
type AttrTarget = "html" | "body" | "readingView";

function collectAttrsByTarget(flag: AttrFlag) {
  const result: Record<AttrTarget, string[]> = { html: [], body: [], readingView: [] };
  for (const field of READER_PRESENTATION_FIELDS) {
    for (const target of ["html", "body", "readingView"] as AttrTarget[]) {
      if (!field[flag] || !field.targets[target]) {
        continue;
      }
      if (target === "readingView" && !field.clearViewOnClose) {
        continue;
      }
      result[target].push(field.targets[target]);
    }
  }
  return result;
}

// closeReadingView 的移除清单（lifecycle.js 从此派生，不再手抄）。
export const READER_CLOSE_ATTRS = collectAttrsByTarget("clearOnClose");

// 守卫清理（clearReaderModePageState）的移除清单（page-state.js 从此派生）。
export const READER_GUARD_CLEAR_ATTRS = collectAttrsByTarget("clearOnGuard");

// 守卫 observer 的 attributeFilter（page-state.js 从此派生）。
// 旧手抄 body filter 只有 mode/line-height/reading-active 三项，与 html 全集
// 不对称且无 CSS 依据（body 与 html 的选择器面一致），属走样；按正确超集对齐。
export const READER_GUARD_FILTER = collectAttrsByTarget("watchedByGuard");

// applyReadingViewPresentation 的写入字段子表（presentation.js 从此派生）。
export const READER_APPLY_FIELDS = READER_PRESENTATION_FIELDS.filter(
  (field) => field.writtenByApply
);

// storage 变更监听键全集：所有 storageKey ∪ legacyStorageKey（去重）。
// （init-essentials.bindSettingsWatcher 从此派生：含实际读写键
// readerChapterVisible 的修正 + 旧键 readerChapterVisibility 的兼容。）
export const READER_SETTINGS_WATCH_KEYS = [
  ...new Set(
    READER_PRESENTATION_FIELDS.flatMap((field) =>
      [field.storageKey, field.legacyStorageKey].filter(Boolean)
    )
  )
];

// 有意不入主表的同前缀局部标志：它们是各子体系内部单点自洽的临时/局部标记
// （写入方与清除方在同一处），不存在跨文件清单漂移面，不参与呈现属性契约。
// 源码扫描测试据此放行；新增 data-boc-* 属性字面量必须要么进主表、要么进本清单。
export const LOCAL_FLAG_ATTRIBUTES = new Set([
  "data-boc-reader-keep",             // page-frame 剪枝：保留节点标记
  "data-boc-reader-hidden",           // page-frame 剪枝：隐藏节点标记
  "data-boc-reader-ready",            // 视图就绪态（ui-renderer 模板初值 / close 复位 "0"）
  "data-boc-reader-fading",           // 播放器挂载淡入过渡（lifecycle 写入/移除）
  "data-boc-reader-hide-sending-bar", // close 时瞬时隐藏 B 站发送条
  "data-boc-reader-controls-forced",  // player-host 控件条强制显示
  "data-boc-reader-no-cursor-cleared", // player-host 光标清理标记
  "data-boc-reader-player-reset"      // player-host 播放器复位标记
]);
