// asr-decode-prepare 的 offscreen 文档守卫回归测试 + 防盗链规则 id 分配测试。
//
// 事故背景一（文档守卫）：ensureAsrOffscreenDocument 曾在 service worker 里用
// 不存在的 `chrome.clients` 命名空间调用 matchAll（SW 标准全局是 `clients` /
// self.clients），TypeError 被 catch-all 吞掉 → 无文档时从不创建 offscreen
// 文档 → 页面侧 "asr-decode" 端口找不到接收端（"Receiving end does not
// exist"），~2ms 内 onDisconnect，用户看到「音频解码中断：后台连接已断开」。
// 修复：改用 SW 标准全局 `self.clients.matchAll`。
//
// 事故背景二（规则 id 冲突）：防盗链会话规则曾是固定 id 32001，多任务并发时
// A 任务先结束的 cleanup 会把 B 任务正依赖的规则删掉，B 的音频下载随后失败
//（切视频不取消转写后，两任务并发是正常场景）。修复：background 按任务分配
// 独立 id（prepare 响应带回 ruleId，cleanup 只删自己的），空闲池复用防增长。
//
// 判别性用例：
// - 无文档时 handleAsrDecodePrepare 必须真正调用 chrome.offscreen.createDocument
//   （旧实现吞掉 TypeError 后不会调用）；
// - 并发 prepare 得到不同 ruleId 且规则并存；cleanup 只删自己的 id；
//   重复/未知 id 的 cleanup 幂等不抛；释放后 id 复用；加规则失败照错误路径
//   上报且 id 归还。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

// 模拟 updateSessionRules 的会话规则表：removeRuleIds 先删、addRules 后加，
// 用于断言多任务规则并存 / 单任务删除的精确性（与真实 API 同序语义）
function makeRuleStore() {
  const rules = new Map();
  const updateSessionRules = vi.fn(async ({ removeRuleIds = [], addRules = [] }) => {
    for (const id of removeRuleIds) rules.delete(id);
    for (const rule of addRules) rules.set(rule.id, rule);
  });
  return { rules, updateSessionRules };
}

function stubSwEnv({ matchAllResult, matchAllError, updateSessionRules } = {}) {
  const createDocument = vi.fn(async () => ({}));
  const updateRules = updateSessionRules || vi.fn(async () => {});
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() }
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    },
    offscreen: { createDocument },
    declarativeNetRequest: { updateSessionRules: updateRules }
  });
  const matchAll = vi.fn(async () => {
    if (matchAllError) throw matchAllError;
    return matchAllResult || [];
  });
  vi.stubGlobal("clients", { matchAll });
  return { createDocument, matchAll, updateSessionRules: updateRules };
}

// 已存在 offscreen 文档的 matchAll 结果（跳过 createDocument 分支）
const existingDocClients = [{ url: "chrome-extension://test/entry/offscreen.html" }];

let bridge;

beforeEach(() => {
  resetModuleState();
});

describe("handleAsrDecodePrepare 的 offscreen 文档守卫", () => {
  it("无文档时真正创建 offscreen 文档（回归：不再静默吞掉 matchAll TypeError）", async () => {
    const { createDocument } = stubSwEnv({ matchAllResult: [] });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument.mock.calls[0][0]).toMatchObject({
      url: "chrome-extension://test/entry/offscreen.html",
      // BLOBS（非 AUDIO_PLAYBACK）：Chrome 对无音频播放的 AUDIO_PLAYBACK
      // 文档 30 秒强制关闭，长视频解码会被「音频解码中断」
      reasons: ["BLOBS"]
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, ruleId: 32001 });
  });

  it("文档已存在（如 sidepanel 聊天创建的 offscreen-chat 文档）时不重复创建", async () => {
    const { createDocument } = stubSwEnv({ matchAllResult: existingDocClients });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(createDocument).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, ruleId: 32001 });
  });

  it("matchAll 异常按既有语义吞掉并返回 ok:true（不阻塞后续端口连接尝试）", async () => {
    const { createDocument } = stubSwEnv({ matchAllError: new Error("boom") });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const sendResponse = vi.fn();
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, sendResponse);

    expect(createDocument).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, ruleId: 32001 });
  });
});

// 规则内容与旧固定 id 版本一致：只对 bilivideo 的扩展请求改 Referer/Origin
const EXPECTED_RULE_SHAPE = {
  priority: 1,
  action: {
    type: "modifyHeaders",
    requestHeaders: [
      { header: "Referer", operation: "set", value: "https://www.bilibili.com" },
      { header: "Origin", operation: "set", value: "https://www.bilibili.com" }
    ]
  },
  condition: { urlFilter: "||bilivideo.com", resourceTypes: ["xmlhttprequest"] }
};

