// 候选5「sidepanel 上下文同步瘦身」content 侧回归测试：
// - computeSidepanelStateSignature：签名字段覆盖 SP 消费的全部可变状态，
//   且对 url/title/hotComments 等非判定字段免疫；
// - sidepanel-get-context 处理器：ifSignature 命中 → 立即回 unchanged（不带
//   payload）；签名不匹配 → 全量 payload 附 signature；forceRefresh 绕过短路；
//   旧调用方不带 ifSignature 自动走全量（向后兼容）。
// mock 模式沿 tests/core/message-handler-chapters.test.js：重依赖全 mock，
// state 走真实模块，单纪元导入。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  waitForVideoMetadata: vi.fn(async () => {})
}));
vi.mock("../../extension/reader/state.js", () => ({
  isReaderViewOpen: vi.fn(() => false),
  enforceNormalPageStateIfNeeded: vi.fn()
}));
vi.mock("../../extension/reader/presentation.js", () => ({
  renderReadingStatus: vi.fn()
}));
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: vi.fn(() => ""),
  fetchHotComments: vi.fn(async () => [])
}));

import {
  bindRuntimeEvents,
  computeSidepanelStateSignature
} from "../../extension/core/message-handler.js";
import {
  SIDEPANEL_CONTEXT_PAYLOAD_FIELDS,
  SIGNATURE_PARTICIPATING_FIELDS,
  SIGNATURE_INDIRECT_FIELDS,
  SIGNATURE_EXCLUDED_FIELDS,
  createSidepanelContextPayload,
  // 纯函数块直接测 sidepanel-payload.js 的单源实现（message-handler 的 re-export
  // 与此为同一函数，处理器级行为由上方 describe 覆盖）。
  computeSidepanelStateSignature
} from "../../extension/core/sidepanel-payload.js";
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

// ============================================================
// sidepanel-payload 形状单源（补齐模块头注承诺的形状锁死断言）
//
// 覆盖四类对账：
//   1. 形状快照：payload 字段集合/顺序锁死——未过测试不得增删字段；
//   2. 签名三分类（参与/间接/排除）与字段清单的完备性 + 与签名实现的一致性；
//   3. 组装映射：工厂对 state 输入的逐字段映射与缺省/归一化口径；
//   4. 消费方对账锚点：sidepanel 侧读取的快照字段 ⊆ payload ∪ 附加层字段。
// ============================================================

// —— 手写期望固件：改动以上任一清单都必须显式过这里的逐字断言 ——

// sidepanel-get-context 全量 payload 的字段清单（顺序 = 工厂组装序 = 线上 key 序）
const EXPECTED_PAYLOAD_FIELDS = [
  "url",
  "title",
  "author",
  "uploadDate",
  "bvid",
  "cid",
  "aid",
  "pageIndex",
  "pageCount",
  "pageTitle",
  "subtitleBody",
  "videoDuration",
  "includeTimestampInBody",
  "subtitleFetchState",
  "noSubtitleReason",
  "subtitleLang",
  "selectedSubtitleId",
  "selectedSubtitleUrl",
  "subtitleOptions",
  "chapters",
  "hotComments"
];

// 签名投影表派生的参与字段（顺序 = join 序列化顺序，重排需显式过测试）
const EXPECTED_PARTICIPATING_FIELDS = [
  "bvid",
  "cid",
  "pageIndex",
  "subtitleFetchState",
  "subtitleBody",
  "selectedSubtitleId",
  "subtitleOptions",
  "chapters",
  "includeTimestampInBody",
  "subtitleLang"
];

// 间接参与：仅 cid 为空时经 cid 投影回退进入签名
const EXPECTED_INDIRECT_FIELDS = ["aid"];

// 刻意排除出签名的字段
const EXPECTED_EXCLUDED_FIELDS = [
  "hotComments",
  "url",
  "title",
  "author",
  "uploadDate",
  "pageCount",
  "pageTitle",
  "videoDuration",
  "selectedSubtitleUrl",
  "noSubtitleReason"
];

