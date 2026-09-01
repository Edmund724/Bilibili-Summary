// 测试共享的阅读视图 DOM 骨架与播放器宿主链。
//
// 原先 lifecycle.test.js / settings.test.js / sync.test.js /
// chapter-visibility.bug.test.js 各自维护一份几乎相同的 DOM 搭建代码
// （重复约 200+ 行），这里收敛为三组共享函数：
// - mountReaderSkeleton()：renderReadingView / applyReadingViewPresentation /
//   renderReaderPanels 等路径需要的阅读视图元素（id 取自 reader 的 ids 表）
// - mountPlayerChain(container)：B 站页面侧的播放器宿主链
//   （video → .bpx-player-primary-area → .bpx-player-video-area →
//    .bpx-player-container → #bilibili-player → #playerWrap），并给 video
//   定义默认媒体属性
// - mockPlayerRects()：给播放器链上需要“可见”判定的节点补 getBoundingClientRect
//
// 各测试若需要额外元素（如经典面板、readingThemeSelect 等），在调用
// mountReaderSkeleton() 之后再自行创建。

import { READER_MODE_URL } from "../setup.js";

const DEFAULT_VIDEO_PROPS = {
  duration: 600,
  videoWidth: 1920,
  videoHeight: 1080,
  paused: true,
  readyState: 4
};

// 给 video 元素定义默认媒体属性（jsdom 不实现这些属性，读取会得到 undefined）。
export function stubVideoMediaProps(video) {
  Object.entries(DEFAULT_VIDEO_PROPS).forEach(([key, value]) => {
    Object.defineProperty(video, key, { value, configurable: true });
  });
  return video;
}

// 搭建播放器宿主链（B 站页面侧结构，不在扩展模板里），返回 video 元素。
export function mountPlayerChain(container = document.body) {
  const playerWrap = document.createElement("div");
  playerWrap.id = "playerWrap";
  const bilibiliPlayer = document.createElement("div");
  bilibiliPlayer.id = "bilibili-player";
  const playerContainer = document.createElement("div");
  playerContainer.className = "bpx-player-container";
  const playerVideoArea = document.createElement("div");
  playerVideoArea.className = "bpx-player-video-area";
  const playerPrimaryArea = document.createElement("div");
  playerPrimaryArea.className = "bpx-player-primary-area";
  const video = document.createElement("video");
  video.controls = false;
  stubVideoMediaProps(video);

  playerPrimaryArea.appendChild(video);
  playerVideoArea.appendChild(playerPrimaryArea);
  playerContainer.appendChild(playerVideoArea);
  bilibiliPlayer.appendChild(playerContainer);
  playerWrap.appendChild(bilibiliPlayer);
  container.appendChild(playerWrap);

  return video;
}

