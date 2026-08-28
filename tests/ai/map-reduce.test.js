// ai/map-reduce.js 编排测试（03 票）：
// 覆盖切片→小结→成稿编排（进度序号与百分比、token/done 回吐）、中止、
// 溢出兜底哨兵（streamChat）、进度纯函数，以及单次路径 plan 判定。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, makeSubtitleBody } from "../setup.js";

let mod;
let streamChatMod;

async function importModules() {
  vi.resetModules();
  resetModuleState();
  mod = await import("../../extension/ai/map-reduce.js");
  streamChatMod = await import("../../extension/ai/client.js");
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
    subtitleBody: makeSubtitleBody(110000),
    subtitleMarkdown: "x".repeat(110000),
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
  const summaryTexts = { 1: "小结一：事实A。", 2: "小结二：事实B。", 3: "小结三：事实C。" };
  const fetchMock = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages[body.messages.length - 1]?.content || "";
    const isChunk = user.includes("连续片段");
    if (isChunk) {
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
    expect(plan.segments).toHaveLength(3);

    const result = await mod.orchestrateMapReduce({ provider: makeProvider(), context, plan, port });

    expect(result.aborted).toBe(false);
    expect(result.draft).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(result.segmentSummaries).toEqual(["小结一：事实A。", "小结二：事实B。", "小结三：事实C。"]);

    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    const notices = postMessages.filter((m) => m.type === "notice");
    // 完成序不固定（08 起并发小结），断言进度文案集合而非顺序。
    expect(notices.map((n) => n.data).sort()).toEqual([
      "正在整理第 1/3 段（33%）",
      "正在整理第 2/3 段（67%）",
      "正在整理第 3/3 段（100%）"
    ]);

    const tokens = postMessages.filter((m) => m.type === "token");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].data).toBe("# 视频笔记：《测试视频》\n完整笔记正文。");
    expect(postMessages.some((m) => m.type === "done")).toBe(true);
    // done 出现在 token 之后
    const tokenIdx = postMessages.findIndex((m) => m.type === "token");
    const doneIdx = postMessages.findIndex((m) => m.type === "done");
    expect(doneIdx).toBeGreaterThan(tokenIdx);

    // 小结调用 3 次 + 成稿 1 次，共 4 次模型调用
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    const chunkPrompt = userContents.find((c) => c.includes("连续片段"));
    expect(chunkPrompt).toContain("视频标题：测试视频");
    expect(chunkPrompt).toContain("这是第 1/3 个连续片段");
    expect(chunkPrompt).toContain("请忠实压缩这个片段");
    expect(chunkPrompt).toContain("保留重要事实、例子、论证关系和原有时间点");
    expect(chunkPrompt).toContain("不做评价，不补充外部知识");
    // 时间戳以 [起点-终点] 拼入
    expect(chunkPrompt).toMatch(/\[00:00-00:05\]/);
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
    expect(notePrompt).toContain("小结一：事实A。");
    expect(notePrompt).toContain("小结三：事实C。");
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
      expect(notice).toMatch(/^正在整理第 \d\/3 段（\d+%）$/);
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
      if (user.includes("连续片段") && user.includes("第 2/3")) {
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

describe("streamChat 溢出兜底哨兵", () => {
  it("HTTP 400 body 含 maximum context length → return 'overflow'，不再 post overflow/error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => "This model's maximum context length is 8192 tokens, but you requested 12000 tokens.",
      json: async () => ({})
    })));
    const port = makePort();

    const result = await streamChatMod.streamChat({
      provider: makeProvider(),
      context: { title: "t", subtitleMarkdown: "x".repeat(100), subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toBe("overflow");
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it("超预算（>100k）→ 仍发 notice 提示 + return 'overflow' 哨兵", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const port = makePort();
    const context = makeContext(); // 110k body

    const result = await streamChatMod.streamChat({
      provider: makeProvider(),
      context,
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).toBe("overflow");
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "notice")).toBe(true);
    expect(postMessages.some((m) => m.type === "overflow")).toBe(false);
    // 超预算直接返回，不发任何请求
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("普通错误仍走既有报错路径（return undefined + post error），不误判为 overflow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
      json: async () => ({})
    })));
    const port = makePort();

    const result = await streamChatMod.streamChat({
      provider: makeProvider(),
      context: { title: "t", subtitleMarkdown: "x".repeat(100), subtitleBody: [] },
      userPrompt: "总结",
      history: [],
      port
    });

    expect(result).not.toBe("overflow");
    const postMessages = port.postMessage.mock.calls.map((c) => c[0]);
    expect(postMessages.some((m) => m.type === "error")).toBe(true);
  });
});

describe("plan.mode==='map-reduce' 才编排（不归并/超预算判定）", () => {
  it("预算内 body（100k）→ mode=single，不进入编排", async () => {
    const { buildBudgetPlan } = await import("../../extension/ai/budgeter.js");
    const plan = buildBudgetPlan({ body: makeSubtitleBody(100000) });
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
  });

  it("100k 边界一越 → mode=map-reduce 且 needsMerge=false；500k 段数=10 不归并", async () => {
    const { buildBudgetPlan } = await import("../../extension/ai/budgeter.js");
    const single = buildBudgetPlan({ body: makeSubtitleBody(100000) });
    expect(single.mode).toBe("single");

    const over = buildBudgetPlan({ body: makeSubtitleBody(100001) });
    expect(over.mode).toBe("map-reduce");
    expect(over.needsMerge).toBe(false);

    const big = buildBudgetPlan({ body: makeSubtitleBody(500000) });
    expect(big.segments).toHaveLength(10);
    expect(big.needsMerge).toBe(false);
  });

  // shouldMerge / 归并层行为由 07 票在 tests/ai/merge.test.js 覆盖；此处不再锁定空壳语义。
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