// —— 组装映射固件：字段名映射注意 subtitleLang ← clip.selectedSubtitleLang、
//    subtitleOptions ← clip.subtitles（payload 与 clip 的字段名不同名）——
const FULL_CLIP = {
  title: "映射测试视频",
  author: "某位UP主",
  uploadDate: "2026-01-02",
  bvid: "BV1map",
  cid: "201",
  aid: "99",
  pageIndex: 3,
  pageCount: 12,
  pageTitle: "第三话",
  subtitleBody: [
    { from: 0, to: 5, content: "第一句" },
    { from: 5, to: 9, content: "第二句" }
  ],
  videoDuration: 754.5,
  subtitleFetchState: "ready",
  noSubtitleReason: "",
  selectedSubtitleLang: "zh-CN",
  selectedSubtitleId: "s9",
  selectedSubtitleUrl: "https://subtitle/9",
  subtitles: [{ id: "s9" }, { id: "s8" }],
  chapters: [{ title: "开场", from: 0, to: 60 }]
};
const FULL_SETTINGS = { includeTimestampInBody: true };
const FULL_URL = "https://www.bilibili.com/video/BV1map/?p=3";

// 与 FULL_CLIP/FULL_SETTINGS/FULL_URL 对应的期望 payload（全字段）
const EXPECTED_FULL_PAYLOAD = {
  url: FULL_URL,
  title: "映射测试视频",
  author: "某位UP主",
  uploadDate: "2026-01-02",
  bvid: "BV1map",
  cid: "201",
  aid: "99",
  pageIndex: 3,
  pageCount: 12,
  pageTitle: "第三话",
  subtitleBody: FULL_CLIP.subtitleBody,
  videoDuration: 754.5,
  includeTimestampInBody: true,
  subtitleFetchState: "ready",
  // "" || null → null：空串归一为 null（未知/未归类）
  noSubtitleReason: null,
  subtitleLang: "zh-CN",
  selectedSubtitleId: "s9",
  selectedSubtitleUrl: "https://subtitle/9",
  subtitleOptions: FULL_CLIP.subtitles,
  chapters: FULL_CLIP.chapters,
  hotComments: []
};

// 纯函数块的基础 payload：直接经工厂组（不经处理器），只依赖单源模块
function makeFullPayload() {
  return createSidepanelContextPayload({
    clip: FULL_CLIP,
    settings: FULL_SETTINGS,
    url: FULL_URL
  });
}

