// ai/map-reduce.js 编排测试（03 票）：
// 覆盖切片→小结→成稿编排（进度序号与百分比、token/done 回吐）、中止、
// 进度纯函数，以及单次路径 plan 判定。
// streamChat 的 port 协议测试已迁至 tests/ai/client.test.js。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, makeSubtitleBody } from "../setup.js";

let mod;
let segmentCacheLoop;

// 段缓存 SW 回路（arch-review-2026-09/05）：段缓存宿主迁 SW，orchestrateMapReduce
// 的缺省 segmentCache 是消息代理——测试环境把 chrome.runtime.sendMessage 路由到
// 真实 SW handler（createSegmentCacheHandler → segment-cache 单源 → 内存
// storage），读写全链路走真实消息与真实键位装配。
function createMemoryStorage() {
  const map = new Map();
  const local = {
    get: vi.fn(async (keys) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(map.entries());
      }
      const want = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of want) {
        if (map.has(k)) {
          out[k] = map.get(k);
        }
      }
      return out;
    }),
    set: vi.fn(async (items) => {
      for (const [key, value] of Object.entries(items)) {
        map.set(key, value);
      }
    }),
    remove: vi.fn(async (keys) => {
      const want = Array.isArray(keys) ? keys : [keys];
      for (const k of want) {
        map.delete(k);
      }
    })
  };
  return { map, local };
}

async function installSegmentCacheLoop() {
  const storage = createMemoryStorage();
  const handler = (await import("../../extension/ai/segment-cache-handler.js")).createSegmentCacheHandler();
  const sendMessage = vi.fn((message) => {
    if (message?.type === "segment-cache") {
      return new Promise((resolve) => handler(message, null, resolve));
    }
    return Promise.resolve({ ok: true });
  });
  vi.stubGlobal("chrome", {
    storage: { local: storage.local },
    runtime: { sendMessage }
  });
  return { storage, sendMessage };
}

async function importModules() {
  vi.resetModules();
  resetModuleState();
  segmentCacheLoop = await installSegmentCacheLoop();
  mod = await import("../../extension/ai/map-reduce.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeProvider() {
  return { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };
}

function makeContext() {
  return {
    title: "测试视频",
    bvid: "BV1test",
    cid: "123",
    selectedSubtitleId: "sub-1",
    subtitleBody: makeSubtitleBody(210000),
    chapters: []
  };
}

function makePort() {
  return { postMessage: vi.fn() };
}

// 组装非流式 JSON 响应。
function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload
  };
}

// 依 messages[user].content 里的「第 i/N 个连续片段」返回小结；成稿调用返回笔记。
function buildSequencedMock() {
  const summaryTexts = {
    1: "小结一：事实A。",
    2: "小结二：事实B。",
    3: "小结三：事实C。",
    4: "小结四：事实D。",
    5: "小结五：事实E。"
  };
  const fetchMock = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages[body.messages.length - 1]?.content || "";
    const isSegment = user.includes("连续片段");
    if (isSegment) {
      const m = user.match(/第 (\d+)\//);
      const idx = m ? Number(m[1]) : 1;
      return jsonResponse({ choices: [{ message: { content: summaryTexts[idx] || "小结" } }] });
    }
    return jsonResponse({ choices: [{ message: { content: "# 视频笔记：《测试视频》\n完整笔记正文。" } }] });
  });
  return { fetchMock, summaryTexts };
}

describe("buildProgressNotice 进度序号与百分比", () => {
  it("percent = round(index/total*100)，序号从 1 开始", () => {
    expect(mod.buildProgressNotice(1, 3)).toBe("正在整理第 1/3 段（33%）");
    expect(mod.buildProgressNotice(2, 3)).toBe("正在整理第 2/3 段（67%）");
    expect(mod.buildProgressNotice(3, 3)).toBe("正在整理第 3/3 段（100%）");
  });

  it("边界与非法入参：total 为 0/负/非数时回落到 1；index 越界收敛到 [1, total]", () => {
    expect(mod.buildProgressNotice(0, 3)).toBe("正在整理第 1/3 段（33%）");
    expect(mod.buildProgressNotice(5, 3)).toBe("正在整理第 3/3 段（100%）");
    // total 退化时回落到 1，index 收敛到 [1, total]
    expect(mod.buildProgressNotice(2, 0)).toBe("正在整理第 1/1 段（100%）");
    expect(mod.buildProgressNotice(2, -4)).toBe("正在整理第 1/1 段（100%）");
    expect(mod.buildProgressNotice(2, "x")).toBe("正在整理第 1/1 段（100%）");
  });
});

