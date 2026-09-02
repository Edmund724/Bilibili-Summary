// tests/reader/chat-notices.test.ts
// createReaderChatFeedback（对话 tab 消息区通知/错误/建议区清理/近底判定）行为契约。
// PR5 自 tests/sidepanel/sidepanel-notices.test.js 随重建迁移：逻辑断言保真；
// 语义改造——「前往设置」链接在 reader 语境经 deps.onOpenSettings 回调打开
// 侧边栏设置抽屉（digest-only-ui：open-options 消息与独立设置页已删除）。
//
// 覆盖：
// - showConversationContextNotice：追加通知条（textContent，防注入）、重复显示
//   去重（先移除旧条）、autoHideMs > 0 时经注入定时器自动消失、clearTimer 取消；
// - openSettingsAction：附「前往设置」链接，点击触发 onOpenSettings 回调；
// - removeConversationContextNotice：清通知 + 取消挂起定时器；
// - showConversationContextError：空文案 no-op、居中错误块 + scrollToBottom；
// - removeCenteredState / removeSuggestions（同步置空单例钩子）；
// - isMessagesNearBottom：近底/远底判定。
//
// 定时器注入受控 fake（手动推进）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let createReaderChatFeedback;

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  const module = await import("../../extension/reader/chat-notices.js");
  createReaderChatFeedback = module.createReaderChatFeedback;
});

function makeHarness() {
  const messages = document.createElement("div");
  document.body.appendChild(messages);
  const timers = [];
  let timerSeq = 0;
  const deps = {
    messages,
    setTimer: vi.fn((fn, ms) => {
      const handle = { id: ++timerSeq, fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    }),
    clearTimer: vi.fn((handle) => {
      handle.cleared = true;
      const index = timers.indexOf(handle);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    }),
    scrollToBottom: vi.fn(),
    getSuggestionsNode: () => suggestionsNode,
    setSuggestionsNode: (node) => {
      suggestionsNode = node;
    },
    onOpenSettings: vi.fn()
  };
  let suggestionsNode = document.createElement("div");
  const feedback = createReaderChatFeedback(deps);
  const fireTimers = () => {
    [...timers].forEach((timer) => timer.fn());
  };
  return { messages, deps, feedback, timers, fireTimers };
}

describe("showConversationContextNotice / removeConversationContextNotice", () => {
  it("追加通知条到消息区顶部，文本走 textContent（HTML 不被解析）", () => {
    const { messages, feedback } = makeHarness();

    feedback.showConversationContextNotice("<b>加粗</b>", 0);

    const notice = messages.querySelector(".chat-context-notice");
    expect(notice).not.toBeNull();
    expect(notice.textContent).toBe("<b>加粗</b>");
    expect(notice.querySelector("b")).toBeNull();
  });

  it("重复显示去重：旧通知条先移除", () => {
    const { messages, feedback } = makeHarness();

    feedback.showConversationContextNotice("第一条", 0);
    feedback.showConversationContextNotice("第二条", 0);

    const notices = messages.querySelectorAll(".chat-context-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toBe("第二条");
  });

  it("autoHideMs > 0：挂自动消失定时器，触发后通知条移除", () => {
    const { messages, feedback, timers, deps, fireTimers } = makeHarness();

    feedback.showConversationContextNotice("会自动消失", 4000);

    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(4000);

    fireTimers();
    // 与生产 window.setTimeout 行为一致：回调里的 remove 会 clearTimeout 一次
    // 过期句柄（无害），随后 timer 归零
    expect(deps.clearTimer).toHaveBeenCalledTimes(1);
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
    expect(timers).toHaveLength(0);
  });

  it("autoHideMs 之前手动 remove：挂起定时器被取消", () => {
    const { messages, feedback, timers, deps } = makeHarness();

    feedback.showConversationContextNotice("先手动移除", 4000);
    feedback.removeConversationContextNotice();

    expect(deps.clearTimer).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
  });

  it("openSettingsAction：附「前往设置」链接，点击触发 onOpenSettings 回调", () => {
    const { feedback, messages, deps } = makeHarness();

    feedback.showConversationContextNotice("需要配置", 0, { openSettingsAction: true });

    const link = messages.querySelector(".chat-context-notice a");
    expect(link).not.toBeNull();
    expect(link.textContent).toBe("前往设置");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(deps.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe("showConversationContextError / removeCenteredState", () => {
  it("空文案 no-op：不追加节点也不滚动", () => {
    const { messages, feedback, deps } = makeHarness();

    feedback.showConversationContextError("   ");

    expect(messages.children).toHaveLength(0);
    expect(deps.scrollToBottom).not.toHaveBeenCalled();
  });

  it("追加居中错误块并滚动到底；先清既有通知条与居中块", () => {
    const { messages, feedback, deps } = makeHarness();
    feedback.showConversationContextNotice("旧通知", 0);

    feedback.showConversationContextError("读取失败");

    expect(messages.querySelectorAll(".chat-context-notice")).toHaveLength(0);
    const error = messages.querySelector(".chat-center-error");
    expect(error.textContent).toBe("读取失败");
    expect(deps.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("removeCenteredState 只清居中块", () => {
    const { messages, feedback } = makeHarness();
    feedback.showConversationContextError("错误一");

    feedback.removeCenteredState();

    expect(messages.querySelectorAll(".chat-center-error")).toHaveLength(0);
  });
});

describe("removeSuggestions / isMessagesNearBottom", () => {
  it("removeSuggestions：移除节点并把单例钩子置空", () => {
    const { deps, feedback } = makeHarness();

    feedback.removeSuggestions();

    expect(deps.getSuggestionsNode()).toBeNull();
  });

  it("isMessagesNearBottom：距底 <= 阈值（默认 56）为近底", () => {
    const { messages, feedback } = makeHarness();
    let scrollTopValue = 0;
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value) => {
        scrollTopValue = value;
      }
    });
    Object.defineProperty(messages, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(messages, "clientHeight", { value: 900, configurable: true });

    // 1000 - (0 + 900) = 100 > 56 → 远底；滚到底部 → 近底
    expect(feedback.isMessagesNearBottom()).toBe(false);
    messages.scrollTop = 950;
    expect(feedback.isMessagesNearBottom()).toBe(true);
  });
});
