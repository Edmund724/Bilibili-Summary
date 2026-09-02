// ai/context-resolver.js 的 chapters 断供修复回归测试：
// resolveAiConversationContext 内部早已拿到 subtitleBundle.chapters 用于渲染
// markdown 的「## 章节」分节，但返回值此前不透传 chapters——侧边栏恢复历史
// 会话（resolvedContext / contextRef）后章节对齐切段与追问章节名检索双双失明。
// 修复后返回值带 chapters（与渲染 markdown 同一来源），此测试锁定透传行为。
// 单纪元：不使用 vi.resetModules，vi.mock 工厂闭包全程有效。

import { describe, expect, it, vi } from "vitest";

vi.mock("../../extension/bilibili/gateway.js", () => ({
  fetchVideoMeta: vi.fn(async () => ({
    title: "测试视频",
    author: "UP主",
    uploadDate: "2026-01-01",
    aid: "42",
    defaultCid: "101",
    defaultDuration: 600,
    pages: [{ cid: "101", page: 1, part: "P1", duration: 600 }]
  })),
  fetchSubtitleBundle: vi.fn(async () => ({
    tracks: [
      { id: "sub-1", subtitleUrl: "https://s.example.com/1.json", lan: "zh-CN", lanDoc: "中文" }
    ],
    chapters: [
      { title: "开场", from: 0, to: 60, source: "player-view-points" },
      { title: "正文", from: 60, to: 600, source: "player-view-points" }
    ]
  })),
  // 现代签名：fetchSubtitleBody(url) 返回 { body }（工单 04 起 context-resolver
  // 按现代契约调用，legacy 形状垫片已删）。
  fetchSubtitleBody: vi.fn(async () => ({ body: [{ from: 0, to: 5, content: "第一句" }] })),
  fetchHotComments: vi.fn(async () => []),
  bgFetchJson: vi.fn(),
  isBiliUrl: vi.fn(() => true)
}));

vi.mock("../../extension/core/settings-store.js", () => ({
  getMergedSettings: vi.fn(async () => ({ includeTimestampInBody: false }))
}));

vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getSubtitleCacheKey: vi.fn(() => "subtitle-cache-key"),
  loadSubtitleFromCache: vi.fn(async () => null)
}));

import { resolveAiConversationContext } from "../../extension/ai/context-resolver.js";
import { fetchSubtitleBundle } from "../../extension/bilibili/gateway.js";

const CONTEXT_REF = {
  title: "入口标题",
  url: "https://www.bilibili.com/video/BV1chapters/",
  bvid: "BV1chapters"
};

describe("resolveAiConversationContext chapters 透传", () => {
  it("返回值携带字幕 bundle 的章节（与渲染 markdown 同一来源）", async () => {
    const result = await resolveAiConversationContext(CONTEXT_REF);

    expect(result.isVideoContext).toBe(true);
    expect(result.bvid).toBe("BV1chapters");
    // 章节透传且与 fetchSubtitleBundle 返回值全等
    expect(result.chapters).toEqual([
      { title: "开场", from: 0, to: 60, source: "player-view-points" },
      { title: "正文", from: 60, to: 600, source: "player-view-points" }
    ]);
    // 确实来自字幕 bundle（背景侧唯一章节来源）
    expect(fetchSubtitleBundle).toHaveBeenCalledTimes(1);
    // 协议不再携带预渲染 markdown：改为透传渲染所需输入（body/chapters/
    // videoDuration/includeTimestampInBody），发送物由 ai/subtitle-prompt.js
    // 的 buildSubtitlePrompt 在发 prompt 前现场渲染。
    expect(result.subtitleBody).toEqual([{ from: 0, to: 5, content: "第一句" }]);
    expect(result.videoDuration).toBe(600);
    expect(result.includeTimestampInBody).toBe(false);
  });

  it("bundle 无章节 → chapters 为空数组（非 undefined）", async () => {
    fetchSubtitleBundle.mockResolvedValueOnce({
      tracks: [{ id: "sub-1", subtitleUrl: "https://s.example.com/1.json", lan: "zh-CN", lanDoc: "中文" }],
      chapters: []
    });

    const result = await resolveAiConversationContext(CONTEXT_REF);
    expect(result.chapters).toEqual([]);
  });

  it("bundle 章节为脏值（非数组）→ chapters 回落空数组", async () => {
    fetchSubtitleBundle.mockResolvedValueOnce({
      tracks: [{ id: "sub-1", subtitleUrl: "https://s.example.com/1.json", lan: "zh-CN", lanDoc: "中文" }],
      chapters: undefined
    });

    const result = await resolveAiConversationContext(CONTEXT_REF);
    expect(result.chapters).toEqual([]);
  });
});
