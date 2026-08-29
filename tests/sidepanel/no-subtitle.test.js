// sidepanel-no-subtitle.js 纯模块测试：无字幕拦截的判定与按原因文案。
// 锁定三件事：
//   - isNoSubtitleEmptyContext：仅「empty 且字幕体为空」拦截（与
//     isContextPending 的 loading 等待语义互补）；字幕体非空一律放行。
//   - buildNoSubtitleNotice：五类原因（no-asr-config / asr-disabled /
//     asr-failed / asr-empty / 缺失未知）的提示文案与「前往设置」动作位。
//     no-asr-config 文案必须体现"自己申请 Key 并填入设置页"，不能是"开启即可"。
//   - NO_SUBTITLE_SEND_BLOCKED：ensureCurrentContextForSend 的类型化拦截信号
//     （chat-runtime 以 !== true 判定提前返回）。

import { describe, expect, it } from "vitest";
import {
  NO_SUBTITLE_SEND_BLOCKED,
  buildNoSubtitleNotice,
  isNoSubtitleEmptyContext
} from "../../extension/pages/sidepanel-no-subtitle.js";

describe("NO_SUBTITLE_SEND_BLOCKED", () => {
  it("类型化拦截信号：真值但严格不等 true（chat-runtime 以 !== true 放行）", () => {
    expect(NO_SUBTITLE_SEND_BLOCKED).toBeTruthy();
    expect(NO_SUBTITLE_SEND_BLOCKED).not.toBe(true);
  });
});

describe("isNoSubtitleEmptyContext", () => {
  it("empty 且字幕体为空：拦截", () => {
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "empty", subtitleBody: [] })).toBe(true);
  });

  it("字幕体非空：一律放行（就绪优先于状态字段）", () => {
    expect(
      isNoSubtitleEmptyContext({
        subtitleFetchState: "empty",
        subtitleBody: [{ from: 0, to: 1, content: "x" }]
      })
    ).toBe(false);
    expect(
      isNoSubtitleEmptyContext({
        subtitleFetchState: "ready",
        subtitleBody: [{ from: 0, to: 1, content: "x" }]
      })
    ).toBe(false);
  });

  it("非 empty 状态不受影响（loading/idle/error/ready 均不拦截）", () => {
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "loading", subtitleBody: [] })).toBe(false);
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "idle", subtitleBody: [] })).toBe(false);
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "error", subtitleBody: [] })).toBe(false);
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "ready", subtitleBody: [] })).toBe(false);
  });

  it("快照缺失或字幕体字段异常：不拦截（读取失败走既有 false 路径）", () => {
    expect(isNoSubtitleEmptyContext(null)).toBe(false);
    expect(isNoSubtitleEmptyContext(undefined)).toBe(false);
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "empty" })).toBe(true); // 非数组 body 折算为空
    expect(isNoSubtitleEmptyContext({ subtitleFetchState: "empty", subtitleBody: "x" })).toBe(true);
  });
});

describe("buildNoSubtitleNotice", () => {
  it("no-asr-config：引导自行申请硅基流动 API Key 并填入设置页 + 前往设置链接", () => {
    const notice = buildNoSubtitleNotice("no-asr-config");
    expect(notice.message).toBe(
      "当前视频没有字幕，无法总结。可到硅基流动官网免费申请 API Key，填入扩展设置页后即可自动转写生成字幕。"
    );
    expect(notice.openSettings).toBe(true);
  });

  it("asr-disabled：引导到设置页开启无字幕自动转写 + 前往设置链接", () => {
    const notice = buildNoSubtitleNotice("asr-disabled");
    expect(notice.message).toBe(
      "当前视频没有字幕，且语音转写开关已关闭。可在设置页开启「无字幕时自动生成字幕」后再试。"
    );
    expect(notice.openSettings).toBe(true);
  });

  it("asr-failed：语音识别未成功，建议重新抓取或稍后再试，无设置链接", () => {
    const notice = buildNoSubtitleNotice("asr-failed");
    expect(notice.message).toBe(
      "当前视频没有字幕，语音识别未成功，暂时无法总结。可重新抓取或稍后再试。"
    );
    expect(notice.openSettings).toBe(false);
  });

  it("asr-empty：未识别到语音内容，无设置链接", () => {
    const notice = buildNoSubtitleNotice("asr-empty");
    expect(notice.message).toBe("这个视频没有识别到语音内容，无法总结。");
    expect(notice.openSettings).toBe(false);
  });

  it("reason 缺失/未知：通用文案，无设置链接", () => {
    expect(buildNoSubtitleNotice(null)).toEqual({
      message: "当前视频没有字幕，无法总结。",
      openSettings: false
    });
    expect(buildNoSubtitleNotice(undefined)).toEqual({
      message: "当前视频没有字幕，无法总结。",
      openSettings: false
    });
    expect(buildNoSubtitleNotice("something-else")).toEqual({
      message: "当前视频没有字幕，无法总结。",
      openSettings: false
    });
  });
});
