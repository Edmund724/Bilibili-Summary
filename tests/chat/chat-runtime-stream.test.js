// sidepanel-chat-runtime 协议级测试（候选07：接口面收窄后全量重写）：
// 全部经 sendMessage + 假 port（或公开的 handleChatPortMessage 协议入口）喂
// offscreen port 消息（reasoning / token / stream-reset / done / stopped /
// error / notice / cost-guard），断言面向可观察结果（DOM / chatSessionState /
// deps 回调 / port 行为），不直接调用任何内部渲染步骤函数。
//
// 注意：chat-runtime 直接读写 chatSessionState（./sidepanel-state.js）。测试在
// beforeEach 里 resetModules 后把两个模块放进同一模块纪元导入（跨纪元会拿到
// 两个不同的 state 单例），并在每个用例前手动重置会用到的字段。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import { renderMarkdown } from "../../extension/ui/markdown.js";

let createChatRuntime;
let chatSessionState;

const SLOW_NOTICE_TEXT = "模型响应较慢，可能正在思考，请稍候…";

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
      isCurrent: vi.fn((id) => id === chatSessionState.currentConversationId)
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

// 驱动当前已注册的全部 rAF 回调并清空记录（token flush 与思考滚动各自注册
// 一帧，reasoning 先于 token 到达时思考帧占用前面的索引）
function runRafFrames(raf) {
  raf.mock.calls.splice(0).forEach((call) => call[0]());
}

