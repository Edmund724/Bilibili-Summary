// sidepanel-chat-runtime 协议级测试（候选07：接口面收窄后全量重写）：
// 全部经 sendMessage + 假 port（或公开的 handleChatPortMessage 协议入口）喂
// offscreen port 消息（reasoning / token / stream-reset / done / stopped /
// error / notice / cost-guard），断言面向可观察结果（DOM / sidepanelState /
// deps 回调 / port 行为），不直接调用任何内部渲染步骤函数。
//
// 注意：chat-runtime 直接读写 sidepanelState（./sidepanel-state.js）。测试在
// beforeEach 里 resetModules 后把两个模块放进同一模块纪元导入（跨纪元会拿到
// 两个不同的 state 单例），并在每个用例前手动重置会用到的字段。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import { renderMarkdown } from "../../extension/ui/markdown.js";

let createChatRuntime;
let sidepanelState;

const SLOW_NOTICE_TEXT = "模型响应较慢，可能正在思考，请稍候…";
const THINKING_TRUNCATION_SUFFIX = "\n…（思考内容过长，已截断显示）";

function makePort() {
  const listeners = { message: [], disconnect: [] };
  return {
    port: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    listeners
  };
}

function makeDeps() {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  const ports = [];
  return {
    messages,
    input,
    ports,
    stopBtn: null,
    store: {
      persistCurrent: vi.fn(async () => {}),
      // 会话身份守卫的单一判定点在 store；mock 与真实现同语义（严格相等，
      // 含空 id == 空当前 id → true 的新会话首发场景）
      isCurrent: vi.fn((id) => id === sidepanelState.currentConversationId)
    },
    ui: {
      setStreamingUiState: vi.fn(),
      showConversationContextNotice: vi.fn(),
      removeConversationContextNotice: vi.fn(),
      hidePresetPopover: vi.fn(),
      hideHistoryPopover: vi.fn(),
      removeCenteredState: vi.fn(),
      removeSuggestions: vi.fn(),
      resetConversationView: vi.fn(),
      autosizeInput: vi.fn()
    },
    ensureCurrentContextForSend: vi.fn(async () => true),
    getProviderId: () => "test-provider",
    getTimestampNavDeps: () => ({}),
    normalizeMarkdownForSectionPaste,
    connectPort: vi.fn(async () => {
      const session = makePort();
      ports.push(session);
      return session.port;
    })
  };
}

// 建运行时并完成一次发送（流已建立、首个协议消息未到）
async function makeRuntime(text = "帮我写个标题") {
  const deps = makeDeps();
  deps.input.value = text;
  const runtime = createChatRuntime(deps);
  await runtime.sendMessage();
  return { deps, runtime, session: deps.ports[0] };
}

// 协议入口喂消息（与 sendMessage 内注册的 port.onMessage 监听器同一分派）
function feed(runtime, msg) {
  runtime.handleChatPortMessage(msg);
}

// 拦截 rAF：注册回调但不自动执行，由用例手动驱动每帧 flush
function holdRaf() {
  return vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
}