describe("sidepanel-payload 形状快照与签名三分类对账", () => {
  it("字段清单常量逐字锁死（增删字段/重排必须显式过测试）", () => {
    expect([...SIDEPANEL_CONTEXT_PAYLOAD_FIELDS]).toEqual(EXPECTED_PAYLOAD_FIELDS);
  });

  it("工厂产物的 key 集合与顺序 = 字段清单（形状快照）", () => {
    const payload = makeFullPayload();
    expect(Object.keys(payload)).toEqual(EXPECTED_PAYLOAD_FIELDS);
  });

  it("处理器接线一致性：经 sidepanel-get-context 组出的 payload key 序 = 字段清单 + signature", () => {
    // message-handler 的 buildSidepanelContextPayload 壳只喂运行时输入，产出形状
    // 必须与工厂直出一致；signature 由处理器附加在末尾。
    expect(Object.keys(buildPayload())).toEqual([...EXPECTED_PAYLOAD_FIELDS, "signature"]);
  });

  it("签名三分类常量逐字锁死", () => {
    expect([...SIGNATURE_PARTICIPATING_FIELDS]).toEqual(EXPECTED_PARTICIPATING_FIELDS);
    expect([...SIGNATURE_INDIRECT_FIELDS]).toEqual(EXPECTED_INDIRECT_FIELDS);
    expect([...SIGNATURE_EXCLUDED_FIELDS]).toEqual(EXPECTED_EXCLUDED_FIELDS);
  });

  it("三分类完备：参与 ∪ 间接 ∪ 排除 = 字段清单，且两两不交", () => {
    const union = new Set([
      ...SIGNATURE_PARTICIPATING_FIELDS,
      ...SIGNATURE_INDIRECT_FIELDS,
      ...SIGNATURE_EXCLUDED_FIELDS
    ]);
    expect([...union].sort()).toEqual([...SIDEPANEL_CONTEXT_PAYLOAD_FIELDS].sort());

    const participating = new Set(SIGNATURE_PARTICIPATING_FIELDS);
    const indirect = new Set(SIGNATURE_INDIRECT_FIELDS);
    const excluded = new Set(SIGNATURE_EXCLUDED_FIELDS);
    for (const field of SIGNATURE_PARTICIPATING_FIELDS) {
      expect(indirect.has(field) || excluded.has(field), `参与字段 ${field} 不得同时出现在间接/排除清单`).toBe(false);
    }
    for (const field of SIGNATURE_INDIRECT_FIELDS) {
      expect(participating.has(field) || excluded.has(field), `间接字段 ${field} 不得同时出现在参与/排除清单`).toBe(false);
    }
    for (const field of SIGNATURE_EXCLUDED_FIELDS) {
      expect(participating.has(field) || indirect.has(field), `排除字段 ${field} 不得同时出现在参与/间接清单`).toBe(false);
    }
  });

  it("排除清单逐字段机械遍历：实质扰动 → 签名不变", () => {
    const base = computeSidepanelStateSignature(makeFullPayload());
    // 每个排除字段一个「穿透普通等值比较」的实质扰动值（数组换内容、字符串换值）
    const mutations = {
      hotComments: [{ uname: "评论者", like: 1, message: "热评内容" }],
      url: "https://www.bilibili.com/video/BV1map/?p=3&t=9",
      title: "被站点改写的标题 - 哔哩哔哩",
      author: "另一位UP主",
      uploadDate: "2020-06-01",
      pageCount: 77,
      pageTitle: "另一话标题",
      videoDuration: 12345,
      selectedSubtitleUrl: "https://subtitle/9?alt=signed",
      // 基础 payload 里为 null（"" || null），扰动为非空原因
      noSubtitleReason: "asr-failed"
    };
    expect(Object.keys(mutations).sort()).toEqual([...SIGNATURE_EXCLUDED_FIELDS].sort());

    for (const field of SIGNATURE_EXCLUDED_FIELDS) {
      const mutated = { ...makeFullPayload(), [field]: mutations[field] };
      expect(
        computeSidepanelStateSignature(mutated),
        `被排除字段 ${field} 变化不应改变签名`
      ).toBe(base);
    }
  });

  it("间接字段 aid：cid 在场时签名不变；cid 缺席时经回退投影生效", () => {
    const base = computeSidepanelStateSignature(makeFullPayload());
    // cid 非空：aid 自身变化不独立驱动签名
    expect(computeSidepanelStateSignature({ ...makeFullPayload(), aid: "100" })).toBe(base);
    // cid 为空：aid 经 cid 投影回退进入签名
    const withoutCid = { ...makeFullPayload(), cid: "" };
    const byAid99 = computeSidepanelStateSignature(withoutCid);
    expect(computeSidepanelStateSignature({ ...withoutCid, aid: "100" })).not.toBe(byAid99);
  });

  it("参与字段逐字段机械遍历：按投影语义扰动 → 签名变化", () => {
    const full = makeFullPayload();
    const base = computeSidepanelStateSignature(full);
    // 扰动值必须穿透该字段的投影语义：索引型数组（只取长度）用「追加元素」，
    // 归一化标量（trim/Number/!==false）用归一化后不同的值
    const mutations = {
      bvid: "BV1other",
      cid: "202",
      pageIndex: 4,
      subtitleFetchState: "loading",
      subtitleBody: [...full.subtitleBody, { from: 9, to: 12, content: "第三句" }],
      selectedSubtitleId: "s10",
      subtitleOptions: [...full.subtitleOptions, { id: "s7" }],
      chapters: [...full.chapters, { title: "高潮", from: 60, to: 120 }],
      includeTimestampInBody: false,
      subtitleLang: "en-US"
    };
    expect(Object.keys(mutations).sort()).toEqual([...SIGNATURE_PARTICIPATING_FIELDS].sort());

    for (const field of SIGNATURE_PARTICIPATING_FIELDS) {
      const mutated = { ...full, [field]: mutations[field] };
      expect(
        computeSidepanelStateSignature(mutated),
        `参与字段 ${field} 变化应改变签名`
      ).not.toBe(base);
    }
  });

  it("索引型数组等长换内容 → 签名不变（与 SP contextKey 去重语义一致）", () => {
    const full = makeFullPayload();
    const base = computeSidepanelStateSignature(full);
    const mutated = {
      ...full,
      subtitleBody: [
        { from: 0, to: 5, content: "完全不同的内容" },
        { from: 5, to: 9, content: "另一条不同的内容" }
      ],
      subtitleOptions: [{ id: "s9x" }, { id: "s8x" }],
      chapters: [{ title: "另一章节", from: 5, to: 55 }]
    };
    expect(computeSidepanelStateSignature(mutated)).toBe(base);
  });
});