function assistantNode(deps) {
  return deps.messages.querySelector(".chat-msg-assistant");
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  // 同一模块纪元内新鲜导入（先 resetModules 再 import，两个模块同图解析）：
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({ chatSessionState } = await import("../../extension/chat/chat-state.js"));
  // chatSessionState 是模块级单例，手动重置本文件用到的字段
  chatSessionState.contextData = null;
  chatSessionState.currentContextKey = "";
  chatSessionState.chatHistory = [];
  chatSessionState.currentConversationId = "";
  chatSessionState.currentConversationMeta = null;
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
    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("总结一下这个视频");
    expect(deps.input.value).toBe("");

    // 首 token 前占位已存在：光标 span 在、流式双容器尚未创建
    const node = assistantNode(deps);
    expect(node).toBeTruthy();
    expect(node.querySelector(".chat-msg-cursor")).toBeTruthy();
    expect(node.querySelector(".chat-stream-stable")).toBeNull();
    expect(node.querySelector(".chat-stream-tail")).toBeNull();

    // 流式状态：port 已连、UI 已进入流式、尚无写回
    expect(runtime.isStreaming()).toBe(true);
    expect(deps.ui.setStreamingUiState).toHaveBeenCalledWith(true, expect.anything());
    expect(chatSessionState.chatHistory).toEqual([]);
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
    const tail = node.querySelector(".chat-stream-tail");
    expect(tail.textContent).toContain("第一帧");
    expect(tail.textContent).toContain("第二帧");
  });

  it("流式中重复 sendMessage 被拒（activePort 占用）：不发起第二条 port、不清输入", async () => {
    const { deps, runtime } = await makeRuntime("第一条");

    deps.input.value = "第二条";
    await runtime.sendMessage();

    expect(deps.ports).toHaveLength(1);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(deps.input.value).toBe("第二条");
  });

  // 双发竞态：ensureCurrentContextForSend 的 await 窗口内（port 尚未建立、
  // activePort 仍为 null）第二次 sendMessage 必须被拒绝——否则开出第二条流，
  // 两条流的回执交错到两个 assistant 节点。
  it("发送中（ensure 窗口内）重复 sendMessage 被拒：不发起第二条 port、不开第二条流", async () => {
    const deps = makeDeps();
    deps.input.value = "第一条";
    let releaseEnsure;
    deps.ensureCurrentContextForSend = vi.fn(() => new Promise((resolve) => { releaseEnsure = resolve; }));

    const runtime = createChatRuntime(deps);
    const send1 = runtime.sendMessage();
    // 窗口内：端口未建、无 assistant 占位，但发送流程已在进行
    expect(runtime.isStreaming()).toBe(false);
    expect(deps.messages.querySelector(".chat-msg-assistant")).toBeNull();

    // 第二次 sendMessage（用户又按了一次回车）：必须被闸住
    deps.input.value = "第二条";
    await runtime.sendMessage();
    expect(deps.ports).toHaveLength(0);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(0);
    expect(deps.input.value).toBe("第二条");
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalledWith(true, expect.anything());

    // 释放第一个发送，流正常建立
    releaseEnsure(true);
    await send1;
    expect(deps.ports).toHaveLength(1);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(deps.input.value).toBe("");
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
    expect(node.querySelector(".chat-msg-cursor")).toBeTruthy();

    // 第二帧：追加列表项 + 代码块
    feed(runtime, { type: "token", data: "- 第二项\n```js\nconst a = 1;\n```\n" });
    raf.mock.calls[1][0]();
    expect(node.querySelectorAll("li")).toHaveLength(2);
    expect(node.querySelector("pre code")).toBeTruthy();
    expect(node.querySelector(".chat-msg-cursor")).toBeTruthy();

    // 第三帧：追加段落
    feed(runtime, { type: "token", data: "结尾段落\n" });
    raf.mock.calls[2][0]();
    expect(node.querySelectorAll("li")).toHaveLength(2);
    expect(node.querySelector("p")).toBeTruthy();

    // 光标始终接在末块容器（chat-stream-tail）尾部、渲染内容之后
    const tailEl = node.querySelector(".chat-stream-tail");
    expect(tailEl.lastElementChild.className).toBe("chat-msg-cursor");
  });

  it("稳定前缀 + 末块增量渲染：stable 只在增长时重渲染，done 后与全量渲染一致", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    // 帧 1：两个段落 → stable = 第一段（空行边界），tail = 末段 + 光标
    feed(runtime, { type: "token", data: "第一段\n\n第二段开头" });
    raf.mock.calls[0][0]();
    const stableEl = node.querySelector(".chat-stream-stable");
    const tailEl = node.querySelector(".chat-stream-tail");
    expect(stableEl.innerHTML).toBe(renderMarkdown("第一段"));
    expect(tailEl.querySelector("p").textContent).toBe("第二段开头");
    expect(tailEl.lastElementChild.className).toBe("chat-msg-cursor");

    // 篡改 stable 内容，用于探测后续帧是否重渲染了 stable
    stableEl.innerHTML = "SENTINEL";

    // 帧 2：tail 增长（无新空行边界）→ stable 不重渲染，tail 每帧更新
    feed(runtime, { type: "token", data: "，仍在增长" });
    raf.mock.calls[1][0]();
    expect(stableEl.innerHTML).toBe("SENTINEL");
    expect(tailEl.querySelector("p").textContent).toBe("第二段开头，仍在增长");
    expect(tailEl.lastElementChild.className).toBe("chat-msg-cursor");

    // 帧 3：新空行边界出现 → stable 增长并重渲染一次
    feed(runtime, { type: "token", data: "\n\n第三段" });
    raf.mock.calls[2][0]();
    expect(stableEl.innerHTML).toBe(renderMarkdown("第一段\n\n第二段开头，仍在增长"));
    expect(tailEl.querySelector("p").textContent).toBe("第三段");

    // done：流式双容器被整体替换，最终 DOM 与 renderMarkdown(全文) 一致
    const fullText = "第一段\n\n第二段开头，仍在增长\n\n第三段";
    feed(runtime, { type: "done" });
    expect(node.querySelector(".chat-stream-stable")).toBeNull();
    expect(node.querySelector(".chat-stream-tail")).toBeNull();
    expect(node.querySelector(".chat-msg-assistant-body").innerHTML).toBe(renderMarkdown(fullText));
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

    expect(chatSessionState.chatHistory[0]).toEqual({ role: "user", content: "帮我写个标题" });
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: fullText });
    expect(node.querySelector(".chat-msg-assistant-body").innerHTML).toBe(renderMarkdown(fullText));

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
  it("reasoning 创建思考节点（思考中…标签）并流式累加；首个 token 渲染时折叠保留", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "先想" });
    const thinking = node.querySelector(".chat-thinking");
    expect(thinking).toBeTruthy();
    expect(thinking.querySelector(".chat-thinking-label")?.textContent).toBe("思考中…");
    expect(thinking.querySelector(".chat-thinking-text")?.textContent).toBe("先想");

    // 后续 reasoning 增量累加到同一节点
    feed(runtime, { type: "reasoning", data: "再想" });
    expect(node.querySelector(".chat-thinking-text")?.textContent).toBe("先想再想");

    // 首个 token 的帧渲染把思考盒折叠成「思考过程」行保留在消息内（不移除）
    feed(runtime, { type: "token", data: "正文" });
    runRafFrames(raf);
    const folded = node.querySelector(".chat-thinking");
    expect(folded).toBeTruthy();
    expect(folded.classList.contains("chat-thinking-collapsible")).toBe(true);
    expect(folded.classList.contains("chat-thinking-collapsed")).toBe(true);
    expect(folded.querySelector(".chat-thinking-label")?.textContent).toBe("思考过程");
    expect(folded.querySelector(".chat-thinking-text")?.textContent).toBe("先想再想");
    expect(node.textContent).toContain("正文");
  });

  it("思考折叠行点击可展开/收起回看（当轮有效）；流式期间点击不折叠", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "想了很多" });
    const thinking = node.querySelector(".chat-thinking");
    // 流式期间未进入可折叠态：点击无事发生
    thinking.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(false);
    expect(thinking.querySelector(".chat-thinking-label")?.textContent).toBe("思考中…");

    // 正文首帧后折叠；点击展开回看 → 再点击收起
    feed(runtime, { type: "token", data: "正文" });
    runRafFrames(raf);
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(true);
    thinking.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(false);
    expect(thinking.querySelector(".chat-thinking-text")?.textContent).toBe("想了很多");
    thinking.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(true);

    // done 终态重渲染保留折叠行与文本
    feed(runtime, { type: "done" });
    const kept = node.querySelector(".chat-thinking");
    expect(kept?.classList.contains("chat-thinking-collapsed")).toBe(true);
    expect(kept?.querySelector(".chat-thinking-text")?.textContent).toBe("想了很多");
  });

  // 体验契约：思考内容不截断（旧实现 4000 字符上限 + 截断提示已移除），
  // 全量累加进显示缓冲；缓冲按节点隔离，跨消息不串内容。
  it("reasoning 超 4000 字符不截断：全量显示；跨消息不串内容", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const node1 = assistantNode(deps);
    const raf = holdRaf();

    // 逐块喂入超 4000 字符：每一步显示都等于全量累计
    const chunks = [
      "a".repeat(1500), // 累计 1500
      "b".repeat(2499), // 累计 3999
      "c",              // 累计 4000（旧实现的上限点）
      "d",              // 累计 4001
      "e".repeat(2500)  // 累计 6501
    ];
    let total = "";
    for (const chunk of chunks) {
      feed(runtime, { type: "reasoning", data: chunk });
      total += chunk;
      expect(node1.querySelector(".chat-thinking-text")?.textContent).toBe(total);
    }

    // 第一条走完（token 首帧折叠思考行，done 终态重渲染保留折叠行）
    feed(runtime, { type: "token", data: "第一条回答" });
    runRafFrames(raf);
    feed(runtime, { type: "done" });
    expect(node1.querySelector(".chat-thinking-text")?.textContent).toBe(total);

    // 第二条消息：思考累加器全新，不串上一条内容
    deps.input.value = "问题二";
    await runtime.sendMessage();
    const node2 = deps.messages.querySelectorAll(".chat-msg-assistant")[1];
    feed(runtime, { type: "reasoning", data: "第二条思考" });
    expect(node2.querySelector(".chat-thinking-text")?.textContent).toBe("第二条思考");
  });

  // 回归：上一代收尾后到达的 reasoning 事件（某些实现以空 data 的 reasoning
  // 收尾）不能再次附着到已折叠的旧思考节点——必须在新消息的 activeAssistantNode
  // 上新建节点，否则文本写进旧消息的思考盒、与本回合内容错位。
  it("跨消息 reasoning 收尾事件：在新回合的 assistant 节点上新建思考节点，不串进旧节点", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const raf = holdRaf();

    // 第一条：reasoning → token（思考盒随首帧渲染折叠保留）→ 收尾 reasoning
    //（真实时序：模型吐完思考后以空 data 的 reasoning 收尾，紧随 done 到达）
    // → done（终态重渲染保留全部思考行，未折叠的一并折叠）
    feed(runtime, { type: "reasoning", data: "第一轮思考" });
    feed(runtime, { type: "token", data: "第一轮正文" });
    runRafFrames(raf);
    feed(runtime, { type: "reasoning", data: null });
    feed(runtime, { type: "done" });
    const node1 = deps.messages.querySelectorAll(".chat-msg-assistant")[0];
    // node1 留下两条折叠思考行：正文流前的「第一轮思考」+ 收尾 reasoning 新建的
    const node1Thinkings = node1.querySelectorAll(".chat-thinking");
    expect(node1Thinkings).toHaveLength(2);
    node1Thinkings.forEach((thinking) => {
      expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(true);
      expect(thinking.querySelector(".chat-thinking-label")?.textContent).toBe("思考过程");
    });

    // 第二条消息：reasoning 必须新建节点，且附着在第二条的占位上——
    // 旧实现把「未创建」与「已结束」都折叠为 thinkingNode === null，
    // 会把新回合的思考写进旧消息的节点
    deps.input.value = "问题二";
    await runtime.sendMessage();
    const node2 = deps.messages.querySelectorAll(".chat-msg-assistant")[1];
    feed(runtime, { type: "reasoning", data: null });
    const node2Thinking = node2.querySelector(".chat-thinking");
    expect(node2Thinking).toBeTruthy();
    expect(node2Thinking.querySelector(".chat-thinking-text")?.textContent).toBe("");
    // 旧消息的思考行不再被触碰（也没有游离新节点）
    expect(node1.querySelectorAll(".chat-thinking")).toHaveLength(2);
    expect(deps.messages.querySelectorAll(".chat-thinking")).toHaveLength(3);

    // 后续 reasoning 增量正常流进新节点
    feed(runtime, { type: "reasoning", data: "第二轮思考" });
    expect(node2.querySelector(".chat-thinking-text")?.textContent).toBe("第二轮思考");
  });

  // 回归：跨消息时若上一代「已结束思考、且 token 首帧已渲染」，新回合的
  // reasoning 必须新建思考节点（旧实现把「未创建」与「已结束」都折叠为
  // thinkingNode === null，会把新回合的思考写进旧消息的节点）。
  it("跨消息思考重建：首帧 flush 前的 reasoning 在新回合新建节点（不依赖 thinkingNode 残留）", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const raf = holdRaf();

    // 第一条：token 首帧渲染（思考盒折叠保留）后 done——thinkingNode 已归 null
    feed(runtime, { type: "reasoning", data: "第一轮思考" });
    feed(runtime, { type: "token", data: "第一轮正文" });
    runRafFrames(raf);
    feed(runtime, { type: "done" });

    // 第二条消息：首帧 flush 前 reasoning 到达（同帧 token 尚未渲染）——
    // 节点必须建在第二条占位内
    deps.input.value = "问题二";
    await runtime.sendMessage();
    const node2 = deps.messages.querySelectorAll(".chat-msg-assistant")[1];
    feed(runtime, { type: "reasoning", data: "第二轮思考" });
    expect(node2.querySelector(".chat-thinking-text")?.textContent).toBe("第二轮思考");
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

    expect(node.querySelector(".chat-msg-assistant-body")?.innerHTML).toBe(renderMarkdown("部分回答"));
    expect(node.querySelector(".chat-msg-stopped")?.textContent).toBe("用户手动停止");
    expect(node.querySelector(".chat-stream-stable")).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([
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

    expect(node.querySelector(".chat-msg-stopped")?.textContent).toBe("已停止生成");
    expect(node.querySelector(".chat-msg-assistant-body")).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
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

    expect(node.querySelector(".chat-msg-error")?.textContent).toBe("错误：网络错误");
    expect(node.querySelector(".chat-msg-assistant-body")).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
    expect(session.port.disconnect).toHaveBeenCalled();
    expect(runtime.isStreaming()).toBe(false);
  });

  it("error 无 error 字段：默认文案「错误：未知错误」", async () => {
    const { deps, runtime } = await makeRuntime();

    feed(runtime, { type: "error" });

    expect(assistantNode(deps).querySelector(".chat-msg-error")?.textContent).toBe("错误：未知错误");
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
    expect(node.querySelector(".chat-stream-stable")).toBeTruthy();
    expect(node.querySelector("h3")?.textContent).toContain("第一代");

    // 读流中断重试：offscreen 发代际重置信号
    feed(runtime, { type: "stream-reset" });

    // 已渲染容器全部清掉，光标保留在节点末尾（下一帧 flush 重新接上）
    expect(node.querySelector(".chat-stream-stable")).toBeNull();
    expect(node.querySelector(".chat-stream-tail")).toBeNull();
    expect(node.querySelector(".chat-msg-cursor")).toBeTruthy();

    // 第二代流（重试从头生成，内容与前缀都不同）
    feed(runtime, { type: "token", data: "## 第二代重写\n\n全新的正文" });
    raf.mock.calls[1][0]();
    expect(node.textContent).toContain("第二代重写");

    feed(runtime, { type: "done" });

    // finalize 全量 = 第二代流全文，无第一代拼接残留
    const expected = "## 第二代重写\n\n全新的正文";
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: expected });
    expect(node.querySelector(".chat-msg-assistant-body").innerHTML).toBe(renderMarkdown(expected));
    expect(node.textContent).not.toContain("第一代");
  });

  it("stream-reset 时已渲染的思考节点一并清掉，后续 reasoning 事件重建", async () => {
    const { deps, runtime } = await makeRuntime("问题");
    const node = assistantNode(deps);
    holdRaf();

    feed(runtime, { type: "reasoning", data: "第一代思考" });
    expect(node.querySelector(".chat-thinking")?.textContent).toContain("第一代思考");

    feed(runtime, { type: "stream-reset" });
    expect(node.querySelector(".chat-thinking")).toBeNull();

    // 第二代思考从头累积（不是接在第一代后面）
    feed(runtime, { type: "reasoning", data: "第二代思考" });
    expect(node.querySelector(".chat-thinking-text")?.textContent).toBe("第二代思考");
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

  // 回归（首 token 标志复位错位）：终态收尾（clearStreamRuntimeState）不能
  // 复位「本代际已收首 token」标志——否则收尾后到达的 reasoning 收尾事件会
  // 再次触发"首 token 清理"，撤下（下一条消息的）慢响应提示。
  it("终态收尾不重置首 token 标志：收尾后迟到的 reasoning 不再触发清理、下一条消息慢响应提示照常", async () => {
    vi.useFakeTimers();
    const { deps, runtime } = await makeRuntime("问题一");
    const removeSpy = deps.ui.removeConversationContextNotice;

    // 第一条：reasoning → done。sendMessage 的计时器武装、首 token 清理、
    // done 收尾各调一次 clear（3 次 remove）
    feed(runtime, { type: "reasoning", data: "思考" });
    feed(runtime, { type: "done" });
    expect(removeSpy).toHaveBeenCalledTimes(3);

    // 迟到的收尾 reasoning 事件（真实时序中与 done 交错）——首 token 标志
    // 若被 done 的 clear 复位（旧实现），这里会再次触发 handleFirstStreamToken
    // 的清理副作用（remove 变 4 次）
    feed(runtime, { type: "reasoning", data: null });
    expect(removeSpy).toHaveBeenCalledTimes(3);

    // 第二条消息：慢响应提示必须照常重新武装并弹出
    deps.input.value = "问题二";
    await runtime.sendMessage();
    vi.advanceTimersByTime(15000);
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith(SLOW_NOTICE_TEXT, 0);

    // 第二条的首 token 到达后撤下、不再重弹
    feed(runtime, { type: "token", data: "回答" });
    expect(removeSpy.mock.calls.length).toBeGreaterThan(3);
    vi.advanceTimersByTime(60000);
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledTimes(1);
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
    expect(deps.messages.querySelector(".chat-msg-user")).toBeNull();
    expect(deps.messages.querySelector(".chat-msg-assistant")).toBeNull();
    expect(deps.input.value).toBe("总结一下这个视频");
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalledWith(true, expect.anything());
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("false（上下文读取失败）：同样提前返回，行为与拦截一致", async () => {
    const { deps } = makeSendDeps(false);
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();

    expect(deps.connectPort).not.toHaveBeenCalled();
    expect(deps.messages.querySelector(".chat-msg-user")).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("true（放行）：照常追加用户消息并发起 port（非 empty 不受影响）", async () => {
    const deps = makeDeps();
    deps.input.value = "总结一下这个视频";
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();

    expect(deps.connectPort).toHaveBeenCalledTimes(1);
    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("总结一下这个视频");
    expect(deps.input.value).toBe("");
    expect(deps.ports[0].port.postMessage).toHaveBeenCalledTimes(1);
  });

  // connectPort 失败（ensure offscreen 文档/建连抛错）必须回退：恢复流式 UI、
  // 清理半置位状态、向用户可见的错误路径回报（.chat-msg-error 占位）。
  it("connectPort 失败：退出流式 UI、isStreaming() 为 false、assistant 占位变错误占位、port 未建", async () => {
    const deps = makeDeps();
    deps.input.value = "总结一下这个视频";
    deps.connectPort = vi.fn(async () => {
      throw new Error("offscreen 文档创建失败");
    });
    const runtime = createChatRuntime(deps);

    await runtime.sendMessage();

    // 用户可见错误：占位节点变为错误占位（同 error 终态机制）
    const node = assistantNode(deps);
    expect(node.querySelector(".chat-msg-error")?.textContent).toBe("错误：offscreen 文档创建失败");

    // 状态回退：不卡流式态、无在途问答、无计时器残留（慢响应 notice 不弹）
    expect(runtime.isStreaming()).toBe(false);
    expect(runtime.hasPendingUserPrompt()).toBe(false);
    expect(deps.ui.setStreamingUiState).toHaveBeenLastCalledWith(false, expect.anything());
    expect(deps.ui.removeConversationContextNotice).toHaveBeenCalled();

    // 不再发起后续 port（无幽灵流）
    expect(deps.ports).toHaveLength(0);
    expect(deps.connectPort).toHaveBeenCalledTimes(1);

    // 重发可用（发送中标志已复位）
    deps.connectPort.mockImplementation(async () => {
      const session = makePort();
      deps.ports.push(session);
      return session.port;
    });
    deps.input.value = "重试发送";
    await runtime.sendMessage();
    expect(deps.connectPort).toHaveBeenCalledTimes(2);
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(2);
  });
});

// ==========================================================================
// 流式 flush 长任务分片：帧预算耗尽让出主线程（scheduler.yield / setTimeout 0）
// ==========================================================================
describe("流式 flush 长任务分片（帧预算耗尽让出主线程）", () => {
  // 预算检查用 performance.now 判定：时钟每读一次推进 100ms（超过 50ms 预算），
  // 让出点全部命中。（不能 mock 恒定值：deadline 取自同一次读数 +50，恒定值
  // 永远追不上 deadline，预算判定永不命中）
  function holdClockOverBudget() {
    let t = 0;
    return vi.spyOn(performance, "now").mockImplementation(() => (t += 100));
  }

  // 可手动放行的 scheduler.yield 替身（返回同一个 deferred promise）
  function gateScheduler() {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    window.scheduler = { yield: vi.fn(() => promise) };
    return {
      yieldSpy: window.scheduler.yield,
      release: () => release()
    };
  }

  afterEach(() => {
    delete window.scheduler;
  });

  it("帧预算耗尽：优先 scheduler.yield 让出主线程，让出后完成渲染并保留光标", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    const gate = gateScheduler();
    holdClockOverBudget();

    feed(runtime, { type: "token", data: "第一段\n\n第二段" });
    raf.mock.calls[0][0]();

    // 双容器已建（同步部分）但渲染延后：stable 让出点已挂起
    expect(gate.yieldSpy).toHaveBeenCalledTimes(1);
    expect(node.querySelector(".chat-stream-stable")?.innerHTML).toBe("");
    expect(node.querySelector(".chat-stream-tail")?.innerHTML).toBe("");

    // 放行：stable 渲染后预算仍耗尽，末块渲染前再次让出（共 2 次）
    gate.release();
    await vi.waitFor(() => {
      expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("第二段");
    });
    expect(gate.yieldSpy).toHaveBeenCalledTimes(2);
    expect(node.querySelector(".chat-stream-stable")?.innerHTML).toBe(renderMarkdown("第一段"));
    const tailEl = node.querySelector(".chat-stream-tail");
    expect(tailEl.lastElementChild.className).toBe("chat-msg-cursor");

    // base/pending 收口正常：done 后全量文本不丢
    feed(runtime, { type: "done" });
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: "第一段\n\n第二段" });
  });

  it("scheduler.yield 不存在（Safari 等旧浏览器）：setTimeout(0) 兜底让出，渲染仍完成", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    // jsdom 无 Scheduler API 且本用例不注入：走 setTimeout(0) 兜底
    expect(window.scheduler).toBeUndefined();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    holdClockOverBudget();

    feed(runtime, { type: "token", data: "正文内容" });
    raf.mock.calls[0][0]();
    expect(node.querySelector(".chat-stream-tail")?.innerHTML).toBe("");

    await vi.waitFor(() => {
      expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("正文内容");
    });
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 0)).toBe(true);
    expect(node.querySelector(".chat-msg-cursor")).toBeTruthy();
  });

  it("让出期间流收口（done）：恢复后旧帧作废，不向终态 DOM 回写流式容器", async () => {
    const { deps, runtime, session } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    const gate = gateScheduler();
    holdClockOverBudget();

    feed(runtime, { type: "token", data: "半截回答" });
    raf.mock.calls[0][0]();
    expect(node.querySelector(".chat-stream-tail")?.innerHTML).toBe("");

    // 挂起在让出点时 done 到达：终态渲染 + 收口（未 flush 的 pending 一并入全量）
    feed(runtime, { type: "done" });
    expect(node.querySelector(".chat-msg-assistant-body")?.innerHTML).toBe(renderMarkdown("半截回答"));
    expect(session.port.disconnect).toHaveBeenCalled();

    // 让出恢复：代际不匹配 → 旧帧作废，不重建 stable/tail、不回写历史
    gate.release();
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
    expect(node.querySelector(".chat-stream-stable")).toBeNull();
    expect(node.querySelector(".chat-stream-tail")).toBeNull();
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: "半截回答" });
  });

  it("让出窗口内新 token 到达：旧帧作废、新帧渲染合并内容（pending 不丢）", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    const gate = gateScheduler();
    holdClockOverBudget();

    feed(runtime, { type: "token", data: "第一帧" });
    raf.mock.calls[0][0](); // 旧帧：挂起在让出点
    feed(runtime, { type: "token", data: "第二帧" });
    raf.mock.calls[1][0](); // 新帧：同样挂起在让出点（预算仍耗尽）

    // 放行：先恢复的旧帧作废（代际不匹配），新帧渲染合并后的完整内容
    gate.release();
    await vi.waitFor(() => {
      expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("第二帧");
    });
    expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("第一帧");

    // 旧帧未回写 base：done 后全量文本 = 两帧合并，无丢字
    feed(runtime, { type: "done" });
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: "第一帧第二帧" });
  });
});