function assistantNode(deps) {
  return deps.messages.querySelector(".sp-msg-assistant");
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  // 同一模块纪元内新鲜导入（先 resetModules 再 import，两个模块同图解析）：
  ({ createChatRuntime } = await import("../../extension/pages/sidepanel-chat-runtime.js"));
  ({ sidepanelState } = await import("../../extension/pages/sidepanel-state.js"));
  // sidepanelState 是模块级单例，手动重置本文件用到的字段
  sidepanelState.contextData = null;
  sidepanelState.currentContextKey = "";
  sidepanelState.chatHistory = [];
  sidepanelState.currentConversationId = "";
  sidepanelState.currentConversationMeta = null;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ==========================================================================
// sendMessage 建流与协议入口
// ==========================================================================
describe("sendMessage 建流与协议入口", () => {
  it("发送后：chat 消息发起，助手占位（含光标）先于首个 token 建立，进入流式 UI", async () => {
    const { deps, runtime, session } = await makeRuntime("总结一下这个视频");

    // chat 负载已发给 offscreen
    expect(session.port.postMessage).toHaveBeenCalledTimes(1);
    const chatMsg = session.port.postMessage.mock.calls[0][0];
    expect(chatMsg.action).toBe("chat");
    expect(chatMsg.prompt).toBe("总结一下这个视频");

    // 用户消息上屏、输入框清空
    expect(deps.messages.querySelector(".sp-msg-user")?.textContent).toBe("总结一下这个视频");
    expect(deps.input.value).toBe("");

    // 首 token 前占位已存在：光标 span 在、流式双容器尚未创建
    const node = assistantNode(deps);
    expect(node).toBeTruthy();
    expect(node.querySelector(".sp-msg-cursor")).toBeTruthy();
    expect(node.querySelector(".sp-stream-stable")).toBeNull();
    expect(node.querySelector(".sp-stream-tail")).toBeNull();

    // 流式状态：port 已连、UI 已进入流式、尚无写回
    expect(runtime.isStreaming()).toBe(true);
    expect(deps.ui.setStreamingUiState).toHaveBeenCalledWith(true, expect.anything());
    expect(sidepanelState.chatHistory).toEqual([]);
  });

  it("假 port 的 onMessage 监听器与 handleChatPortMessage 走同一协议分派（wiring）", async () => {
    const { deps, runtime, session } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    // 经真实 port 监听器喂 token：渲染生效
    session.listeners.message[0]({ type: "token", data: "**第一帧**" });
    raf.mock.calls[0][0]();
    expect(deps.messages.querySelector("strong")?.textContent).toBe("第一帧");

    // 经协议入口喂 token：写入同一条流（累加后整段重渲染进末块容器）
    feed(runtime, { type: "token", data: " 与第二帧" });
    raf.mock.calls[1][0]();
    const tail = node.querySelector(".sp-stream-tail");
    expect(tail.textContent).toContain("第一帧");
    expect(tail.textContent).toContain("第二帧");
  });

  it("流式中重复 sendMessage 被拒（activePort 占用）：不发起第二条 port、不清输入", async () => {
    const { deps, runtime } = await makeRuntime("第一条");

    deps.input.value = "第二条";
    await runtime.sendMessage();

    expect(deps.ports).toHaveLength(1);
    expect(deps.messages.querySelectorAll(".sp-msg-user")).toHaveLength(1);
    expect(deps.input.value).toBe("第二条");
  });
});

// ==========================================================================
// token 流式渲染（协议驱动）
// ==========================================================================
describe("token 流式渲染（协议驱动）", () => {
  it("流式期间按帧渲染 markdown 结构并保留光标（stable/tail 双容器）", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    // 第一帧：标题 + 列表项
    feed(runtime, { type: "token", data: "# 标题\n- 第一项\n" });
    expect(raf).toHaveBeenCalledTimes(1);
    raf.mock.calls[0][0]();
    expect(node.querySelector("h3")).toBeTruthy();
    expect(node.querySelector("li")).toBeTruthy();
    expect(node.querySelector(".sp-msg-cursor")).toBeTruthy();

    // 第二帧：追加列表项 + 代码块
    feed(runtime, { type: "token", data: "- 第二项\n```js\nconst a = 1;\n```\n" });
    raf.mock.calls[1][0]();
    expect(node.querySelectorAll("li")).toHaveLength(2);
    expect(node.querySelector("pre code")).toBeTruthy();
    expect(node.querySelector(".sp-msg-cursor")).toBeTruthy();

    // 第三帧：追加段落
    feed(runtime, { type: "token", data: "结尾段落\n" });
    raf.mock.calls[2][0]();
    expect(node.querySelectorAll("li")).toHaveLength(2);
    expect(node.querySelector("p")).toBeTruthy();

    // 光标始终接在末块容器（sp-stream-tail）尾部、渲染内容之后
    const tailEl = node.querySelector(".sp-stream-tail");
    expect(tailEl.lastElementChild.className).toBe("sp-msg-cursor");
  });

  it("稳定前缀 + 末块增量渲染：stable 只在增长时重渲染，done 后与全量渲染一致", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    // 帧 1：两个段落 → stable = 第一段（空行边界），tail = 末段 + 光标
    feed(runtime, { type: "token", data: "第一段\n\n第二段开头" });
    raf.mock.calls[0][0]();
    const stableEl = node.querySelector(".sp-stream-stable");
    const tailEl = node.querySelector(".sp-stream-tail");
    expect(stableEl.innerHTML).toBe(renderMarkdown("第一段"));
    expect(tailEl.querySelector("p").textContent).toBe("第二段开头");
    expect(tailEl.lastElementChild.className).toBe("sp-msg-cursor");

    // 篡改 stable 内容，用于探测后续帧是否重渲染了 stable
    stableEl.innerHTML = "SENTINEL";

    // 帧 2：tail 增长（无新空行边界）→ stable 不重渲染，tail 每帧更新
    feed(runtime, { type: "token", data: "，仍在增长" });
    raf.mock.calls[1][0]();
    expect(stableEl.innerHTML).toBe("SENTINEL");
    expect(tailEl.querySelector("p").textContent).toBe("第二段开头，仍在增长");
    expect(tailEl.lastElementChild.className).toBe("sp-msg-cursor");

    // 帧 3：新空行边界出现 → stable 增长并重渲染一次
    feed(runtime, { type: "token", data: "\n\n第三段" });
    raf.mock.calls[2][0]();
    expect(stableEl.innerHTML).toBe(renderMarkdown("第一段\n\n第二段开头，仍在增长"));
    expect(tailEl.querySelector("p").textContent).toBe("第三段");

    // done：流式双容器被整体替换，最终 DOM 与 renderMarkdown(全文) 一致
    const fullText = "第一段\n\n第二段开头，仍在增长\n\n第三段";
    feed(runtime, { type: "done" });
    expect(node.querySelector(".sp-stream-stable")).toBeNull();
    expect(node.querySelector(".sp-stream-tail")).toBeNull();
    expect(node.querySelector(".sp-msg-assistant-body").innerHTML).toBe(renderMarkdown(fullText));
  });

  it("done 收尾：未 flush 的 pending 一并入全量文本；写回并持久化；断开 port 退出流式 UI", async () => {
    const { deps, runtime, session } = await makeRuntime("帮我写个标题");
    const node = assistantNode(deps);
    const focusSpy = vi.spyOn(deps.input, "focus");
    const raf = holdRaf();

    const tokens = ["# 标题\n\n", "第一段**加粗**", "\n\n- 项目一\n", "- 项目二\n", "结尾文本"];
    const fullText = tokens.join("");

    // 第一批 token → flush #1
    feed(runtime, { type: "token", data: tokens[0] });
    feed(runtime, { type: "token", data: tokens[1] });
    raf.mock.calls[0][0]();
    expect(node.querySelector("h3")).toBeTruthy();

    // 第二批 token → flush #2
    feed(runtime, { type: "token", data: tokens[2] });
    raf.mock.calls[1][0]();
    expect(node.querySelectorAll("li")).toHaveLength(1);

    // 第三批 token：只入缓冲、flush 已调度但未执行（尚未渲染）
    feed(runtime, { type: "token", data: tokens[3] });
    feed(runtime, { type: "token", data: tokens[4] });
    expect(node.querySelectorAll("li")).toHaveLength(1);

    // done：取消待执行 flush，全量文本 = 已 flush + 未 flush 缓冲
    feed(runtime, { type: "done" });

    expect(sidepanelState.chatHistory[0]).toEqual({ role: "user", content: "帮我写个标题" });
    expect(sidepanelState.chatHistory[1]).toEqual({ role: "assistant", content: fullText });
    expect(node.querySelector(".sp-msg-assistant-body").innerHTML).toBe(renderMarkdown(fullText));

    // 生命周期收口副作用：断开 port、退出流式 UI、焦点回输入框
    expect(session.port.disconnect).toHaveBeenCalled();
    expect(runtime.isStreaming()).toBe(false);
    expect(deps.ui.setStreamingUiState).toHaveBeenLastCalledWith(false, expect.anything());
    expect(focusSpy).toHaveBeenCalled();
  });
});