describe("orchestrateMapReduce 切片→小结→成稿编排", () => {
  it("逐段产出小结（带进度 notice）→ 成稿一次 → token+done 回吐", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();

    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(5);

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(result.segmentSummaries).toEqual([
      "小结一：事实A。",
      "小结二：事实B。",
      "小结三：事实C。",
      "小结四：事实D。",
      "小结五：事实E。"
    ]);

    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    const notices = postMessages.filter((m) => m.type === "notice");
    // 完成序不固定（08 起并发小结），断言进度文案集合而非顺序。
    expect(notices.map((n) => n.data).sort()).toEqual([
      "正在整理第 1/5 段（20%）",
      "正在整理第 2/5 段（40%）",
      "正在整理第 3/5 段（60%）",
      "正在整理第 4/5 段（80%）",
      "正在整理第 5/5 段（100%）"
    ]);

    const tokens = postMessages.filter((m) => m.type === "token");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].data).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(postMessages.some((m) => m.type === "done")).toBe(true);
    // done 出现在 token 之后
    const tokenIdx = postMessages.findIndex((m) => m.type === "token");
    const doneIdx = postMessages.findIndex((m) => m.type === "done");
    expect(doneIdx).toBeGreaterThan(tokenIdx);

    // 小结调用 5 次 + 成稿 1 次，共 6 次模型调用
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("小结 prompt 忠实压缩且保留时间戳（对齐蓝本 _chunk_prompt 措辞）", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    const userContents = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).messages.at(-1).content);
    const segmentPrompt = userContents.find((c) => c.includes("连续片段"));
    expect(segmentPrompt).toContain("视频标题：测试视频");
    expect(segmentPrompt).toContain("这是第 1/5 个连续片段");
    expect(segmentPrompt).toContain("请忠实压缩这个片段");
    expect(segmentPrompt).toContain("保留重要事实、例子、论证关系和原有时间点");
    expect(segmentPrompt).toContain("不做评价，不补充外部知识");
    // 时间戳以 [起点-终点] 拼入
    expect(segmentPrompt).toMatch(/\[0:00-0:05\]/);
  });

  it("成稿 prompt 对齐蓝本 _note_prompt：材料带「### 片段 i」标注，标题 # 视频笔记", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    const userContents = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).messages.at(-1).content);
    const notePrompt = userContents.find((c) => c.includes("视频笔记"));
    expect(notePrompt).toContain("写一份翔实、自然的 Markdown 视频笔记");
    expect(notePrompt).toContain("不要加入外部知识或评价");
    expect(notePrompt).toContain("标题使用：# 视频笔记：《测试视频》");
    expect(notePrompt).toContain("### 片段 1");
    expect(notePrompt).toContain("### 片段 2");
    expect(notePrompt).toContain("### 片段 3");
    expect(notePrompt).toContain("### 片段 4");
    expect(notePrompt).toContain("### 片段 5");
    expect(notePrompt).toContain("小结一：事实A。");
    expect(notePrompt).toContain("小结五：事实E。");
  });

  it("成稿输出 clamp 到 FINAL_OUTPUT_CHARS（16000）以内", async () => {
    const { fetchMock } = buildSequencedMock();
    const longDraft = "z".repeat(20000);
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      if (user.includes("连续片段")) {
        return jsonResponse({ choices: [{ message: { content: "小结" } }] });
      }
      return jsonResponse({ choices: [{ message: { content: longDraft } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });
    expect(result.draft.length).toBeLessThanOrEqual(16000);
    expect(result.draft).toBe(longDraft.slice(0, 16000));
    const tokenMsg = port.postMessage.mock.calls.map((c) => c[0]).find((m) => m.type === "token");
    expect(tokenMsg.data.length).toBeLessThanOrEqual(16000);
  });

  it("分段小结超 10k 时截断（clamp 到 SEGMENT_SUMMARY_CHARS）", async () => {
    const { fetchMock } = buildSequencedMock();
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      if (user.includes("连续片段")) {
        return jsonResponse({ choices: [{ message: { content: "q".repeat(12000) } }] });
      }
      return jsonResponse({ choices: [{ message: { content: "笔记" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });
    expect(result.segmentSummaries[0].length).toBeLessThanOrEqual(10000);
    expect(result.segmentSummaries[0]).toBe("q".repeat(10000));
  });
});

describe("orchestrateMapReduce 中止", () => {
  it("段间 abort：aborted=true、无 done、无最终 token", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const controller = new AbortController();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    // 第二段小结完成后中止
    let callCount = 0;
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      callCount += 1;
      if (user.includes("连续片段") && callCount === 2) {
        controller.abort();
      }
      if (user.includes("连续片段")) {
        return jsonResponse({ choices: [{ message: { content: "小结" } }] });
      }
      return jsonResponse({ choices: [{ message: { content: "笔记" } }] });
    });

    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context,
      plan,
      port,
      signal: controller.signal
    });

    expect(result.aborted).toBe(true);
    expect(result.draft).toBe("");
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
    expect(postMessages.some((m) => m.type === "token")).toBe(false);
    // 已完成的段进度正常回吐且不重复（完成序不固定，只断言无重复且都是合法进度文案）
    const notices = postMessages.filter((m) => m.type === "notice").map((n) => n.data);
    expect(new Set(notices).size).toBe(notices.length);
    for (const notice of notices) {
      expect(notice).toMatch(/^正在整理第 \d\/5 段（\d+%）$/);
    }
  });

  it("abort 抛出的错误不再 post error（静默收束，已回吐内容不串数据）", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const controller = new AbortController();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const abortError = new Error("已停止生成");
    abortError.aborted = true;
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      if (user.includes("连续片段") && user.includes("第 2/5")) {
        throw abortError;
      }
      if (user.includes("连续片段")) {
        return jsonResponse({ choices: [{ message: { content: "小结" } }] });
      }
      return jsonResponse({ choices: [{ message: { content: "笔记" } }] });
    });

    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context,
      plan,
      port,
      signal: controller.signal
    });

    expect(result.aborted).toBe(true);
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "error")).toBe(false);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
    // 中止收束：回吐 stopped（对齐 streamChat 的停止 UX），不串数据
    expect(postMessages.some((m) => m.type === "stopped")).toBe(true);
  });

  it("已 abort 的 signal 直接短路：一次模型调用都不发", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const controller = new AbortController();
    controller.abort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context,
      plan,
      port,
      signal: controller.signal
    });

    expect(result.aborted).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    // 中止收束：至多一条 stopped，绝无 done/token/error
    expect(postMessages.filter((m) => m.type === "stopped").length).toBeLessThanOrEqual(1);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
    expect(postMessages.some((m) => m.type === "token")).toBe(false);
    expect(postMessages.some((m) => m.type === "error")).toBe(false);
  });
});