// ==========================================================================
// M14 增量：流式滚动瞬时化 / 思考文本滚动合帧 / flush 异常收口
// ==========================================================================
describe("M14 增量：流式滚动瞬时化 / 思考文本滚动合帧 / flush 异常收口", () => {
  it("流式 flush 滚动瞬时化：scrollTo({behavior:'instant'}) 覆盖 CSS smooth；自动滚动关闭时不触发", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();
    const scrollToSpy = vi.fn();
    deps.messages.scrollTo = scrollToSpy;

    feed(runtime, { type: "token", data: "第一帧" });
    raf.mock.calls[0][0]();
    expect(scrollToSpy).toHaveBeenCalledWith({ top: expect.any(Number), behavior: "instant" });

    // 自动滚动关闭：早退，不触发 scrollTo（用户上翻浏览不被打断）
    runtime.setAutoScroll(false);
    scrollToSpy.mockClear();
    feed(runtime, { type: "token", data: "第二帧" });
    raf.mock.calls[1][0]();
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("非流式路径（appendUserMessage / endStream 收尾）保留直写 scrollTop，不经 scrollTo", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();
    const scrollToSpy = vi.fn();
    deps.messages.scrollTo = scrollToSpy;

    // appendUserMessage 强制滚动：直写 scrollTop（滚动节奏交给 CSS smooth）
    deps.messages.scrollTop = 0;
    runtime.appendUserMessage("新消息");
    expect(deps.messages.scrollTop).toBe(deps.messages.scrollHeight);
    expect(scrollToSpy).not.toHaveBeenCalled();

    // flush 路径走 instant scrollTo；done 收尾（endStream）回到直写
    feed(runtime, { type: "token", data: "正文" });
    raf.mock.calls[0][0]();
    expect(scrollToSpy).toHaveBeenCalledTimes(1);
    feed(runtime, { type: "done" });
    expect(scrollToSpy).toHaveBeenCalledTimes(1);
    expect(deps.messages.scrollTop).toBe(deps.messages.scrollHeight);
  });

  it("思考文本滚动合帧：textContent 逐 token 同步（全量不截断），scrollTop 按帧合批只滚一次", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "第一段" });
    const textNode = node.querySelector(".chat-thinking-text");
    expect(textNode?.textContent).toBe("第一段");

    // 同帧第二条增量：不再注册帧、不触发滚动读数
    const getScrollHeight = vi.fn(() => 1234);
    Object.defineProperty(textNode, "scrollHeight", { get: getScrollHeight, configurable: true });
    feed(runtime, { type: "reasoning", data: "第二段" });
    expect(node.querySelector(".chat-thinking-text")?.textContent).toBe("第一段第二段");
    expect(getScrollHeight).not.toHaveBeenCalled();

    // 帧回调：整个思考阶段累积的多条增量只做一次滚动
    raf.mock.calls[0][0]();
    expect(textNode.scrollTop).toBe(1234);
    expect(getScrollHeight).toHaveBeenCalledTimes(1);
  });

  // 回归（挂起帧全局单标志）：上一条消息的思考滚动帧挂起的 ≤16ms 窗口内，
  // 新消息首条 reasoning 到达——挂起标志必须按节点隔离，新节点能独立调度
  // 滚动帧，否则新节点的滚动被旧帧挡掉。
  it("跨消息思考滚动：旧消息滚动帧挂起期间，新消息思考节点独立调度互不影响", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const raf = holdRaf();

    // 第一条：reasoning 注册滚动帧（calls[0]），故意不驱动——保持挂起；
    // token 注册 flush 帧（calls[1]），只驱动它（思考盒随首帧渲染折叠保留）
    feed(runtime, { type: "reasoning", data: "第一轮思考" });
    feed(runtime, { type: "token", data: "第一轮正文" });
    raf.mock.calls[1][0]();
    feed(runtime, { type: "done" });
    expect(raf.mock.calls).toHaveLength(2);

    // 第二条消息首条 reasoning：旧帧仍挂起，新节点必须能独立注册滚动帧
    deps.input.value = "问题二";
    await runtime.sendMessage();
    const node2 = deps.messages.querySelectorAll(".chat-msg-assistant")[1];
    feed(runtime, { type: "reasoning", data: "第二轮思考" });
    expect(raf.mock.calls).toHaveLength(3);

    // 驱动新帧：新节点滚动生效（旧挂起帧不阻挡）
    const textNode2 = node2.querySelector(".chat-thinking-text");
    const getScrollHeight2 = vi.fn(() => 4321);
    Object.defineProperty(textNode2, "scrollHeight", { get: getScrollHeight2, configurable: true });
    raf.mock.calls[2][0]();
    expect(textNode2.scrollTop).toBe(4321);

    // 旧帧随后执行：只写旧节点（折叠后仍挂在第一条消息内），不触碰新节点
    getScrollHeight2.mockClear();
    raf.mock.calls[0][0]();
    expect(getScrollHeight2).not.toHaveBeenCalled();
  });

  // 钉底契约：思考盒内用户上翻即停跟随（绝不拉回底部），回到底部附近
  //（距底 ≤ 24px）恢复跟随——与外层消息容器同一套契约。
  it("思考盒钉底契约：用户上翻即停跟随（绝不拉回），回到底部附近恢复", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "第一段" });
    const textNode = node.querySelector(".chat-thinking-text");
    Object.defineProperty(textNode, "scrollHeight", { get: () => 1000, configurable: true });
    Object.defineProperty(textNode, "clientHeight", { get: () => 200, configurable: true });

    // 默认钉底：帧回调把 scrollTop 钉到 scrollHeight
    raf.mock.calls[0][0]();
    expect(textNode.scrollTop).toBe(1000);

    // 用户上翻（scroll 事件，距底 > 24px）：停跟随，后续增量不拉回
    textNode.scrollTop = 100;
    textNode.dispatchEvent(new Event("scroll"));
    feed(runtime, { type: "reasoning", data: "第二段" });
    raf.mock.calls[1][0]();
    expect(textNode.scrollTop).toBe(100);

    // 用户回到底部附近（距底 ≤ 24px）：恢复跟随
    textNode.scrollTop = 985;
    textNode.dispatchEvent(new Event("scroll"));
    feed(runtime, { type: "reasoning", data: "第三段" });
    raf.mock.calls[2][0]();
    expect(textNode.scrollTop).toBe(1000);
  });

  it("流式消息带 chat-msg-streaming 类（豁免 content-visibility），endStream 收口摘除", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    expect(node.classList.contains("chat-msg-streaming")).toBe(true);
    feed(runtime, { type: "token", data: "正文" });
    runRafFrames(raf);
    expect(node.classList.contains("chat-msg-streaming")).toBe(true);
    feed(runtime, { type: "done" });
    expect(node.classList.contains("chat-msg-streaming")).toBe(false);
  });

  it("flush 同步段抛错：catch 收口记 console.error，不产生 unhandled rejection", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 注入点：flush 同步段末尾的 scrollToBottom 直写 scrollTop 抛错
    Object.defineProperty(deps.messages, "scrollTop", {
      get: () => 0,
      set: () => {
        throw new Error("scroll boom");
      },
      configurable: true
    });

    feed(runtime, { type: "token", data: "正文" });
    raf.mock.calls[0][0]();
    // 同步段抛错经 async promise 链进入 catch（微任务后记日志）
    await Promise.resolve();
    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalledWith("[chat-runtime] 流式渲染 flush 失败：", expect.any(Error));
    // 抛错点之前的渲染已完成（滚动位于 tail 渲染之后）
    expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("正文");
  });
});

