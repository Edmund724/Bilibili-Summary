// Reader 排版/设置呈现层（候选02 分层惰性：自 lifecycle.js 与已退役的
// page-frame.js / player-host.js 迁出的常驻微模块）。
//
// 这里只收拢「启动路径必需」的轻呈现函数：阅读视图的排版应用
//（applyReadingViewPresentation）、设置水合（hydrateReaderStateFromSettings）与
// 状态栏文案（renderReadingStatus）。它们是启动路径
//（content.js init 的 hydrate/apply）的直接依赖——留在 lifecycle.js 会把整个
// reader 域拖回常驻。
//（PR2：原内联宿主呈现 applyInlineHostPresentation 已随字幕列表搬进统一面板
// 一并移除；digest-only-ui：四个排版 stepper 模板/绑定已随排版档位机制退役。）
//
// 阅读视图打开后才用到的交互呈现（updateReaderPreferences / renderReaderPanels）
// 已移回 lifecycle.js（reader 动态 chunk；renderReadingInfoPanel 已随「视频
// 摘要/简介」区块删除）：
// 本层与 ui-renderer 的相关回调一律经 ensureReaderDomain() 装载后调用，避免为
// 一次面板交互在常驻侧保留体积。
// 函数体逐字搬自原文件对应分节，行为零变化。依赖全部为常驻叶子
//（core/state、core/validators、shared/dom-utils、shared/string-utils、./ids）。
import { state } from "../core/state.js";
import { type Settings } from "../core/defaults.js";
import { getReaderElement } from "../shared/dom-utils.js";
import { normalizeReaderTheme } from "../core/validators.js";
import { ids } from "./state.js";
import { READER_APPLY_FIELDS } from "./presentation-fields.js";

// ===== 状态栏文案（自 player-host.js 迁入；sync/lifecycle 域内继续经本模块取用） =====

export function renderReadingStatus(text: string | number | null | undefined) {
  const node = getReaderElement(ids.readingStatus);
  const next = String(text ?? "");
  // 候选10 批1：250ms tick 会反复写同一文案，值未变时跳过 textContent 写入，
  // 避免无谓的 DOM 变更（节点缺失时仍按原样经 byId 抛错，行为不变）。
  if (node.textContent === next) {
    return;
  }
  node.textContent = next;
}

// ===== 内联宿主呈现（PR2 移除） =====
//
// applyInlineHostPresentation 随字幕列表搬进统一面板「字幕」tab 一并移除：
// 内联宿主（boc-reading-inline-host）形态不复存在，字幕显隐不再经
// .boc-reading-main 的 display 表达（字幕常显，三开关退役后无隐藏通道）。

// ===== 设置水合与排版应用（自 lifecycle.js 迁入） =====
//
// 三开关退役（滚动/字幕/章节不再可关，2026-09）：水合只剩主题一项，不再
// 读取 readerChapterVisible / readerTranscriptVisible（其存储键已随开关删除）。

export function hydrateReaderStateFromSettings(settings: Partial<Settings> = state.settings) {
  state.reader.setTheme(normalizeReaderTheme(settings?.readerTheme));
}

export function applyReadingViewPresentation() {
  const readingView = getReaderElement(ids.readingView);
  // 候选06：字段清单/作用目标/dataset 键/取值换算唯一来源 presentation-fields.js
  //（READER_APPLY_FIELDS 子表），写入方不再手抄。写入顺序与迁移前逐字一致：
  // readingView（短名）→ documentElement → body，各段内按表序逐字段。
  const values: Record<string, string> = {};
  for (const field of READER_APPLY_FIELDS) {
    values[field.id] = field.readValue!(state.reader);
  }
  for (const field of READER_APPLY_FIELDS) {
    if (field.targets.readingView && field.datasetKeys.readingView) {
      readingView.dataset[field.datasetKeys.readingView] = values[field.id];
    }
  }
  for (const field of READER_APPLY_FIELDS) {
    if (field.targets.html && field.datasetKeys.html) {
      document.documentElement.dataset[field.datasetKeys.html] = values[field.id];
    }
  }
  for (const field of READER_APPLY_FIELDS) {
    if (field.targets.body && field.datasetKeys.body) {
      document.body.dataset[field.datasetKeys.body] = values[field.id];
    }
  }
  // 字幕/章节的 checkbox 同步与 .boc-reading-main 显隐已随三开关退役删除
  //（字幕常显，开关与 data 属性不再存在）。
}

// updateReaderPreferences / persistReaderSettings / renderReaderPanels 已移回
// lifecycle.js（reader 动态 chunk）——它们只在阅读视图交互时执行，常驻侧经
// ensureReaderDomain 转发（ui-renderer）。renderReadingInfoPanel 已随「视频
// 摘要/简介」区块删除（digest-only-ui）。