describe("防盗链规则 id 按任务分配（多转写任务并发互不删除）", () => {
  async function prepareOnce() {
    const responses = [];
    await bridge.handleAsrDecodePrepare({ taskType: "asr-decode-prepare" }, {}, (r) => responses.push(r));
    return responses[0];
  }

  async function cleanupOnce(ruleId) {
    const responses = [];
    await bridge.handleAsrDecodeCleanup(
      { taskType: "asr-decode-cleanup", ruleId },
      {},
      (r) => responses.push(r)
    );
    return responses[0];
  }

  it("并发两次 prepare 分配不同 ruleId，两条规则并存且内容与旧版一致", async () => {
    const store = makeRuleStore();
    stubSwEnv({ matchAllResult: existingDocClients, updateSessionRules: store.updateSessionRules });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const first = await prepareOnce();
    const second = await prepareOnce();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.ruleId).toBe(bridge.ASR_AUDIO_SESSION_RULE_ID_BASE + 1);
    expect(second.ruleId).not.toBe(first.ruleId);
    // 规则并存：各任务一条，id 互不相同；内容不变
    expect(store.rules.size).toBe(2);
    expect([...store.rules.keys()].sort((a, b) => a - b)).toEqual([
      bridge.ASR_AUDIO_SESSION_RULE_ID_BASE,
      bridge.ASR_AUDIO_SESSION_RULE_ID_BASE + 1
    ]);
    for (const rule of store.rules.values()) {
      expect(rule).toMatchObject(EXPECTED_RULE_SHAPE);
    }
  });

  it("一次 cleanup 只删自己的 ruleId，另一并发任务的规则仍在", async () => {
    const store = makeRuleStore();
    stubSwEnv({ matchAllResult: existingDocClients, updateSessionRules: store.updateSessionRules });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const first = await prepareOnce();
    const second = await prepareOnce();
    const cleanupResponses = [];
    await bridge.handleAsrDecodeCleanup(
      { taskType: "asr-decode-cleanup", ruleId: first.ruleId },
      {},
      (r) => cleanupResponses.push(r)
    );

    expect(cleanupResponses[0]).toEqual({ ok: true });
    expect([...store.rules.keys()]).toEqual([second.ruleId]);
  });

  it("重复 cleanup 与未知 ruleId 的 cleanup 幂等：ok:true、不抛、不污染 id 池", async () => {
    const store = makeRuleStore();
    stubSwEnv({ matchAllResult: existingDocClients, updateSessionRules: store.updateSessionRules });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const first = await prepareOnce();
    const cleanup = (ruleId) => cleanupOnce(ruleId);

    // 同一 id 重复 cleanup、从未分配的 id cleanup，都不抛且 ok:true
    await expect(cleanup(first.ruleId)).resolves.toEqual({ ok: true });
    await expect(cleanup(first.ruleId)).resolves.toEqual({ ok: true });
    const unknownId = bridge.ASR_AUDIO_SESSION_RULE_ID_BASE + 500;
    await expect(cleanup(unknownId)).resolves.toEqual({ ok: true });
    expect(store.rules.size).toBe(0);

    // 未知 id 未进入空闲池：新任务复用的是首个 id 的释放位（32001），
    // 而非 32501 之类从未分配的杂 id
    const next = await prepareOnce();
    expect(next.ruleId).toBe(bridge.ASR_AUDIO_SESSION_RULE_ID_BASE);
  });

  it("cleanup 归还 id 后分配器复用：新任务拿回已释放的 id", async () => {
    const store = makeRuleStore();
    stubSwEnv({ matchAllResult: existingDocClients, updateSessionRules: store.updateSessionRules });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const first = await prepareOnce();
    await cleanupOnce(first.ruleId);
    const reused = await prepareOnce();

    expect(reused.ruleId).toBe(first.ruleId);
    expect(store.rules.size).toBe(1);
  });

  it("updateSessionRules 失败照既有错误路径上报（不吞），id 归还不随失败泄漏", async () => {
    const store = makeRuleStore();
    stubSwEnv({
      matchAllResult: existingDocClients,
      updateSessionRules: vi.fn()
        .mockImplementationOnce(async () => {
          throw new Error("dnr quota exceeded");
        })
        .mockImplementation(store.updateSessionRules)
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");

    const failed = await prepareOnce();
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("dnr quota exceeded");

    // 失败任务不占用 id：重试成功拿到的是同一个首 id
    const retried = await prepareOnce();
    expect(retried).toEqual({ ok: true, ruleId: bridge.ASR_AUDIO_SESSION_RULE_ID_BASE });
  });
});