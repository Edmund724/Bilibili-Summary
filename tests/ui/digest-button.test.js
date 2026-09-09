// Digest 工具栏按钮注入/降级/自查契约（工单 button-injection-stability/02
// 锚点层级收拢后）。
//
// 用例走真实模块（不 mock digest-button 的任何依赖），完整锁验收项：
// - 锚点层级收拢：只剩两级——①「稿件举报」左侧（多信号判定：类名 + 语义文本，
//   双信号优先）→ ④播放器浮动降级；②（.video-toolbar-right 尾部）与③（旧版
//   .video-toolbar-left-main）已退役，①落空时它们在场也不得收留按钮；
// - 短暂失配宽限：命中过①的页面，①失配后宽限 2 拍（~1.6s）不降级、已挂载
//   按钮不动（挡掉 B 站重渲染间隙的闪漂），宽限耗尽才降④；期间①恢复则原地
//   留守；降④后①恢复则升回①位；
// - 幂等（重复注入不重复插按钮）；
// - 非 /video/ 页自查主动移除按钮、回到 /video/ 页补回。
//
// 定时器全文件 fake：模块生命周期含 1200ms settle 与 800ms 自查 interval，
// 真实时钟下用例间残留 interval 会在下一用例的时间窗开火（与
// player-ai-guard.test.js 同一环境问题），fake 后未触发的回调随 afterEach 的
// useRealTimers 一并丢弃。点击消息路径断言拆到 digest-button-click.test.js
// （那边要 vi.mock 重依赖，独立模块纪元避免污染本文件的真实模块用例）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";

async function loadModule() {
  const lazy = await import("../../extension/ui/lazy-digest-button.js");
  return lazy.loadDigestButton();
}

function makeToolbarHtml({ withComplaint = true } = {}) {
  const complaint = withComplaint
    ? '<div class="video-complaint"><span>稿件举报</span></div>'
    : "";
  return `
    <div id="arc_toolbar_report">
      <div class="video-toolbar-left"><div class="video-toolbar-left-main"></div></div>
      <div class="video-toolbar-right">${complaint}<div class="video-note"></div></div>
    </div>`;
}

function makePlayerHtml() {
  return `
    <div id="bilibili-player">
      <div class="bpx-player-primary-area"><div class="bpx-player-container"></div></div>
    </div>`;
}