// ==========================================================================
// reasoning / thinking 展示
// ==========================================================================
describe("reasoning / thinking 展示", () => {
  it("reasoning 创建思考节点（思考中…标签）并流式累加；首个 token 渲染时移除", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "先想" });
    const thinking = node.querySelector(".sp-thinking");
    expect(thinking).toBeTruthy();
    expect(thinking.querySelector(".sp-thinking-label")?.textContent).toBe("思考中…");
    expect(thinking.querySelector(".sp-thinking-text")?.textContent).toBe("先想");

    // 后续 reasoning 增量累加到同一节点
    feed(runtime, { type: "reasoning", data: "再想" });
    expect(node.querySelector(".sp-thinking-text")?.textContent).toBe("先想再想");

    // 首个 token 的帧渲染移除思考节点（与流式渲染行为一致）
    feed(runtime, { type: "token", data: "正文" });
    raf.mock.calls[0][0]();
    expect(node.querySelector(".sp-thinking")).toBeNull();
    expect(node.textContent).toContain("正文");
  });

  // 说明：第一条消息在 done 前喂了一个 token——reasoning 后不经 token 直接收尾
  // 的话，跨消息的思考展示存在旧行为疑问（见任务报告，只记录不修）。
  it("reasoning 超 4000 字符：显示为前 4000 字符 + 截断提示（逐字节一致）；跨消息不串内容", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const node1 = assistantNode(deps);
    const raf = holdRaf();

    // 逐块喂入：覆盖 4000 边界落在块中间、恰好 4000（不截断）、超 1 字符（截断）、持续溢出
    const chunks = [
      "a".repeat(1500), // 累计 1500
      "b".repeat(2499), // 累计 3999
      "c",              // 累计 4000：恰好到上限，仍不截断
      "d",              // 累计 4001：截断，多出的 1 字符不进显示
      "e".repeat(2500)  // 累计 6501：头缓冲冻结，只累加溢出
    ];
    let total = "";
    for (const chunk of chunks) {
      feed(runtime, { type: "reasoning", data: chunk });
      total += chunk;
      // 旧逻辑的期望输出：全量累计 > 4000 → 前 4000 字符 + 截断提示；否则全量
      const expected = total.length > 4000 ? total.slice(0, 4000) + THINKING_TRUNCATION_SUFFIX : total;
      expect(node1.querySelector(".sp-thinking-text")?.textContent).toBe(expected);
    }

    // 头缓冲冻结在前 4000 字符，溢出部分不进显示
    expect(node1.querySelector(".sp-thinking-text")?.textContent).toBe(
      "a".repeat(1500) + "b".repeat(2499) + "c" + THINKING_TRUNCATION_SUFFIX
    );

    // 第一条走完（token 使思考节点随首帧渲染移除）
    feed(runtime, { type: "token", data: "第一条回答" });
    raf.mock.calls[0][0]();
    feed(runtime, { type: "done" });

    // 第二条消息：思考累加器全新，不串上一条内容
    deps.input.value = "问题二";
    await runtime.sendMessage();
    const node2 = deps.messages.querySelectorAll(".sp-msg-assistant")[1];
    feed(runtime, { type: "reasoning", data: "第二条思考" });
    expect(node2.querySelector(".sp-thinking-text")?.textContent).toBe("第二条思考");
  });
});

