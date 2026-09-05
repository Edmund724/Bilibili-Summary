// timestamp-nav 对话时间戳跳转测试（arch-slim-2/08）：
// parseTimestampToSeconds 已归一到 shared/clock-text.ts 的 parseClock（容错单源），
// 哨兵语义保留在本模块——解不出返回 0（与章节目录的 -1 哨兵不同）。本文件断言
// 两条哨兵/容错路径的端到端行为：非法时刻「99:99」按 0 秒跳转（原实现会换算成
// 6039 秒，归一后拒绝），合法「1:02」按 62 秒跳转。

import { describe, expect, it, vi, afterEach } from "vitest";
import { linkifyAssistantTimestamps } from "../../extension/ui/timestamp-nav.js";
import { TIMESTAMP_PATTERN } from "../../extension/ui/markdown.js";

function makeDeps() {
  return {
    contextUrl: "https://www.bilibili.com/video/BV1test000000/",
    getActiveTab: vi.fn(async () => ({ id: 1, url: "https://www.bilibili.com/video/BV1test000000/" })),
    matchContextUrl: vi.fn(() => true),
    sendMessageToActiveTab: vi.fn(async () => ({ ok: true })),
    notice: vi.fn()
  };
}

function linkifyAndClick(text: string): void {
  const container = document.createElement("div");
  container.textContent = text;
  document.body.append(container);
  linkifyAssistantTimestamps(container, makeDeps());
  const button = container.querySelector<HTMLButtonElement>(".chat-timestamp-link");
  if (!button) {
    throw new Error(`未生成时间戳按钮：${text}`);
  }
  button.click();
  container.remove();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("对话时间戳跳转（parseClock 归一 + nav 哨兵 0）", () => {
  it("非法时刻 99:99：按哨兵 0 跳转（严口径拒绝，不再换算成非法秒数）", async () => {
    const deps = makeDeps();
    const container = document.createElement("div");
    container.textContent = "99:99 这里";
    document.body.append(container);
    linkifyAssistantTimestamps(container, deps);
    const button = container.querySelector<HTMLButtonElement>(".chat-timestamp-link");
    expect(button).not.toBeNull();
    button!.click();
    container.remove();

    await vi.waitFor(() => expect(deps.sendMessageToActiveTab).toHaveBeenCalledTimes(1));
    expect(deps.sendMessageToActiveTab).toHaveBeenCalledWith(1, {
      type: "reader-seek-video-time",
      seconds: 0
    });
  });

  it("合法时刻 1:02：按 62 秒跳转", async () => {
    const deps = makeDeps();
    const container = document.createElement("div");
    container.textContent = "1:02 这里";
    document.body.append(container);
    linkifyAssistantTimestamps(container, deps);
    const button = container.querySelector<HTMLButtonElement>(".chat-timestamp-link");
    expect(button).not.toBeNull();
    button!.click();
    container.remove();

    await vi.waitFor(() => expect(deps.sendMessageToActiveTab).toHaveBeenCalledTimes(1));
    expect(deps.sendMessageToActiveTab).toHaveBeenCalledWith(1, {
      type: "reader-seek-video-time",
      seconds: 62
    });
  });

  it("reader 伪 tab（id: 0）：点击后按进程内 seek 消费，不误报「找不到当前标签页」", async () => {
    // reader/chat-tab.ts 的 getTimestampNavDeps 注入恒定伪 tab { id: 0, ... }
    //（content script 无 chrome.tabs 消息链，seek 走进程内直调），守卫不得把
    // id 0 当作「没有标签页」。
    const deps = { ...makeDeps(), getActiveTab: vi.fn(async () => ({ id: 0, url: "https://www.bilibili.com/video/BV1test000000/" })) };
    const container = document.createElement("div");
    container.textContent = "1:02 这里";
    document.body.append(container);
    linkifyAssistantTimestamps(container, deps);
    const button = container.querySelector<HTMLButtonElement>(".chat-timestamp-link");
    expect(button).not.toBeNull();
    button!.click();
    container.remove();

    await vi.waitFor(() => expect(deps.sendMessageToActiveTab).toHaveBeenCalledTimes(1));
    expect(deps.sendMessageToActiveTab).toHaveBeenCalledWith(0, {
      type: "reader-seek-video-time",
      seconds: 62
    });
    expect(deps.notice).not.toHaveBeenCalledWith("找不到当前标签页。", 2200);
  });

  it("TIMESTAMP_PATTERN 上游约束不变（正则单源 ui/markdown.ts）", () => {
    TIMESTAMP_PATTERN.lastIndex = 0;
    expect(TIMESTAMP_PATTERN.test("99:99")).toBe(true);
    TIMESTAMP_PATTERN.lastIndex = 0;
    expect(TIMESTAMP_PATTERN.test("12:34:56")).toBe(true);
  });
});