describe("createSidepanelContextPayload 组装映射", () => {
  it("完整输入：逐字段与 state 输入映射正确（含字段名映射）", () => {
    const payload = makeFullPayload();
    for (const field of EXPECTED_PAYLOAD_FIELDS) {
      expect(payload[field], `字段 ${field}`).toEqual(EXPECTED_FULL_PAYLOAD[field]);
    }
  });

  it("无参/空 clip：全字段落到缺省口径", () => {
    // settings 缺省 → includeTimestampInBody 按 !== false 判 true；url 由调用方
    // 注入，无参时原样透传 undefined。
    const payload = createSidepanelContextPayload();
    const expected = {
      url: undefined,
      title: "",
      author: "",
      uploadDate: "",
      bvid: "",
      cid: "",
      aid: "",
      pageIndex: 1,
      pageCount: 0,
      pageTitle: "",
      subtitleBody: [],
      videoDuration: 0,
      includeTimestampInBody: true,
      subtitleFetchState: "idle",
      noSubtitleReason: null,
      subtitleLang: "",
      selectedSubtitleId: "",
      selectedSubtitleUrl: "",
      subtitleOptions: [],
      chapters: [],
      hotComments: []
    };
    for (const field of EXPECTED_PAYLOAD_FIELDS) {
      expect(payload[field], `字段 ${field} 的缺省值`).toEqual(expected[field]);
    }
  });

  it("归一化分支：pageIndex/pageCount/videoDuration 的 Number 归一与缺省回退", () => {
    const build = (clip) => createSidepanelContextPayload({ clip, settings: {}, url: "u" });
    // pageIndex：>0 才收（字符串数字收为 number），否则回退 1
    expect(build({ pageIndex: "3" }).pageIndex).toBe(3);
    expect(build({ pageIndex: 0 }).pageIndex).toBe(1);
    expect(build({ pageIndex: -2 }).pageIndex).toBe(1);
    // pageCount：>0 才收，否则 0（与 pageIndex 的回退方向不同：0 表「无分 P 信息」）
    expect(build({ pageCount: "5" }).pageCount).toBe(5);
    expect(build({ pageCount: -1 }).pageCount).toBe(0);
    // videoDuration：Number() 归一，NaN/缺失回退 0
    expect(build({ videoDuration: "180.5" }).videoDuration).toBe(180.5);
    expect(build({ videoDuration: "abc" }).videoDuration).toBe(0);
    expect(build({}).videoDuration).toBe(0);
  });

  it("归一化分支：noSubtitleReason/chapters/subtitleFetchState 的缺省口径", () => {
    const build = (clip) => createSidepanelContextPayload({ clip, settings: {}, url: "u" });
    // noSubtitleReason：缺失/空串归一为 null，非空原样透传
    expect(build({}).noSubtitleReason).toBe(null);
    expect(build({ noSubtitleReason: "" }).noSubtitleReason).toBe(null);
    expect(build({ noSubtitleReason: "asr-empty" }).noSubtitleReason).toBe("asr-empty");
    // chapters：非数组一律归一为空数组（有 Array.isArray 守卫）
    expect(build({ chapters: "x" }).chapters).toEqual([]);
    expect(build({ chapters: [{ title: "开场", from: 0, to: 60 }] }).chapters).toHaveLength(1);
    // subtitleFetchState：缺失回退 idle
    expect(build({}).subtitleFetchState).toBe("idle");
    expect(build({ subtitleFetchState: "loading" }).subtitleFetchState).toBe("loading");
  });

  it("includeTimestampInBody 口径：仅显式 false 关闭，缺失按默认 true", () => {
    const build = (settings) => createSidepanelContextPayload({ clip: {}, settings, url: "u" });
    expect(build(undefined).includeTimestampInBody).toBe(true);
    expect(build({}).includeTimestampInBody).toBe(true);
    expect(build({ includeTimestampInBody: false }).includeTimestampInBody).toBe(false);
    expect(build({ includeTimestampInBody: true }).includeTimestampInBody).toBe(true);
    // 仅 `!== false` 判定：0 等其他 falsy 值视为开启（与 offscreen 渲染侧同口径）
    expect(build({ includeTimestampInBody: 0 }).includeTimestampInBody).toBe(true);
  });
});

