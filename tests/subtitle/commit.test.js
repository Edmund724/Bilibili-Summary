// subtitle/commit.js 字幕接受事务测试（CONTEXT.md「字幕接受」词条的契约锁）。
//
// 一段字幕成为当前视频生效字幕的唯一事务：稳定排序（from 升序，读路径
// findActiveSubtitleIndex 二分依赖）→ 写 state（selectedSubtitleId/Url/Lang +
// subtitleBody）→ fetchState="ready" → 清 noSubtitleReason → await
// refreshDerivedContent() → reader 开启则通知 "subtitle-ready"。本套件在纯
// state 级锁死这些不变量；无字幕出口（逆事务）与接受互为逆，同样锁清空完整性。
//
// mock 结构：refreshDerivedContent mock（派生刷新的调用/时序断言是本套件职责，
// 笔记构建本体归 core.test.js）、presenter mock（notifyReaderPresenter 可观察）。
// 渲染/状态栏回调（renderMeta/renderSubtitleSelect/setStatus）不静态可达，经
// configureCommitUi 注入 vi.fn——与生产由 fetcher 注入同一条接线。
// view-state / dom-utils / reader-ids / selection / state 保持真实：纯叶子。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { state, clipState } from "../../extension/core/state.js";
import {
  acceptSubtitle,
  commitNoSubtitle,
  configureCommitUi,
  buildNoSubtitleStatusMessage
} from "../../extension/subtitle/commit.js";
import { refreshDerivedContent } from "../../extension/subtitle/core.js";
import { notifyReaderPresenter } from "../../extension/reader/presenter.js";

vi.mock("../../extension/subtitle/core.js", () => ({
  refreshDerivedContent: vi.fn(async () => {})
}));
vi.mock("../../extension/reader/presenter.js", () => ({
  notifyReaderPresenter: vi.fn(),
  subscribeSubtitleRefresh: vi.fn(() => () => {}),
  subscribeReaderPresenter: vi.fn(() => () => {})
}));

// 乱序字幕体（含同 from 条目验证稳定排序）：内容字段编码了期望顺序
const UNSORTED_BODY = [
  { from: 3, to: 290, content: "c-最后" },
  { from: 0, to: 1.2, content: "a-第一" },
  { from: 1.5, to: 2.4, content: "b-第二" },
  { from: 0, to: 0.5, content: "a2-同from稳定" }
];

function expectStrictlySortedByFrom(body) {
  for (let i = 1; i < body.length; i += 1) {
    expect(Number(body[i].from)).toBeGreaterThanOrEqual(Number(body[i - 1].from));
  }
}

let commitUiMocks;

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  // commitNoSubtitle（真实代码）通过 byId("boc-preview") 清预览 DOM，需该节点
  const preview = document.createElement("textarea");
  preview.id = "boc-preview";
  document.body.appendChild(preview);

  // 与生产一致：fetcher 在模块求值期注入的渲染/状态栏回调，这里注入 vi.fn
  commitUiMocks = {
    renderMeta: vi.fn(),
    renderSubtitleSelect: vi.fn(),
    setStatus: vi.fn()
  };
  configureCommitUi(commitUiMocks);

  state.reader.setViewOpen(false);
  vi.mocked(refreshDerivedContent).mockClear();
  vi.mocked(notifyReaderPresenter).mockClear();
});

