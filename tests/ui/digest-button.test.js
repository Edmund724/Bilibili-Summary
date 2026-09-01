// 统一 Digest 阅读模式 PR1 验收：ui/digest-button.js 注入/降级/自查契约。
//
// 用例走真实模块（不 mock digest-button 的任何依赖），完整锁验收项：
// - 锚点优先级：.video-complaint 左侧 → .video-toolbar-right → 左主区兜底 →
//   播放器浮动降级（holdsVideoDirectly 守卫不挂 video 直接父层）；
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
  const lazy = await import("../../extension/core/lazy-digest-button.js");
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

describe("digest-button 注入锚点优先级", () => {
  it("锚点1：命中 .video-complaint 时按钮落在其左侧", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    const complaint = document.querySelector(".video-complaint");
    const right = document.querySelector(".video-toolbar-right");

    await loadModule();
    await runSettleChain();

    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(right);
    // 紧邻「稿件举报」左侧：后一个兄弟就是 complaint 本尊
    expect(button.nextElementSibling).toBe(complaint);
    // 工具栏位：#fb7299 粉底药丸
    expect(button.style.background).toBe("rgb(251, 114, 153)");
  });

  it("锚点1落空（无 .video-complaint）走锚点2：appendChild 到 .video-toolbar-right", async () => {
    document.body.innerHTML = `${makeToolbarHtml({ withComplaint: false })}<video src="blob:test"></video>`;
    const right = document.querySelector(".video-toolbar-right");

    await loadModule();
    await runSettleChain();

    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(right);
    expect(right.lastElementChild).toBe(button);
  });

  it("锚点1/2落空走锚点3：appendChild 到 #arc_toolbar_report .video-toolbar-left-main", async () => {
    document.body.innerHTML = `
      <div id="arc_toolbar_report">
        <div class="video-toolbar-left"><div class="video-toolbar-left-main"></div></div>
      </div>
      <video src="blob:test"></video>`;

    await loadModule();
    await runSettleChain();

    const leftMain = document.querySelector(".video-toolbar-left-main");
    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    expect(button.parentElement).toBe(leftMain);
    expect(leftMain.lastElementChild).toBe(button);
  });

  it("锚点全落空走浮动降级：挂在播放器容器，top/right 12px", async () => {
    document.body.innerHTML = `
      <div id="bilibili-player">
        <div class="bpx-player-primary-area"><div class="bpx-player-container"></div></div>
      </div>
      <video src="blob:test"></video>`;

    await loadModule();
    await runSettleChain();

    const button = document.getElementById("boc-digest-button");
    expect(button).not.toBeNull();
    const overlay = document.getElementById("boc-digest-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay.parentElement.className).toBe("bpx-player-primary-area");
    expect(overlay.style.position).toBe("absolute");
    expect(overlay.style.top).toBe("12px");
    expect(overlay.style.right).toBe("12px");
  });

  it("holdsVideoDirectly 守卫：<video> 直接父层不挂浮动按钮，落到外层容器", async () => {
    // 首选候选 .bpx-player-primary-area 不直接持 video，应命中它而非 video
    // 的直接父层 .bpx-player-container（那层归播放器管，插节点会推倒重建）。
    document.body.innerHTML = `
      <div id="bilibili-player">
        <div class="bpx-player-primary-area"><div class="bpx-player-container"></div></div>
      </div>`;
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
});