// ==========================================================================
// 终态分派：stopped / error
// ==========================================================================
describe("终态分派：stopped / error", () => {
  it("stopped 有正文：渲染正文 + 停止徽标 + 写回持久化 + 断开 port", async () => {
    const { deps, runtime, session } = await makeRuntime("总结一下");
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "部分回答" });
    raf.mock.calls[0][0]();
    feed(runtime, { type: "stopped", reason: "用户手动停止" });

    expect(node.querySelector(".sp-msg-assistant-body")?.innerHTML).toBe(renderMarkdown("部分回答"));
    expect(node.querySelector(".sp-msg-stopped")?.textContent).toBe("用户手动停止");
    expect(node.querySelector(".sp-stream-stable")).toBeNull();
    expect(sidepanelState.chatHistory).toEqual([
      { role: "user", content: "总结一下" },
      { role: "assistant", content: "部分回答" }
    ]);
    expect(deps.store.persistCurrent).toHaveBeenCalledTimes(1);
    expect(session.port.disconnect).toHaveBeenCalled();
    expect(runtime.isStreaming()).toBe(false);
  });

  it("stopped 无正文：只放停止徽标（默认文案），不写回不持久化", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);

    feed(runtime, { type: "stopped" });

    expect(node.querySelector(".sp-msg-stopped")?.textContent).toBe("已停止生成");
    expect(node.querySelector(".sp-msg-assistant-body")).toBeNull();
    expect(sidepanelState.chatHistory).toEqual([]);
    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
    expect(runtime.isStreaming()).toBe(false);
  });

  it("error：错误占位（错误：xxx），半截正文不写回；断开 port 退出流式 UI", async () => {
    const { deps, runtime, session } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "半截输出" });
    raf.mock.calls[0][0]();
    feed(runtime, { type: "error", error: "网络错误" });

    expect(node.querySelector(".sp-msg-error")?.textContent).toBe("错误：网络错误");
    expect(node.querySelector(".sp-msg-assistant-body")).toBeNull();
    expect(sidepanelState.chatHistory).toEqual([]);
    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
    expect(session.port.disconnect).toHaveBeenCalled();
    expect(runtime.isStreaming()).toBe(false);
  });

  it("error 无 error 字段：默认文案「错误：未知错误」", async () => {
    const { deps, runtime } = await makeRuntime();

    feed(runtime, { type: "error" });

    expect(assistantNode(deps).querySelector(".sp-msg-error")?.textContent).toBe("错误：未知错误");
  });
});