// 搭建阅读视图的基本 DOM 骨架（renderReadingView 及其 presentation 依赖的
// 元素），返回 { readingView, readingMain, digestPanel }。阅读视图 id 取自
// ids 表，顺序/从属关系与 ui-renderer.js 的真实模板保持一致（PR2 起：
// 字幕列表挂进统一面板「字幕」tab body，header/settings 也在面板壳内——
// 骨架按同一从属关系搭建，bindUiEvents 可直接使用）。
export function mountReaderSkeleton(ids) {
  const doc = document;

  // applyReaderPageFocus 通过 getReaderElement(ids.root) 读取扩展根节点
  const root = doc.createElement("div");
  root.id = ids.root;
  doc.body.appendChild(root);

  const readingView = doc.createElement("div");
  readingView.id = ids.readingView;
  doc.body.appendChild(readingView);

  const readingStatus = doc.createElement("p");
  readingStatus.id = ids.readingStatus;
  readingView.appendChild(readingStatus);

  const readingPlayerSlot = doc.createElement("div");
  readingPlayerSlot.id = ids.readingPlayerSlot;
  readingView.appendChild(readingPlayerSlot);

  // 统一 Digest 面板壳（PR2）：header / 设置面板 / 三标签 + tab body 与真实
  // 模板同构；字幕列表 .boc-reading-main 挂在字幕 tab body 内。
  const digestPanel = doc.createElement("aside");
  digestPanel.id = ids.readingDigestPanel;
  digestPanel.className = "boc-reading-digest-panel";
  readingView.appendChild(digestPanel);

  const readingMeta = doc.createElement("div");
  readingMeta.id = ids.readingMeta;
  digestPanel.appendChild(readingMeta);

  const readingSettingsPanel = doc.createElement("div");
  readingSettingsPanel.id = ids.readingSettingsPanel;
  digestPanel.appendChild(readingSettingsPanel);

  const tabSubtitle = doc.createElement("button");
  tabSubtitle.id = ids.readingTabSubtitle;
  tabSubtitle.className = "boc-reading-tab is-active";
  digestPanel.appendChild(tabSubtitle);

  const tabOverview = doc.createElement("button");
  tabOverview.id = ids.readingTabOverview;
  tabOverview.className = "boc-reading-tab";
  digestPanel.appendChild(tabOverview);

  const tabChat = doc.createElement("button");
  tabChat.id = ids.readingTabChat;
  tabChat.className = "boc-reading-tab";
  digestPanel.appendChild(tabChat);

  const tabBodySubtitle = doc.createElement("div");
  tabBodySubtitle.id = ids.readingTabBodySubtitle;
  tabBodySubtitle.className = "boc-reading-tab-body is-active";
  digestPanel.appendChild(tabBodySubtitle);

  const tabBodyOverview = doc.createElement("div");
  tabBodyOverview.id = ids.readingTabBodyOverview;
  tabBodyOverview.className = "boc-reading-tab-body";
  tabBodyOverview.setAttribute("hidden", "");
  digestPanel.appendChild(tabBodyOverview);

  const tabBodyChat = doc.createElement("div");
  tabBodyChat.id = ids.readingTabBodyChat;
  tabBodyChat.className = "boc-reading-tab-body";
  tabBodyChat.setAttribute("hidden", "");
  digestPanel.appendChild(tabBodyChat);

  const readingChapterList = doc.createElement("div");
  readingChapterList.id = ids.readingChapterList;
  readingView.appendChild(readingChapterList);

  const readingMain = doc.createElement("div");
  readingMain.className = "boc-reading-main";
  tabBodySubtitle.appendChild(readingMain);

  const readingSubtitleList = doc.createElement("div");
  readingSubtitleList.id = ids.readingSubtitleList;
  readingMain.appendChild(readingSubtitleList);

  const readingAutoScroll = doc.createElement("input");
  readingAutoScroll.type = "checkbox";
  readingAutoScroll.checked = true;
  readingAutoScroll.id = ids.readingAutoScroll;
  digestPanel.appendChild(readingAutoScroll);

  const readingSubtitleVisible = doc.createElement("input");
  readingSubtitleVisible.type = "checkbox";
  readingSubtitleVisible.checked = true;
  readingSubtitleVisible.id = ids.readingSubtitleVisible;
  digestPanel.appendChild(readingSubtitleVisible);

  const readingChapterVisible = doc.createElement("input");
  readingChapterVisible.type = "checkbox";
  readingChapterVisible.checked = true;
  readingChapterVisible.id = ids.readingChapterVisible;
  digestPanel.appendChild(readingChapterVisible);

  const readingSettingsBtn = doc.createElement("button");
  readingSettingsBtn.id = ids.readingSettingsBtn;
  digestPanel.appendChild(readingSettingsBtn);

  const readingFontScaleSelect = doc.createElement("div");
  readingFontScaleSelect.id = ids.readingFontScaleSelect;
  digestPanel.appendChild(readingFontScaleSelect);

  const readingLetterSpacingSelect = doc.createElement("div");
  readingLetterSpacingSelect.id = ids.readingLetterSpacingSelect;
  digestPanel.appendChild(readingLetterSpacingSelect);

  const readingLineHeightSelect = doc.createElement("div");
  readingLineHeightSelect.id = ids.readingLineHeightSelect;
  digestPanel.appendChild(readingLineHeightSelect);

  const readingContentWidthSelect = doc.createElement("div");
  readingContentWidthSelect.id = ids.readingContentWidthSelect;
  digestPanel.appendChild(readingContentWidthSelect);

  const readingInfoSummary = doc.createElement("div");
  readingInfoSummary.id = ids.readingInfoSummary;
  digestPanel.appendChild(readingInfoSummary);

  const readingInfoDescription = doc.createElement("div");
  readingInfoDescription.id = ids.readingInfoDescription;
  digestPanel.appendChild(readingInfoDescription);

  const readingDescriptionBtn = doc.createElement("button");
  readingDescriptionBtn.id = ids.readingDescriptionBtn;
  digestPanel.appendChild(readingDescriptionBtn);

  const readingSubtitleSelect = doc.createElement("select");
  readingSubtitleSelect.id = ids.readingSubtitleSelect;
  digestPanel.appendChild(readingSubtitleSelect);

  const readingChapterVisibilitySelect = doc.createElement("select");
  readingChapterVisibilitySelect.id = ids.readingChapterVisibilitySelect;
  digestPanel.appendChild(readingChapterVisibilitySelect);

  return { readingView, readingMain, digestPanel };
}

// 给播放器链上的元素补可见尺寸，保证 video-probe / player-host 判定通过。
// （PR2：#boc-reading-inline-host 随字幕列表搬进统一面板而移除，列表容器
// 自身不再需要可见尺寸 mock——sync 域滚动路径对其不可见容器本就走兜底。）
export function mockPlayerRects(extraSelectors = []) {
  const selectors = [
    ".bpx-player-primary-area",
    ".bpx-player-video-area",
    ".bpx-player-container",
    "#bilibili-player",
    "#playerWrap",
    ...extraSelectors
  ];

  const nodes = selectors
    .map((selector) => document.querySelector(selector))
    .filter(Boolean);

  nodes.forEach((node) => {
    node.getBoundingClientRect = () => STANDARD_RECT();
  });

  const video = document.querySelector("video");
  if (video) {
    video.getBoundingClientRect = () => STANDARD_RECT();
  }
}

function STANDARD_RECT() {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 450,
    width: 800,
    height: 450,
    toJSON: () => ({})
  };
}

// 预设的阅读模式 URL（对齐 setup.js 的 READER_MODE_URL）。
export function readerModeUrl() {
  return READER_MODE_URL;
}
