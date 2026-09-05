// offscreen.js 对话链 presetId 穿线测试（工单 02）：
// resolveProviderWithKey 返回的 provider 带上记录的 presetId（preset 词表键，
// 非记录 id），经 runLadderChat → streamChat → chatCompletion 原样抵达请求构造
// 单缝；presetId 优先于 baseUrl host 推断——custom 用户改过反代域名时对话链的
// 平台识别不失效。断言到最终请求体（假 fetch 全链跑通，port 回吐 done）。
//
// 不 mock ladder（真链路）：动态装载的 ../ai/ladder.js 在 Node 测试环境可直接
// 运行，只 stub globalThis.fetch 与 chrome.runtime.sendMessage。
// chrome 依赖 mock 与「vi.resetModules + 动态导入 = 文档纪元」手法沿
// offscreen-chat-disconnect.test.js。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let onConnectListeners = [];
let fetchMock;

// 反代域名：host 推断无规则。对话链若没把 presetId 带到请求层，模式表未列的
// llama3.2 将落 unknown（思考字段全缺）——字段出现本身即穿线判据
const PROXY_BASE_URL = "https://thinking-proxy.example.com/v1";

function stubChromeRuntime() {
  vi.stubGlobal("chrome", {
    runtime: {
      onConnect: {
        addListener: (fn) => onConnectListeners.push(fn)
      },
      sendMessage: vi.fn(async (message) => {
        if (message?.type === "resolve-ai-provider") {
          return {
            ok: true,
            provider: {
              id: "p1",
              presetId: "ollama",
              name: "本地 Ollama",
              baseUrl: PROXY_BASE_URL,
              model: "llama3.2",
              enabled: true,
              requiresKey: false,
              hasSavedKey: true
            },
            apiKey: "test-key"
          };
        }
        return { ok: true };
      })
    },
    offscreen: {
      closeDocument: vi.fn(async () => {})
    }
  });
}

// 组装一条 OpenAI 兼容 SSE data: 行（对话链走流式）。
function sseData(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) {
              return { value: encoder.encode(chunks[i++]), done: false };
            }
            return { done: true };
          }
        };
      }
    }
  };
}

async function importOffscreen() {
  vi.resetModules();
  onConnectListeners = [];
  stubChromeRuntime();
  fetchMock = vi.fn(async () => sseResponse([sseData({ content: "你好" }), "data: [DONE]\n\n"]));
  vi.stubGlobal("fetch", fetchMock);
  return import("../../extension/entry/offscreen.js");
}

function makeChatPort() {
  const listeners = { message: [], disconnect: [] };
  return {
    port: {
      name: "offscreen-chat",
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    listeners
  };
}

beforeEach(() => {});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("offscreen 对话链 presetId 穿线", () => {
  it("resolveProviderWithKey 带回 presetId → 对话请求体按 preset 平台规则出 reasoning_effort（host 反代无规则也命中）", async () => {
    await importOffscreen();
    const session = makeChatPort();
    expect(onConnectListeners).toHaveLength(1);
    onConnectListeners[0](session.port);

    const onMessage = session.listeners.message[0];
    await onMessage({
      action: "chat",
      providerId: "p1",
      thinkingLevel: "off",
      context: {
        title: "测试视频",
        bvid: "BV1test000000",
        cid: "1000",
        subtitleBody: [{ from: 0, to: 5, content: "第一句话" }]
      },
      prompt: "总结一下"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROXY_BASE_URL}/chat/completions`);
    // presetId="ollama" 命中 unknownClass ollama-effort：off 档发 reasoning_effort:"none"；
    // 若穿线断裂（host 无规则 + llama3.2 不在模式表）则落 unknown、字段全缺
    expect(JSON.parse(init.body)).toMatchObject({
      model: "llama3.2",
      stream: true,
      reasoning_effort: "none"
    });
    // 全链跑通到 done（而非 error 提前退出）：穿线没有打断既有协议
    const types = session.port.postMessage.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain("done");
  });
});