// ==========================================================================
// resetStreamState 对挂起流式渲染帧的清理
// ==========================================================================
describe("resetStreamState 对挂起流式渲染帧的清理", () => {
  it("resetStreamState 取消挂起帧后：新消息的 token 重新调度 flush（旧帧 id 不再占位）", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const raf = holdRaf();

    // 流式中：token 入缓冲、flush 帧已调度但未执行
    feed(runtime, { type: "token", data: "旧流内容" });
    expect(raf).toHaveBeenCalledTimes(1);

    // store reset / restartChat 路径：清流状态 + 清消息区（后者在 sidepanel
    // restartChat / stopActiveChat 中由 resetConversationView 完成）
    runtime.resetStreamState();
    expect(runtime.isStreaming()).toBe(false);
    deps.messages.innerHTML = "";

    // 新消息开始流式：token 必须能重新调度 flush 帧——旧实现里
    // tokenFlushFrame 仍持有旧帧 id，appendToken 直接跳过调度，新流
    // 永不渲染（直到旧帧被浏览器执行，若旧帧已被取消则永久卡住）
    deps.input.value = "问题二";
    await runtime.sendMessage();
    feed(runtime, { type: "token", data: "新流正文" });
    expect(raf).toHaveBeenCalledTimes(2);

    // 新帧渲染新节点
    raf.mock.calls[1][0]();
    const node2 = deps.messages.querySelector(".chat-msg-assistant");
    expect(node2.querySelector(".chat-stream-tail").textContent).toContain("新流正文");

    // 旧帧执行：只渲染已脱离的旧节点，不污染消息区、不影响新节点
    raf.mock.calls[0][0]();
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(1);
    expect(node2.querySelector(".chat-stream-tail").textContent).toContain("新流正文");
  });

  it("resetStreamState 后执行旧帧：消息区不被旧流残留渲染污染", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "旧流内容" });
    expect(raf).toHaveBeenCalledTimes(1);

    runtime.resetStreamState();
    deps.messages.innerHTML = ""; // sidepanel 在 resetStreamState 后清消息区

    // 旧帧回调被执行（jsdom 手动驱动）：不得向消息区重建任何流式渲染
    raf.mock.calls[0][0]();
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(0);
    expect(deps.messages.querySelectorAll(".chat-stream-stable")).toHaveLength(0);
    expect(deps.messages.querySelectorAll(".chat-stream-tail")).toHaveLength(0);
    expect(deps.messages.querySelectorAll(".chat-msg-cursor")).toHaveLength(0);
  });
});
