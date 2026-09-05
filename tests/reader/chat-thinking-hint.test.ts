// tests/reader/chat-thinking-hint.test.ts
// 工单 03「对话 Off 关不掉思考」提示行的 UI 回归测试（tests/reader/chat-tab.test.ts
// 的姊妹篇）：真实模板（ensureUiReady）+ 懒装载组合根，全部用真实 DOM 事件驱动
//（modelSelect change / 档位按钮 click），不直调组合根内部函数——「提示只由
// chat-tab.ts 的 updateThinkingHint 消费 resolver 判定结果驱动」正是本文件的
// 守护意图（激活前模板默认 hidden 即其黑盒佐证）；resolver 本体（识别优先级/
// 级联/offFallback 语义）是纯函数守护，已由 tests/ai/thinking-profiles.test.js
// 锁定，本文件不重复。
//
// 覆盖（工单 AC）：
// - 档位 Off + 关不掉模型：级联落 low（kimi-k3）→ 长文案；无 low 可落
//   （kimi-k2.7-code，baseUrl 空）→ 短文案；两条文案与工单逐字一致；
// - never 模型（kimi-k2-instruct / deepseek-chat）与 off 正常可用模型
//   （glm-4.6）选 Off 均静默无提示；
// - 实时刷新：模型 change 切回可关模型提示消失、切回再现；档位 Off→Low 收起、
//   Low→Off（关不掉模型）再现。
//
// 模型选型依据（extension/ai/thinking-profiles.ts 表，勿凭记忆）：
// - kimi-k2.7-code → EXCEPTIONS kimi-always：always 且无 low/on → offUnavailable
//   + offFallback:null（短文案）；taxonomy 按模型名命中，baseUrl 刻意留空；
// - kimi-k3 → EXCEPTIONS kimi-k3-effort：always 且 low=reasoning_effort:"low"
//   → offUnavailable + offFallback:"low"（长文案）；baseUrl 取 Kimi preset host
//   （core/presets.ts），顺带覆盖 resolver 的 host 推断识别路径；
// - kimi-k2-instruct → TAXONOMY kimi-instruct-never（"kimi-k2-" 前缀）、
//   deepseek-chat → TAXONOMY deepseek-chat-never：never → off 天然成立，静默；
// - glm-4.6 → TAXONOMY glm-hybrid-switch：off 正常可用 → offUnavailable:false。
//
// 模块纪元注意（与 chat-tab.test.ts 同款）：chatSessionState 与组合根闭包都是
// 模块级单例，beforeEach resetModules 后同纪元导入；chrome.storage / runtime
// 消息按 type 路由 stub（ai-providers-list 载荷带 baseUrl/model——提示判定的
// 识别入参与 updateThinkingHint 读的 chatSessionState.providers 同源）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

const { gatewayMock, gatewayCoreMock } = vi.hoisted(() => ({
  gatewayMock: {
    getCurrentAid: vi.fn(() => 0),
    fetchHotComments: vi.fn(async () => [])
  },
  gatewayCoreMock: {
    bgFetchJson: vi.fn(),
    isBiliUrl: vi.fn(() => true)
  }
}));

// 热评/网络路径与本文件无关（提示判定不触网）：mock 保持确定性，防止 init 的
// 上下文链路意外走网络（与 chat-tab.test.ts 同款）。
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments
}));
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: gatewayCoreMock.bgFetchJson,
  isBiliUrl: gatewayCoreMock.isBiliUrl
}));

// 文案逐字给定（工单 03，勿改写）——断言也逐字。
const HINT_LOW_FALLBACK = "当前模型不支持在本次请求中关闭思考，已使用最小思考档位";
const HINT_UNAVAILABLE = "当前模型没办法关掉思考";

// Kimi/GLM preset host（core/presets.ts）：resolver host 推断的输入形状。
const KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

// ai-providers-list 载荷条目（providers.ts 显式映射进 chatSessionState.providers
// 的形状：id 必填，model/baseUrl 走字符串收窄）。
interface StubProvider {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
}

// 平台载荷工厂：model/baseUrl 即 resolver 的识别入参；name 缺省取 model
//（providers.ts 渲染选项文案的同源回退）。
function provider(overrides: Partial<StubProvider> & { id: string; model: string }): StubProvider {
  return { name: overrides.model, baseUrl: "", enabled: true, ...overrides };
}

// 每用例替换的 ai-providers-list 载荷（stub 的 sendMessage 闭包按引用读取）。
let providersPayload: StubProvider[] = [];

type SendStub = ReturnType<typeof vi.fn>;
function stubChromeByType(): void {
  const chromeStub = window.chrome as unknown as {
    runtime: { sendMessage: SendStub; connect: SendStub };
    storage: {
      local: { get: SendStub; set: SendStub };
      sync: { set: SendStub };
      onChanged: { addListener: SendStub; removeListener: SendStub };
    };
  };
  chromeStub.runtime.sendMessage = vi.fn((message: { type?: string }, callback?: (resp: unknown) => void) => {
    const type = String(message?.type || "");
    if (type === "ai-providers-list") {
      callback?.({ ok: true, providers: providersPayload });
    } else if (type === "get-settings") {
      // 无设置回落：aiThinkingLevel 归一化到默认 off（档位测试的前置态）。
      callback?.({ ok: true, settings: {} });
    } else {
      callback?.({ ok: true });
    }
    return undefined;
  });
  chromeStub.runtime.connect = vi.fn(() => ({
    name: "offscreen-chat",
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (_fn: (msg: unknown) => void) => {} },
    onDisconnect: { addListener: (_fn: () => void) => {} }
  }));
  chromeStub.storage.local.get = vi.fn(async () => ({}));
  chromeStub.storage.local.set = vi.fn(async () => {});
  chromeStub.storage.sync.set = vi.fn(async () => {});
}

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let lazyChat: typeof import("../../extension/reader/lazy-chat-tab.js");
let statusBus: typeof import("../../extension/shared/subtitle-status-bus.js");