// ==========================================================================
// notice 与 cost-guard 分派（流中非终态：port 不断开、流式状态保持）
// ==========================================================================
describe("notice 与 cost-guard 分派（流中非终态）", () => {
  it("notice：转发上下文 notice 门面（data, 4000），流不终止", async () => {
    const { deps, runtime } = await makeRuntime();

    feed(runtime, { type: "notice", data: "上下文提示" });

    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith("上下文提示", 4000);
    expect(runtime.isStreaming()).toBe(true);
  });

  it("cost-guard：confirm 确认 → 回执 ok:true；取消/缺省文案 → ok:false，流不终止", async () => {
    const { runtime, session } = await makeRuntime();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    // 确认路径：文案取 msg.data.message
    feed(runtime, { type: "cost-guard", data: { message: "预计 3 次调用" } });
    expect(confirmSpy).toHaveBeenCalledWith("预计 3 次调用");
    expect(session.port.postMessage).toHaveBeenCalledWith({ action: "cost-guard-confirm", ok: true });

    // 取消路径：data 缺省时用兜底文案
    confirmSpy.mockReturnValue(false);
    feed(runtime, { type: "cost-guard" });
    expect(confirmSpy).toHaveBeenLastCalledWith("预计会有多次调用，是否继续？");
    expect(session.port.postMessage).toHaveBeenLastCalledWith({ action: "cost-guard-confirm", ok: false });

    expect(runtime.isStreaming()).toBe(true);
  });
});

