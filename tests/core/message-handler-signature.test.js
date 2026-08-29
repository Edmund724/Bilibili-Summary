// 候选5「sidepanel 上下文同步瘦身」content 侧回归测试：
// - computeSidepanelStateSignature：签名字段覆盖 SP 消费的全部可变状态，
//   且对 url/title/hotComments 等非判定字段免疫；
// - sidepanel-get-context 处理器：ifSignature 命中 → 立即回 unchanged（不带
//   payload）；签名不匹配 → 全量 payload 附 signature；forceRefresh 绕过短路；
//   旧调用方不带 ifSignature 自动走全量（向后兼容）。
// mock 模式沿 tests/core/message-handler-chapters.test.js：重依赖全 mock，
// state 走真实模块，单纪元导入。

import { beforeEach, describe, expect, it, vi } from "vitest";

// 原 core/runtime.js 的三个符号已按职责拆分：startUrlWatcher / BOC_URL_CHANGE_EVENT
// 在 core/url-watcher.js，replaceReaderModeUrl 在 bilibili/reader-url.js。
vi.mock("../../extension/core/url-watcher.js", () => ({
  startUrlWatcher: vi.fn(),
  BOC_URL_CHANGE_EVENT: "boc:urlchange"
}));
vi.mock("../../extension/bilibili/reader-url.js", () => ({
  replaceReaderModeUrl: vi.fn()
}));
vi.mock("../../extension/bilibili/video-probe.js", () => ({
  getRuntimeVideoElement: vi.fn(() => null)
}));
vi.mock("../../extension/subtitle/ui.js", () => ({
  getPopupPayload: vi.fn(() => ({}))
}));
vi.mock("../../extension/subtitle/fetcher.js", () => ({
  refreshClip: vi.fn(async () => {}),
  loadSubtitle: vi.fn(async () => {}),
  resetClipState: vi.fn()
}));
vi.mock("../../extension/ui/ui-renderer.js", () => ({
  setStatus: vi.fn(),
  renderSubtitleSelect: vi.fn(),
  ensureUiReady: vi.fn()
}));
vi.mock("../../extension/ai/player-ai.js", () => ({
  removePlayerAiQuickActionButton: vi.fn(),
  schedulePlayerAiQuickActionSync: vi.fn()
}));
vi.mock("../../extension/reader/index.js", () => ({
  updateReaderFollowState: vi.fn(),
  syncReadingViewPlayback: vi.fn(),
  enterReaderMode: vi.fn(async () => {}),
  closeReadingView: vi.fn(),
  isReaderViewOpen: vi.fn(() => false),
  renderReadingStatus: vi.fn(),
  waitForVideoMetadata: vi.fn(async () => {}),
  enforceNormalPageStateIfNeeded: vi.fn()
}));
vi.mock("../../extension/reader/scroll-state.js", () => ({
  resetManualScrollPause: vi.fn()
}));
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: vi.fn(() => ""),
  fetchHotComments: vi.fn(async () => [])
}));

import {
  bindRuntimeEvents,
  computeSidepanelStateSignature
} from "../../extension/core/message-handler.js";
import { state } from "../../extension/core/state.js";

const onMessageListeners = [];
vi.stubGlobal("chrome", {
  runtime: {
    onMessage: {
      addListener: (listener) => onMessageListeners.push(listener)
    }
  }
});

bindRuntimeEvents();
const messageListener = onMessageListeners[0];

function requestContext(message = {}) {
  const sendResponse = vi.fn();
  messageListener({ type: "sidepanel-get-context", ...message }, {}, sendResponse);
  expect(sendResponse).toHaveBeenCalledTimes(1);
  return sendResponse.mock.calls[0][0];
}

// 组一份「就绪」状态的 clip：字段覆盖签名判定矩阵
function seedReadyClip() {
  state.clip.setBvid("BV1sig");
  state.clip.setAid("9");
  state.clip.setCid("101");
  state.clip.setPageIndex(1);
  state.clip.setTitle("签名测试");
  state.clip.setSubtitles([{ id: "s1", subtitleUrl: "u1", lan: "zh" }]);
  state.clip.setSelectedSubtitleId("s1");
  state.clip.setSelectedSubtitleLang("zh-CN");
  state.clip.setSubtitleBody([
    { from: 0, to: 5, content: "第一句" },
    { from: 5, to: 9, content: "第二句" }
  ]);
  state.clip.setSubtitleFetchState("ready");
  state.clip.setNoSubtitleReason(null);
  state.clip.setChapters([]);
}