async function loadShell() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  statusBus = await import("../../extension/shared/subtitle-status-bus.js");
  const uiRenderer = await import("../../extension/ui/ui-renderer.js");
  lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
}

// 字幕就绪上下文：init 的 loadContextState 走进程内直读（不触网），提示判定
// 与上下文无关，但让 init 全链路按正常路径落定。
function seedReadyContext(): void {
  state.clip.title = "测试视频";
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "101";
  state.clip.aid = "7100";
  state.clip.subtitleFetchState = "ready";
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-boc-reader-mode");
  document.body.removeAttribute("data-boc-reader-mode");
  await loadShell();
  stubChromeByType();
  seedReadyContext();
  statusBus.publishSubtitleStatusPhase("idle");
});

// 装载组合根并走完 init（loadProvidersAndPrefs 之后的 updateThinkingHint 首判
// 在此落定），之后所有显隐变化都由 DOM 事件驱动。
async function activateChatTab() {
  const chat = await lazyChat.ensureReaderChatTab();
  await chat.ensureChatTabActivated();
  return chat;
}

function getHint(): HTMLElement {
  return document.getElementById(ids.readingChatThinkingHint) as HTMLElement;
}

function getModelSelect(): HTMLSelectElement {
  return document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement;
}

function getThinkingBtn(level: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    `#${ids.readingChatThinkingToggle} .chat-thinking-btn[data-level="${level}"]`
  ) as HTMLButtonElement;
}

describe("Off + 关不掉模型：resolver 判定 → 档位区提示（文案逐字）", () => {
  it("无 low 可落 → 短文案：baseUrl 空 + kimi-k2.7-code（激活前模板默认 hidden，提示只由组合根驱动）", async () => {
    providersPayload = [provider({ id: "p1", model: "kimi-k2.7-code" })];

    // 激活前：壳已建但组合根未装载，提示行保持模板默认 hidden + 空文案。
    expect(getHint().hidden).toBe(true);
    expect(getHint().textContent).toBe("");

    await activateChatTab();

    const hint = getHint();
    expect(hint.classList.contains("chat-thinking-hint")).toBe(true);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_UNAVAILABLE);
    // 三档按钮组不变（AC：UI 仅此一处增量）：默认档位 Off 仍由既有 is-active 语义表达。
    expect(getThinkingBtn("off").classList.contains("is-active")).toBe(true);
  });

  it("级联落 low → 长文案：Kimi host 推断 + kimi-k3（offFallback:\"low\"）", async () => {
    providersPayload = [provider({ id: "p1", model: "kimi-k3", baseUrl: KIMI_BASE_URL })];

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_LOW_FALLBACK);
  });
});

describe("静默分支：never 模型与 off 正常可用模型均无提示", () => {
  it("never（kimi-k2-instruct / deepseek-chat）与 off 可关（glm-4.6）选 Off 均保持 hidden", async () => {
    providersPayload = [
      provider({ id: "p1", model: "kimi-k2-instruct", baseUrl: KIMI_BASE_URL }),
      provider({ id: "p2", model: "deepseek-chat", baseUrl: DEEPSEEK_BASE_URL }),
      provider({ id: "p3", model: "glm-4.6", baseUrl: GLM_BASE_URL })
    ];

    await activateChatTab();

    const hint = getHint();
    // init 首判：never 模型 off 天然成立，不发参也不提示。
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");

    const select = getModelSelect();
    // 切到 deepseek-chat（同为 never）：仍静默。
    select.value = "p2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(true);
    // 切到 glm-4.6（off 正常可用）：不误报。
    select.value = "p3";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");
  });
});

describe("实时刷新：提示随模型切换与档位点击即时显隐", () => {
  it("模型 change：关不掉（kimi-k2.7-code）→ 可关（glm-4.6）提示消失，切回再现", async () => {
    providersPayload = [
      provider({ id: "p1", model: "kimi-k2.7-code" }),
      provider({ id: "p2", model: "glm-4.6", baseUrl: GLM_BASE_URL })
    ];

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_UNAVAILABLE);

    const select = getModelSelect();
    select.value = "p2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");

    select.value = "p1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_UNAVAILABLE);
  });

  it("档位 click：Off→Low 提示收起；Low→Off（关不掉模型）提示再现且文案不变", async () => {
    providersPayload = [provider({ id: "p1", model: "kimi-k3", baseUrl: KIMI_BASE_URL })];

    await activateChatTab();

    const hint = getHint();
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_LOW_FALLBACK);

    // Off→Low：档位切走即收提示（setThinkingLevel 同步写档位，紧随的重判读到新值）。
    getThinkingBtn("low").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe("");
    expect(getThinkingBtn("low").classList.contains("is-active")).toBe(true);

    // Low→Off（关不掉模型）：提示按长文案再现。
    getThinkingBtn("off").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(HINT_LOW_FALLBACK);
    expect(getThinkingBtn("off").classList.contains("is-active")).toBe(true);
  });
});