// ==========================================================================
// stream-reset 代际重放（读流中断重试：整体重放）
// ==========================================================================
describe("stream-reset 代际重放（读流中断重试：整体重放）", () => {
  it("收到 stream-reset → 清空已渲染内容与累加器；第二代流从头渲染，finalize 不含第一代残留", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    // 第一代流：渲染出一部分内容（flush 落进 stable/tail 与累加器 base）
    feed(runtime, { type: "token", data: "# 第一代开头\n\n第一代正文" });
    raf.mock.calls[0][0]();
    expect(node.querySelector(".sp-stream-stable")).toBeTruthy();
    expect(node.querySelector("h3")?.textContent).toContain("第一代");

    // 读流中断重试：offscreen 发代际重置信号
    feed(runtime, { type: "stream-reset" });

    // 已渲染容器全部清掉，光标保留在节点末尾（下一帧 flush 重新接上）
    expect(node.querySelector(".sp-stream-stable")).toBeNull();
    expect(node.querySelector(".sp-stream-tail")).toBeNull();
    expect(node.querySelector(".sp-msg-cursor")).toBeTruthy();

    // 第二代流（重试从头生成，内容与前缀都不同）
    feed(runtime, { type: "token", data: "## 第二代重写\n\n全新的正文" });
    raf.mock.calls[1][0]();
    expect(node.textContent).toContain("第二代重写");

    feed(runtime, { type: "done" });

    // finalize 全量 = 第二代流全文，无第一代拼接残留
    const expected = "## 第二代重写\n\n全新的正文";
    expect(sidepanelState.chatHistory[1]).toEqual({ role: "assistant", content: expected });
    expect(node.querySelector(".sp-msg-assistant-body").innerHTML).toBe(renderMarkdown(expected));
    expect(node.textContent).not.toContain("第一代");
  });

  it("stream-reset 时已渲染的思考节点一并清掉，后续 reasoning 事件重建", async () => {
    const { deps, runtime } = await makeRuntime("问题");
    const node = assistantNode(deps);
    holdRaf();

    feed(runtime, { type: "reasoning", data: "第一代思考" });
    expect(node.querySelector(".sp-thinking")?.textContent).toContain("第一代思考");

    feed(runtime, { type: "stream-reset" });
    expect(node.querySelector(".sp-thinking")).toBeNull();

    // 第二代思考从头累积（不是接在第一代后面）
    feed(runtime, { type: "reasoning", data: "第二代思考" });
    expect(node.querySelector(".sp-thinking-text")?.textContent).toBe("第二代思考");
  });
});

// ==========================================================================
// 慢响应提示计时器（fake timers）
// ==========================================================================
describe("慢响应提示计时器（fake timers）", () => {
  it("发送后 15s 仍无首 token → 显示慢响应 notice；首个 token 到达后移除且不再重弹", async () => {
    vi.useFakeTimers();
    const { deps, runtime } = await makeRuntime();

    vi.advanceTimersByTime(15000);
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith(SLOW_NOTICE_TEXT, 0);

    // 首 token 到达：慢响应 notice 撤下，且此后再久也不重弹
    feed(runtime, { type: "token", data: "第一帧" });
    expect(deps.ui.removeConversationContextNotice).toHaveBeenCalled();

    vi.advanceTimersByTime(60000);
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledTimes(1);
  });

  it("15s 内收到首 token → 计时器被清，此后再久也不弹慢响应 notice", async () => {
    vi.useFakeTimers();
    const { deps, runtime } = await makeRuntime();

    feed(runtime, { type: "token", data: "很快就来了" });
    vi.advanceTimersByTime(60000);

    expect(deps.ui.showConversationContextNotice).not.toHaveBeenCalled();
  });

  it("done 收尾清计时器：收尾后不再弹慢响应 notice", async () => {
    vi.useFakeTimers();
    const { deps, runtime, session } = await makeRuntime();

    feed(runtime, { type: "done" });
    vi.advanceTimersByTime(30000);

    expect(deps.ui.showConversationContextNotice).not.toHaveBeenCalled();
    expect(session.port.disconnect).toHaveBeenCalled();
  });
});