describe("plan.mode==='map-reduce' 才编排（不归并/超预算判定）", () => {
  it("预算内 body（100k）→ mode=single，不进入编排", async () => {
    const { buildBudgetPlan } = await import("../../extension/ai/budgeter.js");
    const plan = buildBudgetPlan({ body: makeSubtitleBody(100000) });
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
  });

  it("200k 边界一越 → mode=map-reduce 且 needsReduce=false；500k 段数=10 不归并", async () => {
    const { buildBudgetPlan } = await import("../../extension/ai/budgeter.js");
    const single = buildBudgetPlan({ body: makeSubtitleBody(200000) });
    expect(single.mode).toBe("single");

    const over = buildBudgetPlan({ body: makeSubtitleBody(200001) });
    expect(over.mode).toBe("map-reduce");
    expect(over.needsReduce).toBe(false);

    const big = buildBudgetPlan({ body: makeSubtitleBody(500000) });
    expect(big.segments).toHaveLength(10);
    expect(big.needsReduce).toBe(false);
  });

  // shouldReduce / 归并层行为由 07 票在 tests/ai/reduce.test.js 覆盖；此处不再锁定空壳语义。
});

describe("缓存写入最终失败的上浮（LRU 淘汰后重试仍失败）", () => {
  it("存储写持续失败 → 经 port notice 上浮一次，编排不中断、照常成稿回吐", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    // 存储写入持续失败（模拟容量不足）：所有 save 都走「淘汰→重试→失败」链
    globalThis.chrome.storage.local.set.mockRejectedValue(new Error("quota"));
    const port = makePort();

    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");

    // 上浮恰好一次：notice 通道（与进度 notice 同型），其余只 logError
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    const cacheNotices = postMessages.filter(
      (m) => m.type === "notice" && String(m.data || "").includes("缓存写入失败")
    );
    expect(cacheNotices).toHaveLength(1);
    // 编排本体不受影响：token + done 照常回吐
    expect(postMessages.some((m) => m.type === "done")).toBe(true);
  });
});