beforeEach(() => {
  resetModuleState();
  // resetModuleState 内部的 useRealTimers 复位后，本文件统一挂 fake 时钟
  vi.useFakeTimers();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// 模块求值即启动生命周期：settle 链（readyState complete → video 已挂 →
// 1200ms 余量）跑完后执行首轮注入，再挂 800ms 自查 interval。
async function runSettleChain() {
  await vi.advanceTimersByTimeAsync(1300);
}

describe("digest-button 注入锚点层级（02 收拢：①→④）", () => {
  it("锚点①：命中「稿件举报」时按钮落在其左侧", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint");

    await loadModule();
    await runSettleChain();

    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    // 紧邻「稿件举报」左侧：后一个兄弟就是 complaint 本尊
    expect(button.nextElementSibling).toBe(complaint);
    // 工具栏位：#fb7299 粉底药丸
    expect(button.style.background).toBe("rgb(251, 114, 153)");
  });

  it("锚点①：complaint 不在 #arc_toolbar_report 宿主内（稍后再看页形态）仍按多信号命中", async () => {
    // 稍后再看等列表播放页的工具栏没有 #arc_toolbar_report 这层 id 宿主，
    // 多信号判定必须兜底命中，否则按钮落到播放器浮动层。
    document.body.innerHTML = `
      <div class="video-toolbar-container">
        <div class="video-toolbar-right">
          <div class="video-complaint video-toolbar-right-item"><span>稿件举报</span></div>
          <div class="video-note"></div>
        </div>
      </div>
      <video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint");

    await loadModule();
    await runSettleChain();

    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("锚点①多信号：类名改版但语义文本在场（aria-label）仍命中", async () => {
    // B 站改版常只动其一：类名换成哈希/新词时，aria-label 或文本信号兜底。
    document.body.innerHTML = `
      <div id="arc_toolbar_report">
        <div class="video-toolbar-right">
          <div class="toolbar-item-x8h2" aria-label="稿件举报"><span>举报</span></div>
          <div class="video-note"></div>
        </div>
      </div>
      <video src="blob:test"></video>`;
    const complaint = document.querySelector('[aria-label="稿件举报"]');

    await loadModule();
    await runSettleChain();

    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("锚点①多信号：文本改版但类名信号在场仍命中", async () => {
    // 反向：类名 video-complaint 保留、可见文本/属性被改掉（如改成 icon-only
    // 无文字），类名单信号也要能命中。
    document.body.innerHTML = `
      <div id="arc_toolbar_report">
        <div class="video-toolbar-right">
          <div class="video-complaint"><svg></svg></div>
          <div class="video-note"></div>
        </div>
      </div>
      <video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint");

    await loadModule();
    await runSettleChain();

    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    expect(button.nextElementSibling).toBe(complaint);
  });

  it("锚点①落空直达④：②③在场也不得收留，按钮挂播放器浮动层", async () => {
    // 02 层级收拢：.video-toolbar-right（旧②）与 .video-toolbar-left-main
    //（旧③）在 DOM 里存在也不能当锚点——它们正是「漂到视频下方最右」的
    // 事故现场，①失配一律落④浮动层（位置自控，语义安全）。
    document.body.innerHTML = `${makeToolbarHtml({ withComplaint: false })}${makePlayerHtml()}<video src="blob:test"></video>`;
    const right = document.querySelector(".video-toolbar-right");
    const leftMain = document.querySelector(".video-toolbar-left-main");

    await loadModule();
    await runSettleChain();

    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    expect(right.contains(button)).toBe(false);
    expect(leftMain.contains(button)).toBe(false);
    const overlay = document.getElementById("boc-digest-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay.contains(button)).toBe(true);
    expect(overlay.style.position).toBe("absolute");
    expect(overlay.style.top).toBe("12px");
    expect(overlay.style.right).toBe("12px");
  });

  it("holdsVideoDirectly 守卫：<video> 直接父层不挂浮动按钮，落到外层容器", async () => {
    // 首选候选 .bpx-player-primary-area 不直接持 video，应命中它而非 video
    // 的直接父层 .bpx-player-container（那层归播放器管，插节点会推倒重建）。
    document.body.innerHTML = makePlayerHtml();
    document
      .querySelector(".bpx-player-container")
      .appendChild(Object.assign(document.createElement("video"), { src: "blob:test" }));

    await loadModule();
    await runSettleChain();

    const overlay = document.getElementById("boc-digest-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay.parentElement.className).toBe("bpx-player-primary-area");
  });

  it("浮动宿主候选全落空：不挂按钮也不报错", async () => {
    document.body.innerHTML = "<video></video>";

    await loadModule();
    await runSettleChain();

    expect(document.getElementById("boc-digest-button")).toBeNull();
    expect(document.getElementById("boc-digest-overlay")).toBeNull();
  });
});

describe("digest-button 失配宽限与升降级（02）", () => {
  it("①命中后 complaint 被重渲染摘走：宽限期内按钮留守原位，宽限耗尽降④", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    document.body.innerHTML = `${makeToolbarHtml()}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();
    await runSettleChain();
    const right = document.querySelector(".video-toolbar-right");
    let button = document.getElementById("boc-digest-button");
    expect(button.parentElement).toBe(right);

    // B 站重渲染：举报节点（连带按钮）被换掉
    button.remove();
    document.querySelector(".video-complaint").remove();

    // 第 1 拍：失配进入宽限，不降级
    await vi.advanceTimersByTimeAsync(801);
    expect(document.getElementById("boc-digest-overlay")).toBeNull();
    // 第 2 拍：宽限中，仍不降级
    await vi.advanceTimersByTimeAsync(801);
    expect(document.getElementById("boc-digest-overlay")).toBeNull();
    // 第 3 拍：宽限耗尽，降级④浮动层
    await vi.advanceTimersByTimeAsync(801);
    const overlay = document.getElementById("boc-digest-overlay");
    expect(overlay).not.toBeNull();
    button = document.getElementById("boc-digest-button");
    expect(overlay.contains(button)).toBe(true);
    expect(right.contains(button)).toBe(false);
    // 可观测：降级事件有 console 日志
    expect(infoSpy.mock.calls.some((args) => args.join(" ").includes("digest"))).toBe(true);
  });

  it("宽限期内 complaint 恢复：按钮留在工具栏①位，不降级", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();
    await runSettleChain();

    // 重渲染：举报节点短暂消失一拍后回来（Vue 重渲染换新节点）
    document.getElementById("boc-digest-button").remove();
    document.querySelector(".video-complaint").remove();
    await vi.advanceTimersByTimeAsync(801);
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    const right = document.querySelector(".video-toolbar-right");
    right.insertBefore(complaint, right.firstElementChild);

    await vi.advanceTimersByTimeAsync(801);

    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
    expect(document.getElementById("boc-digest-overlay")).toBeNull();
  });

  it("降④后 complaint 恢复：按钮从浮动层升回①位", async () => {
    document.body.innerHTML = `${makeToolbarHtml({ withComplaint: false })}${makePlayerHtml()}<video src="blob:test"></video>`;

    await loadModule();
    await runSettleChain();
    // 首载①未就绪 → 已在④
    let button = document.getElementById("boc-digest-button");
    expect(document.getElementById("boc-digest-overlay").contains(button)).toBe(true);

    // 工具栏渲染完成，举报节点出现 → 下一自查拍升回①
    const right = document.querySelector(".video-toolbar-right");
    const complaint = document.createElement("div");
    complaint.className = "video-complaint";
    complaint.textContent = "稿件举报";
    right.insertBefore(complaint, right.firstElementChild);
    await vi.advanceTimersByTimeAsync(801);

    button = document.getElementById("boc-digest-button");
    expect(button.parentElement).toBe(right);
    expect(button.nextElementSibling).toBe(complaint);
    expect(button.style.background).toBe("rgb(251, 114, 153)");
  });
});

describe("digest-button 幂等与自查", () => {
  it("幂等：重复注入不重复插按钮", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint");

    const { injectDigestButton } = await loadModule();
    await runSettleChain();

    injectDigestButton();
    injectDigestButton();
    await runSettleChain();

    expect(document.querySelectorAll("#boc-digest-button").length).toBe(1);
    expect(complaint.previousElementSibling.id).toBe("boc-digest-button");
  });

  it("自查周期：非 /video/ 页主动移除按钮；回到 /video/ 页补回", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    await loadModule();
    await runSettleChain();
    expect(document.getElementById("boc-digest-button")).not.toBeNull();

    // SPA 换到非 /video/ 页：下一个自查周期摘除按钮
    setLocationUrl("https://www.bilibili.com/");
    await vi.advanceTimersByTimeAsync(801);
    expect(document.getElementById("boc-digest-button")).toBeNull();
    expect(document.getElementById("boc-digest-overlay")).toBeNull();

    // 换回播放页：按钮补回（幂等注入）
    setLocationUrl(NORMAL_PAGE_URL);
    await vi.advanceTimersByTimeAsync(801);
    expect(document.getElementById("boc-digest-button")).not.toBeNull();
  });

  it("自查周期：稍后再看页（/list/watchlater?bvid=）是视频播放页，不摘按钮", async () => {
    // 与 content.ts isSupportedUrl 口径一致：watchlater 由 isWatchlaterPage
    // 覆盖。自查若只认 /video/  pathname，按钮会在装载后一个周期被摘掉
    //（用户症状：刚进页看得到，一两秒后消失）。
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    setLocationUrl("https://www.bilibili.com/list/watchlater?bvid=BV1test000000");

    await loadModule();
    await runSettleChain();
    expect(document.getElementById("boc-digest-button")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(801);
    expect(document.getElementById("boc-digest-button")).not.toBeNull();
  });
});