describe("acceptSubtitle：字幕接受事务", () => {
  it("乱序输入 → subtitleBody 严格 from 升序（同 from 保持原相对顺序），返回排序副本且不改入参", async () => {
    const result = await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });

    const body = state.clip.subtitleBody;
    expectStrictlySortedByFrom(body);
    // 稳定排序：同 from=0 的两条保持输入中的相对顺序（a 先于 a2）
    expect(body.map((item) => item.content)).toEqual(["a-第一", "a2-同from稳定", "b-第二", "c-最后"]);
    // 返回值即落 state 的有序副本
    expect(result).toEqual(body);
    // 不原地修改入参（调用方持有的原引用——如缓存副本——保持不变）
    expect(UNSORTED_BODY.map((item) => item.content)).toEqual(["c-最后", "a-第一", "b-第二", "a2-同from稳定"]);
  });

  it("写齐 selected 三项 + fetchState=ready + 清除陈旧 noSubtitleReason", async () => {
    // 预放脏状态：出口残留的 empty 态与失败原因必须被接受事务一次性翻转
    clipState.setSelectedSubtitleId("stale");
    clipState.setSubtitleBody([{ from: 9, to: 10, content: "旧字幕" }]);
    clipState.setSubtitleFetchState("empty");
    clipState.setNoSubtitleReason("asr-failed");

    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-2",
      selectedSubtitleUrl: "https://example.com/sub2.json",
      selectedSubtitleLang: "英语"
    });

    expect(state.clip.selectedSubtitleId).toBe("track-2");
    expect(state.clip.selectedSubtitleUrl).toBe("https://example.com/sub2.json");
    expect(state.clip.selectedSubtitleLang).toBe("英语");
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(clipState.noSubtitleReason).toBe(null);
  });

  it("await 派生刷新：refreshDerivedContent 恰好在 state 落位后被调用一次", async () => {
    let stateAtRefresh = null;
    vi.mocked(refreshDerivedContent).mockImplementation(async () => {
      stateAtRefresh = {
        body: state.clip.subtitleBody.map((item) => item.content),
        fetchState: state.clip.subtitleFetchState,
        reason: clipState.noSubtitleReason
      };
    });

    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });

    expect(refreshDerivedContent).toHaveBeenCalledTimes(1);
    // 派生内容（笔记/SRT/TXT/预览）读到的是已接受完成的状态，不是半事务态
    expect(stateAtRefresh).toEqual({
      body: ["a-第一", "a2-同from稳定", "b-第二", "c-最后"],
      fetchState: "ready",
      reason: null
    });
  });

  it("reader 开启 → 通知 subtitle-ready；关闭 → 不通知", async () => {
    state.reader.setViewOpen(true);
    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });
    expect(notifyReaderPresenter).toHaveBeenCalledWith("subtitle-ready");

    state.reader.setViewOpen(false);
    vi.mocked(notifyReaderPresenter).mockClear();
    await acceptSubtitle({
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });
    expect(notifyReaderPresenter).not.toHaveBeenCalled();
  });

  it("幂等：已有序 body 再次接受，内容与顺序不变", async () => {
    const sorted = [...UNSORTED_BODY].sort((a, b) => a.from - b.from);
    await acceptSubtitle({
      body: sorted,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });
    const first = state.clip.subtitleBody;

    await acceptSubtitle({
      body: first,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    });

    expect(state.clip.subtitleBody).toEqual(first);
    expectStrictlySortedByFrom(state.clip.subtitleBody);
  });
});

describe("commitNoSubtitle：无字幕出口（逆事务）", () => {
  it("清空完整性：selected 三项/body/派生内容/preview DOM 全清，fetchState=empty，渲染回调触发", async () => {
    // 预放脏状态：与接受后的 state 互为镜像
    clipState.setSelectedSubtitleId("track-1");
    clipState.setSelectedSubtitleUrl("https://example.com/sub.json");
    clipState.setSelectedSubtitleLang("中文");
    clipState.setSubtitleBody(UNSORTED_BODY);
    clipState.setSubtitleFetchState("ready");
    clipState.setHotComments([{ content: "热评", like: 1 }]);
    clipState.setMarkdown("# 笔记");
    clipState.setSrt("1\n00:00:00,000 --> 00:00:01,000 你好");
    clipState.setTxt("你好");
    document.getElementById("boc-preview").value = "预览文本";
    clipState.setNoSubtitleReason("asr-empty");

    await commitNoSubtitle({ asrResult: "empty" });

    expect(state.clip.selectedSubtitleId).toBe("");
    expect(state.clip.selectedSubtitleUrl).toBe("");
    expect(state.clip.selectedSubtitleLang).toBe("");
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(state.clip.hotComments).toEqual([]);
    expect(state.clip.markdown).toBe("");
    expect(state.clip.srt).toBe("");
    expect(state.clip.txt).toBe("");
    expect(document.getElementById("boc-preview").value).toBe("");
    // 原因未显式传参：保留 maybeRunAsrFallback 终态分支写入的值，不覆盖
    expect(clipState.noSubtitleReason).toBe("asr-empty");
    // 轨道/元信息落空态的渲染由注入回调完成
    expect(commitUiMocks.renderMeta).toHaveBeenCalledTimes(1);
    expect(commitUiMocks.renderSubtitleSelect).toHaveBeenCalledTimes(1);
  });

  it("noSubtitleReason：显式传参写入（含 null 清空），undefined 保留现有值", async () => {
    clipState.setNoSubtitleReason("asr-failed");
    await commitNoSubtitle({ noSubtitleReason: "asr-failed", asrResult: "error" });
    expect(clipState.noSubtitleReason).toBe("asr-failed");

    // fallback 失败出口的形状：原因随出口写入事务
    clipState.setNoSubtitleReason("no-asr-config");
    await commitNoSubtitle({ noSubtitleReason: null, asrResult: "empty" });
    expect(clipState.noSubtitleReason).toBe(null);
  });

  it("reader 开启 → 通知 ('subtitle-ready', '当前视频无字幕。')；关闭 → 不通知", async () => {
    state.reader.setViewOpen(true);
    await commitNoSubtitle({ asrResult: "empty" });
    expect(notifyReaderPresenter).toHaveBeenCalledWith("subtitle-ready", "当前视频无字幕。");

    state.reader.setViewOpen(false);
    vi.mocked(notifyReaderPresenter).mockClear();
    await commitNoSubtitle({ asrResult: "empty" });
    expect(notifyReaderPresenter).not.toHaveBeenCalled();
  });

  it("asrResult=skip → 状态栏落引导文案；empty/error/缺省 → 不出文案", async () => {
    const commitUi = { renderMeta: vi.fn(), renderSubtitleSelect: vi.fn(), setStatus: vi.fn() };
    configureCommitUi(commitUi);

    clipState.setNoSubtitleReason("no-asr-config");
    await commitNoSubtitle({ asrResult: "skip" });
    expect(commitUi.setStatus).toHaveBeenCalledWith(buildNoSubtitleStatusMessage());
    expect(commitUi.setStatus).toHaveBeenCalledTimes(1);

    commitUi.setStatus.mockClear();
    clipState.setNoSubtitleReason("asr-empty");
    await commitNoSubtitle({ asrResult: "skip" });
    expect(commitUi.setStatus).toHaveBeenCalledWith(
      "当前视频无字幕。 可在设置页配置语音识别平台自动生成字幕。"
    );

    // 文案已由 maybeRunAsrFallback 各终态分支写好，事务不覆盖
    commitUi.setStatus.mockClear();
    await commitNoSubtitle({ asrResult: "error" });
    await commitNoSubtitle({ asrResult: "empty" });
    await commitNoSubtitle({});
    expect(commitUi.setStatus).not.toHaveBeenCalled();
  });
});