describe("溢出放宽预算重跑（context-length 溢出的编排级兜底）", () => {
  // 溢出响应：HTTP 400 + context-length 文案（completion.js 判定 → makeOverflowError）。
  function overflowResponse() {
    return { ok: false, status: 400, text: async () => "maximum context length exceeded" };
  }

  // 依调用序分段/成稿 mock：segmentCalls 前 N 次溢出（模拟常态预算超模型窗口），
  // noteCalls 前 M 次溢出；其余按序返回小结/笔记。
  function buildOverflowSequencedMock({ overflowSegments = 0, overflowNotes = 0 } = {}) {
    let segmentCalls = 0;
    let noteCalls = 0;
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      if (user.includes("连续片段")) {
        segmentCalls += 1;
        if (segmentCalls <= overflowSegments) {
          return overflowResponse();
        }
        const m = user.match(/第 (\d+)\//);
        return jsonResponse({ choices: [{ message: { content: `小结${m ? Number(m[1]) : 1}。` } }] });
      }
      noteCalls += 1;
      if (noteCalls <= overflowNotes) {
        return overflowResponse();
      }
      return jsonResponse({ choices: [{ message: { content: "# 视频笔记：《测试视频》\n完整笔记正文。" } }] });
    });
    return { fetchMock, counters: { get segmentCalls() { return segmentCalls; }, get noteCalls() { return noteCalls; } } };
  }

  it("段小结溢出 → notice 告知 → 按 0.5 倍预算重切段整轮重跑 → 成功回吐一次", async () => {
    // 210k 字符：常态 50k 段 = 5 段；收紧 25k 段 = 9 段。溢出计数跨轮共享：
    // 首轮首波 3 个并发全溢出即 settle（剩余 2 段不再拉起），重跑 9 段全部成功。
    const { fetchMock } = buildOverflowSequencedMock({ overflowSegments: 3 });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });
    expect(plan.segments).toHaveLength(5);

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");

    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    // 重跑发起的 notice 恰好一条
    expect(postMessages.filter((m) => m.type === "notice" && String(m.data).includes("已自动调低单段素材量并重试"))).toHaveLength(1);
    // 成功回吐恰一次
    expect(postMessages.filter((m) => m.type === "done")).toHaveLength(1);
    expect(postMessages.filter((m) => m.type === "token")).toHaveLength(1);

    // 首轮首波 3 段（1/5）+ 重跑 9 段（1/9）+ 成稿 1 次 = 13 次调用
    expect(fetchMock).toHaveBeenCalledTimes(13);
    const userContents = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).messages.at(-1).content);
    expect(userContents.some((c) => c.includes("这是第 1/5 个连续片段"))).toBe(true);
    expect(userContents.some((c) => c.includes("这是第 1/9 个连续片段"))).toBe(true);
  });

  it("重跑仍溢出 → 带明确文案抛出（不静默），无 done/token", async () => {
    const { fetchMock } = buildOverflowSequencedMock({ overflowSegments: Infinity });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    await expect(
      mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port })
    ).rejects.toThrow("调低分段量后仍超出模型上下文");

    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "notice" && String(m.data).includes("已自动调低单段素材量并重试"))).toBe(true);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
    expect(postMessages.some((m) => m.type === "token")).toBe(false);
    // 首轮 5 段（并发 3：首波 3 个全溢出即 settle，剩余 2 段不再拉起）
    // + 重跑 9 段首波 3 个（同理）——绝不进入第三轮。
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("非溢出错误（HTTP 500）→ 原样上抛，不触发预算重跑", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "server error" })));
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    await expect(
      mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port })
    ).rejects.toThrow("HTTP 500");

    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "notice" && String(m.data).includes("已自动调低单段素材量并重试"))).toBe(false);
    expect(postMessages.some((m) => m.type === "done")).toBe(false);
  });

  it("成稿阶段溢出 → 已完成段不浪费判断，整轮重跑后成稿成功", async () => {
    // 首轮 5 段成功、成稿溢出 → 重跑 9 段（成功）+ 成稿成功 = 5+1+9+1 = 16 次。
    const { fetchMock } = buildOverflowSequencedMock({ overflowNotes: 1 });
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(fetchMock).toHaveBeenCalledTimes(16);
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.filter((m) => m.type === "done")).toHaveLength(1);
  });

  it("中止（aborted）不触发预算重跑：stopped 收束，无重试 notice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("已停止生成");
      e.aborted = true;
      throw e;
    }));
    const port = makePort();
    const controller = new AbortController();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({
      provider: makeProvider(),
      context,
      plan,
      port,
      signal: controller.signal
    });

    expect(result.aborted).toBe(true);
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "stopped")).toBe(true);
    expect(postMessages.some((m) => m.type === "notice" && String(m.data).includes("已自动调低单段素材量并重试"))).toBe(false);
  });
});