// ==========================================================================
// 自动滚动开关对渲染的影响
// ==========================================================================
describe("自动滚动开关对渲染的影响", () => {
  it("setAutoScroll(false) 后 token flush 不滚动；恢复 true 后恢复滚动", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();

    runtime.setAutoScroll(false);
    deps.messages.scrollTop = 42;
    feed(runtime, { type: "token", data: "第一帧" });
    raf.mock.calls[0][0]();
    // 非强制滚动在开关关闭时早退
    expect(deps.messages.scrollTop).toBe(42);

    runtime.setAutoScroll(true);
    feed(runtime, { type: "token", data: "第二帧" });
    raf.mock.calls[1][0]();
    expect(deps.messages.scrollTop).toBe(deps.messages.scrollHeight);
  });

  it("appendUserMessage(text, false)（历史回放路径）不滚动不重置标志；默认 shouldScroll 强制滚动并重置标志", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();

    runtime.setAutoScroll(false);
    deps.messages.scrollTop = 42;

    // 历史回放（shouldScroll=false）：不滚动、不动开关
    runtime.appendUserMessage("回放消息", false);
    expect(deps.messages.scrollTop).toBe(42);
    feed(runtime, { type: "token", data: "一帧" });
    raf.mock.calls[0][0]();
    expect(deps.messages.scrollTop).toBe(42);

    // 默认（shouldScroll=true）：强制滚动，并把自动滚动开关重置为开
    runtime.appendUserMessage("新消息");
    expect(deps.messages.scrollTop).toBe(deps.messages.scrollHeight);
    deps.messages.scrollTop = 9;
    feed(runtime, { type: "token", data: "又一帧" });
    raf.mock.calls[1][0]();
    expect(deps.messages.scrollTop).toBe(deps.messages.scrollHeight);
  });
});

// ==========================================================================
// sendMessage 无字幕拦截的提前返回
// ==========================================================================
describe("sendMessage 无字幕拦截的提前返回", () => {
  // ensureCurrentContextForSend 的类型化信号（NO_SUBTITLE_SEND_BLOCKED）让
  // sendMessage 在用户消息上屏前中止：不追加用户/助手节点、不清输入框、
  // 不落 chatHistory、不发起 offscreen port、不进入流式 UI 状态。
  // notice 文案本身由 sidepanel（ensureCurrentContextForSend 调用方）负责。
  function makeSendDeps(ensureResult) {
    const deps = makeDeps();
    deps.input.value = "总结一下这个视频";
    deps.connectPort = vi.fn(async () => {
      throw new Error("不应发起 port");
    });
    deps.ensureCurrentContextForSend = vi.fn(async () => ensureResult);
    return { deps };
  }

  it("NO_SUBTITLE_SEND_BLOCKED（无字幕拦截）：不追加消息、不清输入、不发起 port", async () => {
    const { deps } = makeSendDeps("no-subtitle-send-blocked");
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();

    expect(deps.ensureCurrentContextForSend).toHaveBeenCalledTimes(1);
    expect(deps.connectPort).not.toHaveBeenCalled();
    expect(deps.messages.querySelector(".sp-msg-user")).toBeNull();
    expect(deps.messages.querySelector(".sp-msg-assistant")).toBeNull();
    expect(deps.input.value).toBe("总结一下这个视频");
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalledWith(true, expect.anything());
    expect(sidepanelState.chatHistory).toEqual([]);
  });

  it("false（上下文读取失败）：同样提前返回，行为与拦截一致", async () => {
    const { deps } = makeSendDeps(false);
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();

    expect(deps.connectPort).not.toHaveBeenCalled();
    expect(deps.messages.querySelector(".sp-msg-user")).toBeNull();
    expect(sidepanelState.chatHistory).toEqual([]);
  });

  it("true（放行）：照常追加用户消息并发起 port（非 empty 不受影响）", async () => {
    const deps = makeDeps();
    deps.input.value = "总结一下这个视频";
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();

    expect(deps.connectPort).toHaveBeenCalledTimes(1);
    expect(deps.messages.querySelector(".sp-msg-user")?.textContent).toBe("总结一下这个视频");
    expect(deps.input.value).toBe("");
    expect(deps.ports[0].port.postMessage).toHaveBeenCalledTimes(1);
  });
});
