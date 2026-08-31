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
// 事故背景三（SW 冷启动撞车）：分配器账本是模块级状态、随 SW 实例生灭，而
// 会话规则生命周期是整个浏览器会话。SW 重启后计数器归零、平台上残留旧规则
// 时，新实例会再次分配同一 id：旧任务跑完的 cleanup 把新任务正依赖的规则
// 删掉，音轨请求丢 Referer/Origin 被 bilivideo CDN 403。修复：首次分配前调
// getSessionRules 以平台为事实源对账一次（区间内残留 id 收进活跃集不再复用、
// 计数器越过平台最大 id、空闲池清空）。
//
// 判别性用例：
// - 无文档时 handleAsrDecodePrepare 必须真正调用 chrome.offscreen.createDocument
//   （旧实现吞掉 TypeError 后不会调用）；
// - 并发 prepare 得到不同 ruleId 且规则并存；cleanup 只删自己的 id；
//   重复/未知 id 的 cleanup 幂等不抛；释放后 id 复用；加规则失败照错误路径
//   上报且 id 归还；
// - 冷启动对账：平台残留 32001 时新任务分配 32002 不撞车、旧任务 cleanup 只
//   删自己的、无残留时首次分配仍是 32001。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

// 模拟 updateSessionRules 的会话规则表：removeRuleIds 先删、addRules 后加，
// 用于断言多任务规则并存 / 单任务删除的精确性（与真实 API 同序语义）；
// initialRules 为冷启动对账要看到的平台残留规则
function makeRuleStore(initialRules = []) {
  const rules = new Map(initialRules.map((rule) => [rule.id, rule]));
  const updateSessionRules = vi.fn(async ({ removeRuleIds = [], addRules = [] }) => {
    for (const id of removeRuleIds) rules.delete(id);
    for (const rule of addRules) rules.set(rule.id, rule);
  });
  // getSessionRules 返回当前全表：对账按平台事实源读取
  const getSessionRules = vi.fn(async () => [...rules.values()]);
  return { rules, updateSessionRules, getSessionRules };
}

function stubSwEnv({ matchAllResult, matchAllError, updateSessionRules, getSessionRules } = {}) {
  const createDocument = vi.fn(async () => ({}));
  const updateRules = updateSessionRules || vi.fn(async () => {});
  const getRules = getSessionRules || vi.fn(async () => []);
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
    declarativeNetRequest: { updateSessionRules: updateRules, getSessionRules: getRules }
  });
  const matchAll = vi.fn(async () => {
    if (matchAllError) throw matchAllError;
    return matchAllResult || [];
  });
  vi.stubGlobal("clients", { matchAll });
  return { createDocument, matchAll, updateSessionRules: updateRules, getSessionRules: getRules };
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

describe("防盗链规则 id 按任务分配（多转写任务并发互不删除）", () => {
  it("并发两次 prepare 分配不同 ruleId，两条规则并存且内容与旧版一致", async () => {
    const store = makeRuleStore();
    stubSwEnv({
      matchAllResult: existingDocClients,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
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
    stubSwEnv({
      matchAllResult: existingDocClients,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
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
    stubSwEnv({
      matchAllResult: existingDocClients,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
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
    stubSwEnv({
      matchAllResult: existingDocClients,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
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
        .mockImplementation(store.updateSessionRules),
      getSessionRules: store.getSessionRules
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

// 事故背景三的回归用例：重载本模块 = 冷启动一个新的 SW 实例（账本归零），
// makeRuleStore 的初始规则 = 上一实例残留在平台的会话规则。
describe("SW 冷启动对账（分配器账本以平台为事实源重建）", () => {
  // 平台残留的上一实例规则，内容与新任务所加规则同形
  function residueRule(id) {
    return { id, ...EXPECTED_RULE_SHAPE };
  }

  async function coldStartBridge(initialRules = []) {
    const store = makeRuleStore(initialRules);
    stubSwEnv({
      matchAllResult: existingDocClients,
      updateSessionRules: store.updateSessionRules,
      getSessionRules: store.getSessionRules
    });
    bridge = await import("../../extension/asr/offscreen-bridge.bg.js");
    return store;
  }

  it("平台残留活跃规则 32001：新任务不复用（分配 32002/32003，残留不被覆写）", async () => {
    const residue = residueRule(32001);
    const store = await coldStartBridge([residue]);

    const first = await prepareOnce();
    const second = await prepareOnce();

    expect(first).toEqual({ ok: true, ruleId: 32002 });
    expect(second).toEqual({ ok: true, ruleId: 32003 });
    // 残留规则未被先删后加覆写；对账每次 SW 实例只做一次（第二次分配靠账本）
    expect(store.rules.get(32001)).toBe(residue);
    expect(store.getSessionRules).toHaveBeenCalledTimes(1);
  });

  it("撞车链回归：残留 32001 时旧任务 cleanup 只删自己的，不误删新任务的 32002", async () => {
    const store = await coldStartBridge([residueRule(32001)]);

    const task2 = await prepareOnce();
    expect(task2.ruleId).toBe(32002);

    // 上一实例的任务 1（offscreen 文档跨 SW 存活）跑完，cleanup 带回自己的 32001
    await expect(cleanupOnce(32001)).resolves.toEqual({ ok: true });
    expect(store.rules.has(32001)).toBe(false);
    expect(store.rules.has(task2.ruleId)).toBe(true);

    // 账本一致：32001 随 cleanup 归还（平台上已无此 id），后续任务可安全复用
    const task3 = await prepareOnce();
    expect(task3.ruleId).toBe(32001);
    expect(store.rules.size).toBe(2);
  });

  it("无残留时对账为空操作：首次分配仍是 32001，行为不变", async () => {
    const store = await coldStartBridge();

    const first = await prepareOnce();

    expect(first).toEqual({ ok: true, ruleId: 32001 });
    expect(store.rules.size).toBe(1);
    expect(store.getSessionRules).toHaveBeenCalledTimes(1);
  });

  it("旧任务 cleanup 先于对账到达：先删平台规则，随后的对账与分配不撞车", async () => {
    const store = await coldStartBridge([residueRule(32001)]);

    // SW 刚重启、本实例尚无 prepare 时，上一实例任务 1 的 cleanup 先到达
    await expect(cleanupOnce(32001)).resolves.toEqual({ ok: true });
    expect(store.rules.size).toBe(0);

    // 平台规则已被该 cleanup 删掉，对账看不到残留：32001 可重新分配
    const next = await prepareOnce();
    expect(next.ruleId).toBe(32001);
    expect(store.rules.size).toBe(1);
  });

  it("重复/未知 id 的 cleanup 幂等在对账后不回归：不抛、不重复入池", async () => {
    const store = await coldStartBridge([residueRule(32001)]);

    await prepareOnce(); // 对账后分到 32002，保持活跃
    // 对账收编的 32001 归还一次后，重复 cleanup 与未分配的区间内 id 均幂等忽略
    await expect(cleanupOnce(32001)).resolves.toEqual({ ok: true });
    await expect(cleanupOnce(32001)).resolves.toEqual({ ok: true });
    await expect(cleanupOnce(bridge.ASR_AUDIO_SESSION_RULE_ID_BASE + 4)).resolves.toEqual({ ok: true });

    // 池未被污染：下一任务复用刚归还的 32001，再下一任务走计数器 32003
    //（若 32001 被重复入池，这里会再次分到 32001 而与活跃任务撞 id）
    const next = await prepareOnce();
    expect(next.ruleId).toBe(32001);
    const after = await prepareOnce();
    expect(after.ruleId).toBe(32003);
  });
});