// presetId 穿线（02 号票，概览 Map-Reduce 链）：provider 记录的 presetId 随
// provider 对象穿过编排层抵达 chatCompletion → 请求构造单缝。反代 host 无规则
// + 模式表未列模型（org 限定 id）时，presetId（modelscope unknownClass）是唯一
// 识别线索——分段/成稿请求体出现 enable_thinking 即穿线判据。
describe("presetId 穿线（概览 Map-Reduce 链 → 请求体）", () => {
  it("provider 记录的 presetId 抵达分段与成稿请求体：反代 host 无规则也按 modelscope 出 enable_thinking", async () => {
    const { fetchMock } = buildSequencedMock();
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });

    const result = await mod.orchestrateMapReduce({
      provider: { baseUrl: "https://thinking-proxy.example.com/v1", model: "Qwen/Qwen3-32B", apiKey: "sk-test", presetId: "modelscope" },
      context,
      plan,
      port,
      thinkingLevel: "off"
    });

    expect(result.aborted).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body)).toMatchObject({ enable_thinking: false });
    }
  });
});

// arch-review-2026-09/03：溢出回落的预算档缓存隔离（_b50）编排级直测——
// segment-cache 单测只锁 key 形状，本用例锁「串档即串内容」的端到端语义：
// 常态档（scale=1）已落盘的小结绝不被 0.5 档重跑命中复用。
//（arch-review-2026-09/05：读写经 beforeEach 接线的 segment-cache 消息回路
// 落内存 storage，与生产同路径。）
describe("溢出重跑预算档隔离：_b50 不串常态档内容", () => {
  it("常态档已落盘小结不被 0.5 档重跑命中；两档 key 并存、内容各自", async () => {
    // 段缓存读写经消息回路落内存 storage（beforeEach 已接线）；本用例另取
    // segment-cache（SW 侧模块）拼期望键位做断言
    const storage = segmentCacheLoop.storage;
    const mr = mod;
    const sc = await import("../../extension/ai/segment-cache.js");

    const provider = makeProvider();
    const context = makeContext();
    const plan = (await import("../../extension/ai/budgeter.js")).buildBudgetPlan({
      body: context.subtitleBody,
      chapters: []
    });
    const firstIndex = plan.segments[0].index;

    // 第 1 轮：常态档 5 段全部成功，小结按无后缀 key 落盘
    const { fetchMock: okFetch } = buildSequencedMock();
    vi.stubGlobal("fetch", okFetch);
    const run1 = await mr.orchestrateMapReduce({ provider, context, plan, port: makePort() });
    expect(run1.aborted).toBe(false);
    const scale1Key = sc.buildSegmentSummaryCacheKey(context, firstIndex, 1);
    expect(scale1Key).not.toMatch(/_b\d+$/);
    expect(storage.map.get(scale1Key)?.summary).toBe("小结一：事实A。");

    // 第 2 轮：段小结全命中常态档缓存（合法同档复用，不调模型），成稿溢出 →
    // 按 0.5 档整轮重跑（9 段）。重跑段若串档会命中常态档缓存、不调模型。
    let noteCalls = 0;
    const overflowFetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[body.messages.length - 1]?.content || "";
      if (user.includes("连续片段")) {
        const m = user.match(/第 (\d+)\//);
        return jsonResponse({ choices: [{ message: { content: `收紧档小结${m ? Number(m[1]) : 1}。` } }] });
      }
      noteCalls += 1;
      if (noteCalls === 1) {
        return { ok: false, status: 400, text: async () => "maximum context length exceeded" };
      }
      return jsonResponse({ choices: [{ message: { content: "# 视频笔记：《测试视频》\n收紧档正文。" } }] });
    });
    vi.stubGlobal("fetch", overflowFetch);
    const run2 = await mr.orchestrateMapReduce({ provider, context, plan, port: makePort() });

    expect(run2.aborted).toBe(false);
    // 成稿溢出 1 次 + 重跑 9 段全部调模型（未命中常态档缓存）+ 成稿 1 次 = 11。
    expect(overflowFetch).toHaveBeenCalledTimes(11);

    // 两档 key 并存、内容各自：常态档未被覆写，_b50 档是重跑产物
    const b50Key = sc.buildSegmentSummaryCacheKey(context, firstIndex, 0.5);
    expect(b50Key).toMatch(/_b50$/);
    expect(storage.map.get(scale1Key)?.summary).toBe("小结一：事实A。");
    expect(storage.map.get(b50Key)?.summary).toBe("收紧档小结1。");
    // 成稿材料来自收紧档小结（不串常态档内容）
    expect(run2.draft).toBe("# 视频笔记：《测试视频》\n收紧档正文。");
    expect(run2.segmentSummaries).toContain("收紧档小结1。");
    expect(run2.segmentSummaries).not.toContain("小结一：事实A。");
  });
});