describe("computeSidepanelStateSignature 纯函数", () => {
  beforeEach(() => {
    seedReadyClip();
  });

  it("同一状态 → 签名稳定", () => {
    const a = computeSidepanelStateSignature(buildPayload());
    const b = computeSidepanelStateSignature(buildPayload());
    expect(a).toBe(b);
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
  });

  it("签名覆盖字段逐一变化 → 签名变化", () => {
    const base = computeSidepanelStateSignature(buildPayload());

    // subtitleBody 长度
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "第一句" }]);
    expect(computeSidepanelStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();

    // subtitleFetchState（ASR 转写完成 → 就绪的关键信号）
    state.clip.setSubtitleFetchState("loading");
    expect(computeSidepanelStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();

    // selectedSubtitleId
    state.clip.setSelectedSubtitleId("s2");
    expect(computeSidepanelStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();

    // subtitleOptions 数量
    state.clip.setSubtitles([
      { id: "s1", subtitleUrl: "u1", lan: "zh" },
      { id: "s2", subtitleUrl: "u2", lan: "en" }
    ]);
    expect(computeSidepanelStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();

    // chapters 数量
    state.clip.setChapters([{ title: "开场", from: 0, to: 60 }]);
    expect(computeSidepanelStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();

    // includeTimestampInBody（设置项变化）
    state.setSettings({ ...(state.settings || {}), includeTimestampInBody: false });
    expect(computeSidepanelStateSignature(buildPayload())).not.toBe(base);
    state.setSettings({ ...(state.settings || {}), includeTimestampInBody: true });

    // bvid / cid / pageIndex / subtitleLang
    state.clip.setBvid("BV1other");
    expect(computeSidepanelStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();
    state.clip.setCid("202");
    expect(computeSidepanelStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();
    state.clip.setPageIndex(2);
    expect(computeSidepanelStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();
    state.clip.setSelectedSubtitleLang("en-US");
    expect(computeSidepanelStateSignature(buildPayload())).not.toBe(base);
    seedReadyClip();
  });

  it("cid 缺失时回退 aid（无 cid 场景仍有稳定键）", () => {
    state.clip.setCid("");
    state.clip.setAid("9");
    const byAid = computeSidepanelStateSignature(buildPayload());
    state.clip.setAid("");
    state.clip.setCid("9");
    const byCid = computeSidepanelStateSignature(buildPayload());
    expect(byAid).toBe(byCid);
  });

  it("非判定字段（title/url/hotComments/pageCount 等）变化 → 签名不变", () => {
    const base = computeSidepanelStateSignature(buildPayload());
    state.clip.setTitle("换了标题");
    state.clip.setPageCount(7);
    state.clip.setSelectedSubtitleUrl("u1?alt=signed");
    state.clip.setNoSubtitleReason("asr-failed");
    const payload = buildPayload();
    payload.url = "https://www.bilibili.com/video/BV1sig/?p=9&t=1";
    payload.hotComments = [{ uname: "u", like: 1, message: "m" }];
    // 数组内容变但长度不变：索引型数组只取长度（与 SP contextKey 去重语义一致）
    payload.subtitleBody = [
      { from: 0, to: 5, content: "完全不同的内容" },
      { from: 5, to: 9, content: "另一条不同的内容" }
    ];
    expect(computeSidepanelStateSignature(payload)).toBe(base);
  });
});

describe("sidepanel-get-context 签名短路", () => {
  beforeEach(() => {
    seedReadyClip();
  });

  it("旧调用方不带 ifSignature → 全量 payload 且附 signature（向后兼容）", () => {
    const response = requestContext();
    expect(response.ok).toBe(true);
    expect(response.payload).toBeTruthy();
    const payload = response.payload;
    expect(payload.bvid).toBe("BV1sig");
    expect(payload.signature).toBe(computeSidepanelStateSignature(payload));
  });

  it("ifSignature 命中 → 立即回 unchanged（无 payload），一次往返", () => {
    const first = requestContext();
    const signature = first.payload.signature;

    const second = requestContext({ ifSignature: signature });
    expect(second).toEqual({ ok: true, unchanged: true, signature });
    expect(second.payload).toBeUndefined();
  });

  it("ifSignature 不匹配（SP 换签/换标签页）→ 走全量路径", () => {
    const response = requestContext({ ifSignature: "stale-signature" });
    expect(response.ok).toBe(true);
    expect(response.payload?.bvid).toBe("BV1sig");
    expect(response.unchanged).toBeUndefined();
  });

  it("forceRefresh=true 时即使签名命中也绕过短路（手动刷新语义）", () => {
    const first = requestContext();
    const signature = first.payload.signature;

    const forced = requestContext({ ifSignature: signature, forceRefresh: true });
    expect(forced.ok).toBe(true);
    expect(forced.payload?.bvid).toBe("BV1sig");
    expect(forced.unchanged).toBeUndefined();
  });

  it("content 状态变化（body 追加）→ 旧签名不再命中，全量返回新状态", () => {
    const first = requestContext();
    const oldSignature = first.payload.signature;

    state.clip.setSubtitleBody([
      ...state.clip.subtitleBody,
      { from: 9, to: 12, content: "第三句" }
    ]);

    const second = requestContext({ ifSignature: oldSignature });
    expect(second.ok).toBe(true);
    expect(second.payload?.subtitleBody).toHaveLength(3);
    expect(second.payload?.signature).not.toBe(oldSignature);
  });
});

function buildPayload() {
  // 经真实处理器组 payload（含 location.href / settings 等运行时输入），
  // 保证签名函数测试的是与线上完全一致的 shape
  const response = requestContext();
  expect(response.ok).toBe(true);
  return response.payload;
}