describe("接受 ↔ 无字幕出口 互逆", () => {
  it("接受 → 出口 → 全空；出口 → 接受 → ready 且派生被再次刷新", async () => {
    const acceptArgs = {
      body: UNSORTED_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文"
    };

    await acceptSubtitle(acceptArgs);
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(refreshDerivedContent).toHaveBeenCalledTimes(1);

    await commitNoSubtitle({ asrResult: "empty" });
    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.selectedSubtitleId).toBe("");
    expect(state.clip.markdown).toBe("");

    await acceptSubtitle(acceptArgs);
    expect(state.clip.subtitleFetchState).toBe("ready");
    expectStrictlySortedByFrom(state.clip.subtitleBody);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(refreshDerivedContent).toHaveBeenCalledTimes(2);
  });
});

describe("buildNoSubtitleStatusMessage（自 fetcher 随迁的文案契约）", () => {
  it("no-asr-config：引导免费申请硅基流动 API Key 并填入设置页", () => {
    clipState.setNoSubtitleReason("no-asr-config");
    expect(buildNoSubtitleStatusMessage()).toBe(
      "当前视频无字幕。 可免费申请硅基流动 API Key 并填入设置页，自动生成字幕。"
    );
  });

  it("其余原因与未知（asr-disabled/asr-failed/asr-empty/null）：维持通用引导句", () => {
    for (const reason of ["asr-disabled", "asr-failed", "asr-empty", null]) {
      clipState.setNoSubtitleReason(reason);
      expect(buildNoSubtitleStatusMessage()).toBe(
        "当前视频无字幕。 可在设置页配置语音识别平台自动生成字幕。"
      );
    }
  });

  it("显式 base 参数仍生效（reason 默认读 clipState）", () => {
    clipState.setNoSubtitleReason("no-asr-config");
    expect(buildNoSubtitleStatusMessage("这个视频没有字幕。")).toBe(
      "这个视频没有字幕。 可免费申请硅基流动 API Key 并填入设置页，自动生成字幕。"
    );
    // 显式 reason 覆盖 clipState
    expect(buildNoSubtitleStatusMessage("当前视频无字幕。", "asr-empty")).toBe(
      "当前视频无字幕。 可在设置页配置语音识别平台自动生成字幕。"
    );
  });
});

describe("未接线防护", () => {
  it("configureCommitUi 未注入时 commitNoSubtitle 拒绝执行（防静默丢渲染）", async () => {
    // 新纪元拿到未经 configureCommitUi 的 commit 实例（守卫在触碰 state 前抛出）
    vi.resetModules();
    const freshCommit = await import("../../extension/subtitle/commit.js");
    const freshState = await import("../../extension/core/state.js");

    await expect(freshCommit.commitNoSubtitle({ asrResult: "empty" })).rejects.toThrow("configureCommitUi");
    // 守卫先于任何 state 写入
    expect(freshState.clipState.subtitleFetchState).toBe("idle");
  });
});