// ============================================================
// 消费方对账锚点（静态扫描）
//
// 契约边界（sidepanel-payload.js 头注）：SP 实际持有的快照 =
//   payload + { signature }（message-handler 附加）
//          + { hotComments 覆盖, isVideoContext }（background 转发层补写）。
// 这里把对账结论固化为测试：扫描 sidepanel 消费方源码中对快照的属性访问，
// 逐点断言「扫描结果 == 手写期望集」且「⊆ 允许集」。相等断言防漏报（新增
// 读取必须显式更新期望），子集断言即对账结论本身。
// 取舍说明：pages/sidepanel.js 等是 UI 编排层（模块顶层即操作 DOM），无法
// 在 Node 单测里实例化，故对消费方采用源码静态断言而非行为断言。
// ============================================================

// 允许 SP 读取的快照字段全集 = payload 清单 ∪ 附加层字段 ∪ 两处已记录的兼容项
const ALLOWED_SNAPSHOT_FIELDS = new Set([
  ...SIDEPANEL_CONTEXT_PAYLOAD_FIELDS,
  "signature", // message-handler 处理器附加（ifSignature 回传来源）
  "hotComments", // background getAiSidepanelState 整体覆盖
  "isVideoContext", // background getAiSidepanelState 补写（content 不组装）
  // 兼容回退（已记录，非 payload 字段）：ai/conversation.js 的旧持久化会话
  // ref 兼容读取——context?.pageIndex 缺失时回落 context?.page
  "page",
  // 响应信封字段（非快照字段）：sidepanel.js 读 resp.payload.unchanged 判定
  // 签名短路
  "unchanged"
]);

// 读消费方源码（相对本测试文件的路径）；剔除整行注释与块注释，让扫描只看
// 代码——注释里的字段名举例不应参与对账，也不应因措辞变化造成误报。
function readSource(relativePath) {
  // TS 渐进迁移期间源文件可能是 .js 或 .ts，缺失时回退到另一扩展名。
  const jsUrl = new URL(relativePath, import.meta.url);
  const url = existsSync(fileURLToPath(jsUrl))
    ? jsUrl
    : new URL(relativePath.replace(/\.js$/, ".ts"), import.meta.url);
  const raw = readFileSync(fileURLToPath(url), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

// 扫描源码中 `<receiver>?.field` / `<receiver>.field` 形式的属性访问字段名。
// lookbehind 防子串误配（如 liveContextData 内含 contextData）。
// 允许 TS 非空断言 `receiver!.field`（迁移期 .ts 源码常见）。
function scanFields(source, receiver) {
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${receiver}[?!]*\\.([A-Za-z_$][\\w$]*)`, "g");
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

// 按函数锚点切出源码块（消费方模块内参数别名只在其函数内有意义）
function sliceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  expect(start, `源码中应存在锚点 ${startMarker}`).toBeGreaterThan(-1);
  const from = start + startMarker.length;
  const end = endMarker ? source.indexOf(endMarker, from) : source.length;
  return source.slice(start, end > start ? end : source.length);
}

// 单个对账点：扫描结果 == 手写期望集（防漏报），且 ⊆ 允许集（对账结论）。
// point 为空集时说明锚点漂移（期望集非空必然失败）。
function assertReconciliation(point, expectedFields, label) {
  const expected = new Set(expectedFields);
  expect([...point].sort(), `${label} 扫描到的字段`).toEqual([...expected].sort());
  for (const field of point) {
    expect(
      ALLOWED_SNAPSHOT_FIELDS.has(field),
      `${label} 读取的快照字段 ${field} 不在 payload ∪ 附加层字段内（新增读取必须过对账测试）`
    ).toBe(true);
  }
}

describe("消费方对账锚点：SP 读取字段 ⊆ payload ∪ {signature, hotComments, isVideoContext}", () => {
  it("pages/sidepanel.js 直接读取的快照字段", () => {
    const source = readSource("../../extension/pages/sidepanel.js");
    // contextData：chip 文案/跳转（title/url）、非视频页判定（isVideoContext）、
    // 无字幕发送拦截（noSubtitleReason）
    assertReconciliation(
      scanFields(source, "contextData"),
      ["title", "url", "isVideoContext", "noSubtitleReason"],
      "sidepanel.js contextData"
    );
    // liveContextData：ifSignature 回传（signature）+ 历史列表 live 匹配（isVideoContext）
    assertReconciliation(
      scanFields(source, "liveContextData"),
      ["signature", "isVideoContext"],
      "sidepanel.js liveContextData"
    );
    // liveVideoRef = liveContextData 的局部别名（renderHistoryList）
    assertReconciliation(scanFields(source, "liveVideoRef"), ["url"], "sidepanel.js liveVideoRef");
    // resp.payload 整体落地 liveContextData，无字段级读取（unchanged 判定已
    // 抽到 sidepanel-context-policy.js，见下一个用例）
    assertReconciliation(scanFields(source, "payload"), [], "sidepanel.js resp.payload");
  });

  it("pages/sidepanel-context-policy.js：unchanged 短路判定读响应信封字段", () => {
    // loadContextState 的分支判定纯函数（候选08 抽出）：skip-unchanged 分支读
    // response.payload.unchanged === true。unchanged 是响应信封字段（非快照
    // 字段），已在 ALLOWED_SNAPSHOT_FIELDS 记录。
    const source = readSource("../../extension/pages/sidepanel-context-policy.js");
    assertReconciliation(
      scanFields(source, "payload"),
      ["unchanged"],
      "context-policy resp.payload"
    );
  });

  it("pages/sidepanel-subtitle-wait.js：等待轮询读 subtitleFetchState/subtitleBody", () => {
    const source = readSource("../../extension/pages/sidepanel-subtitle-wait.js");
    assertReconciliation(
      scanFields(source, "snapshot"),
      ["subtitleBody", "subtitleFetchState"],
      "subtitle-wait snapshot"
    );
  });

  it("pages/sidepanel-no-subtitle.js：无字幕拦截读 subtitleFetchState/subtitleBody", () => {
    const source = readSource("../../extension/pages/sidepanel-no-subtitle.js");
    assertReconciliation(
      scanFields(source, "snapshot"),
      ["subtitleBody", "subtitleFetchState"],
      "no-subtitle snapshot"
    );
  });

  it("ai/conversation.js：上下文键与 AI ref 构造读取的字段（含 page 兼容回退）", () => {
    const source = readSource("../../extension/ai/conversation.js");
    // buildContextKey：视频身份键，无 bvid/cid/aid 时经 url 回落
    assertReconciliation(
      scanFields(sliceBlock(source, "export function buildContextKey", "function normalizeContextUrlForKey"), "payload"),
      ["bvid", "cid", "aid", "url"],
      "buildContextKey payload"
    );
    // buildAiContextRef：会话持久化 ref 的 15 字段构造（含 isVideoContext 透传）
    assertReconciliation(
      scanFields(sliceBlock(source, "export function buildAiContextRef", "export function buildContextPlaceholder"), "value"),
      [
        "url",
        "title",
        "author",
        "uploadDate",
        "bvid",
        "cid",
        "aid",
        "pageIndex",
        "pageCount",
        "pageTitle",
        "subtitleLang",
        "selectedSubtitleId",
        "selectedSubtitleUrl",
        "chapters",
        "isVideoContext"
      ],
      "buildAiContextRef value"
    );
    // extractConversationPageSuffix：pageIndex 缺失时回落 page（旧持久化会话 ref
    // 的兼容字段，已在 ALLOWED_SNAPSHOT_FIELDS 记录）
    assertReconciliation(
      scanFields(sliceBlock(source, "function extractConversationPageSuffix", "function generateConversationId"), "context"),
      ["pageIndex", "page", "url"],
      "extractConversationPageSuffix context"
    );
  });

  it("ai/context-resolver.js getAiSidepanelState：转发层读取与覆盖契约", () => {
    const source = readSource("../../extension/ai/context-resolver.js");
    const block = sliceBlock(source, "export async function getAiSidepanelState");
    // hasLoadedClip 判定（bvid/aid/title）+ needsRefresh 的字幕体空判定（subtitleBody）
    assertReconciliation(
      scanFields(block, "payload"),
      ["bvid", "aid", "title", "subtitleBody"],
      "getAiSidepanelState payload"
    );
    // 覆盖契约固化：返回包 = 整包展开 content payload + hotComments 整体覆盖 +
    // isVideoContext 补写（content 侧恒 [] 的字段在此获得真值）
    expect(block).toMatch(/\.\.\.contextResp\.payload/);
    expect(block).toMatch(/(?<![A-Za-z0-9_$])hotComments\s*,/);
    expect(block).toMatch(/isVideoContext:\s*true/);
    // 签名短路透传：content 回 unchanged 时转发层原样上抛（不带快照）
    expect(block).toMatch(/unchanged:\s*true/);
  });

  it("pages/sidepanel-chat-runtime.js：整包转发 contextData（含 subtitleBody 省略重传）", () => {
    // offscreen 渲染链（videoDuration/includeTimestampInBody/chapters 等）的字段级
    // 消费不在 SP 对账锚点范围（由整包展开天然随 payload 下传）；此处仅固化转发
    // 形态：contextData 整包展开 + contextKey 命中时删除 subtitleBody 省传输。
    const source = readSource("../../extension/pages/sidepanel-chat-runtime.js");
    expect(source).toMatch(/\.\.\.sidepanelState\.contextData/);
    expect(source).toMatch(/delete context\.subtitleBody/);
  });

  it("pages/sidepanel-state.js：状态容器整对象持有快照，无字段级消费", () => {
    // contextData/liveContextData 在容器中以整对象存取，对账锚点由上面的读取方
    // 覆盖；此处断言容器源码中不出现对快照的字段级访问（防未来在容器层散读）。
    const source = readSource("../../extension/pages/sidepanel-state.js");
    expect(scanFields(source, "contextData").size).toBe(0);
    expect(scanFields(source, "liveContextData").size).toBe(0);
  });
});
