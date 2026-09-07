// bilibili/gateway.ts 直测（arch-slim-2/05 测试网，整域此前零测试）。
//
// transport 参数已注入，全部用假 transport 直测，不发真实 fetch / runtime 消息。
// 覆盖：
// - fetchSubtitleBundle 主备源回退三形态（工单 acceptance）：主成有字幕 /
//   主成无字幕（不跨源兜底）/ 主败落次来源；
// - fetchVideoMeta 字段映射（pages / pubdate→uploadDate 归一 / code!=0 报错）；
// - isBiliUrl 边界（非字符串 / 空 / 带端口 / 伪装域）。
//
// 被测函数虽经 logInfo/logWarn（shared/logging，debug 关闭时零输出），但无
// DOM/chrome 依赖，真实模块直接导入即可。

import { describe, expect, it, vi } from "vitest";
import {
  fetchHotCommentsWithLedger,
  fetchSubtitleBundle,
  fetchVideoMeta,
  isBiliUrl
} from "../../extension/bilibili/gateway.js";
import { clipState } from "../../extension/core/state.js";
import { formatLocalDate } from "../../extension/shared/utils.js";

// 假 transport：按 URL 子串路由到预设载荷/异常，并记录调用轨迹（供次数与顺序断言）
function fakeTransport(routes) {
  const calls = [];
  const transport = vi.fn(async (url) => {
    calls.push(url);
    const route = routes.find(([match]) => url.includes(match));
    if (!route) {
      throw new Error(`unexpected url: ${url}`);
    }
    const handler = route[1];
    return typeof handler === "function" ? handler(url) : handler;
  });
  transport.calls = calls;
  return transport;
}

const wbiMatch = "x/player/wbi/v2";
const v2Match = "x/player/v2";

function subtitlePayload(subtitles, viewPoints = []) {
  return { code: 0, data: { subtitle: { subtitles }, view_points: viewPoints } };
}

function track(id, url) {
  return { id, lan: "zh-CN", lan_doc: "中文", subtitle_url: url };
}

const viewPoints = [
  { content: "开场", from: 0, to: 30 },
  { content: "正题", from: 30, to: 60 }
];

const withAid = { bvid: "BV1abcDEFghi", cid: "42", aid: "123" };
const noAid = { bvid: "BV1abcDEFghi", cid: "42" };

describe("fetchSubtitleBundle：主备源回退三形态", () => {
  it("形态1 主来源成功且有字幕：直接返回主来源轨道与章节，不请求次来源", async () => {
    const transport = fakeTransport([
      [wbiMatch, subtitlePayload([track(9, "//i0.hdslb.com/bfs/a.json")], viewPoints)]
    ]);

    const result = await fetchSubtitleBundle(transport, withAid);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.calls[0]).toContain(wbiMatch);
    expect(result.tracks).toEqual([
      { id: "9", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://i0.hdslb.com/bfs/a.json", source: "player-wbi-v2" }
    ]);
    expect(result.chapters).toEqual([
      { title: "开场", from: 0, to: 30, source: "player-view-points" },
      { title: "正题", from: 30, to: 60, source: "player-view-points" }
    ]);
  });

  it("形态2 主来源成功但无字幕：直接判定无字幕（tracks 空），不跨源兜底", async () => {
    const transport = fakeTransport([
      [wbiMatch, subtitlePayload([], viewPoints)],
      [v2Match, subtitlePayload([track(8, "//i0.hdslb.com/bfs/b.json")])]
    ]);

    const result = await fetchSubtitleBundle(transport, withAid);

    // 主来源成功返回（code=0）但字幕为空：次来源绝不能被触发
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.calls[0]).toContain(wbiMatch);
    expect(result.tracks).toEqual([]);
    expect(result.chapters).toEqual([
      { title: "开场", from: 0, to: 30, source: "player-view-points" },
      { title: "正题", from: 30, to: 60, source: "player-view-points" }
    ]);
  });

  it("形态3 主来源请求失败：落次来源（player-v2），轨道 source 标记为次来源", async () => {
    const transport = fakeTransport([
      [wbiMatch, () => Promise.reject(new Error("HTTP 412"))],
      [v2Match, subtitlePayload([track(8, "//i0.hdslb.com/bfs/b.json")], viewPoints)]
    ]);

    const result = await fetchSubtitleBundle(transport, withAid);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.calls[0]).toContain(wbiMatch);
    expect(transport.calls[1]).toContain(v2Match);
    expect(result.tracks).toEqual([
      { id: "8", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://i0.hdslb.com/bfs/b.json", source: "player-v2" }
    ]);
    expect(result.chapters.map((c) => c.title)).toEqual(["开场", "正题"]);
  });

  it("形态3 变体：主来源返回业务错误码（code!=0）同样触发次来源兜底", async () => {
    const transport = fakeTransport([
      [wbiMatch, { code: -404, message: "啥都木有" }],
      [v2Match, subtitlePayload([track(8, "//i0.hdslb.com/bfs/b.json")])]
    ]);

    const result = await fetchSubtitleBundle(transport, withAid);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].source).toBe("player-v2");
  });

  it("主败落次但次来源也无字幕：返回空轨道与次来源章节", async () => {
    const transport = fakeTransport([
      [wbiMatch, () => Promise.reject(new Error("HTTP 412"))],
      [v2Match, subtitlePayload([], viewPoints)]
    ]);

    const result = await fetchSubtitleBundle(transport, withAid);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.tracks).toEqual([]);
    expect(result.chapters.map((c) => c.title)).toEqual(["开场", "正题"]);
  });

  it("主败且无次来源（无 aid 时仅 player-v2 一个请求）：原样上抛主来源错误", async () => {
    const transport = fakeTransport([
      [v2Match, () => Promise.reject(new Error("HTTP 502"))]
    ]);

    await expect(fetchSubtitleBundle(transport, noAid)).rejects.toThrow("HTTP 502");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("主败且次来源也失败：上抛次来源错误", async () => {
    const transport = fakeTransport([
      [wbiMatch, () => Promise.reject(new Error("primary down"))],
      [v2Match, () => Promise.reject(new Error("secondary down"))]
    ]);

    await expect(fetchSubtitleBundle(transport, withAid)).rejects.toThrow("secondary down");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("主来源有字幕但 subtitleUrl 全空（withUrl 过滤后为空）：按无字幕处理且不跨源", async () => {
    const transport = fakeTransport([
      [wbiMatch, subtitlePayload([track(9, "")], [])],
      [v2Match, subtitlePayload([track(8, "//i0.hdslb.com/bfs/b.json")])]
    ]);

    const result = await fetchSubtitleBundle(transport, withAid);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.tracks).toEqual([]);
  });
});

describe("fetchVideoMeta：字段映射", () => {
  it("code=0：aid/标题/作者/描述/cid/duration 映射，pages 逐项归一", async () => {
    const transport = fakeTransport([
      [
        "x/web-interface/view",
        {
          code: 0,
          data: {
            aid: 999,
            title: "  测试标题  ",
            owner: { name: "UP主" },
            desc: "视频简介",
            pubdate: 1767225600,
            cid: 777,
            duration: 321,
            pages: [
              { cid: 111, page: 1, part: "第一P  ", duration: 100 },
              { cid: 222, page: 2, part: "第二P", duration: 221 }
            ]
          }
        }
      ]
    ]);

    const meta = await fetchVideoMeta(transport, "BV1abcDEFghi");

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.calls[0]).toBe("https://api.bilibili.com/x/web-interface/view?bvid=BV1abcDEFghi");
    expect(meta.aid).toBe("999");
    expect(meta.title).toBe("  测试标题  ");
    expect(meta.author).toBe("UP主");
    expect(meta.description).toBe("视频简介");
    expect(meta.defaultCid).toBe("777");
    expect(meta.defaultDuration).toBe(321);
    // pubdate 秒 → 本地日期串（口径单源 shared/utils.formatLocalDate）
    expect(meta.uploadDate).toBe(formatLocalDate(1767225600 * 1000));
    expect(meta.uploadDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meta.pages).toEqual([
      { cid: "111", page: 1, part: "第一P", duration: 100 },
      { cid: "222", page: 2, part: "第二P", duration: 221 }
    ]);
  });

  it("pubdate 缺失/为 0：uploadDate 落空串", async () => {
    const transport = fakeTransport([["x/web-interface/view", { code: 0, data: { aid: 1 } }]]);

    const meta = await fetchVideoMeta(transport, "BV1x");

    expect(meta.uploadDate).toBe("");
    expect(meta.defaultCid).toBe("");
    expect(meta.pages).toEqual([]);
  });

  it("code!=0：抛出接口 message，message 缺失时回落「无法获取视频信息」", async () => {
    const transport = fakeTransport([["x/web-interface/view", { code: -404, message: "稿件不可见" }]]);
    await expect(fetchVideoMeta(transport, "BV1x")).rejects.toThrow("稿件不可见");

    const silentTransport = fakeTransport([["x/web-interface/view", { code: -400 }]]);
    await expect(fetchVideoMeta(silentTransport, "BV1x")).rejects.toThrow("无法获取视频信息");
  });
});

describe("isBiliUrl 边界", () => {
  it("B 站 API 域与 hdslb 子域为 true", () => {
    expect(isBiliUrl("https://api.bilibili.com/x/player/v2?bvid=BV1x")).toBe(true);
    expect(isBiliUrl("https://i0.hdslb.com/bfs/subtitle/a.json")).toBe(true);
  });

  it("非字符串与空输入为 false（不抛错）", () => {
    expect(isBiliUrl(null)).toBe(false);
    expect(isBiliUrl(undefined)).toBe(false);
    expect(isBiliUrl(123)).toBe(false);
    expect(isBiliUrl({})).toBe(false);
    expect(isBiliUrl("")).toBe(false);
  });

  it("带端口的 B 站域仍按 hostname 判定为 true（端口不参与 hostname）", () => {
    expect(isBiliUrl("https://api.bilibili.com:8080/x/player/v2")).toBe(true);
    expect(isBiliUrl("https://i0.hdslb.com:443/bfs/a.json")).toBe(true);
  });

  it("伪装域与非法串为 false", () => {
    // 路径里出现 B 站域名不算
    expect(isBiliUrl("https://evil.com/api.bilibili.com/x")).toBe(false);
    // B 站域名作后缀的钓鱼域不算
    expect(isBiliUrl("https://api.bilibili.com.evil.com/x")).toBe(false);
    expect(isBiliUrl("https://bilibili.com/x")).toBe(false);
    expect(isBiliUrl("not a url")).toBe(false);
    expect(isBiliUrl("//i0.hdslb.com/a.json")).toBe(false);
  });
});

// fetchHotCommentsWithLedger（arch-review-2026-09/07 编排单源）：message-handler
// 的 reader-get-hot-comments 与 context-assembly 缺省热评实现共用的
// 「aid 判空 → fetchHotComments(20) → clipState 落账 → 失败降级空列表 + note」。
// deps 全注入（ledger/aid/拉取替身），另有一条缺省 deps 接线对账（落账到真实
// core/state 的 clipState）。
describe("fetchHotCommentsWithLedger：热评编排单源", () => {
  function makeDeps({ aid = "100", comments = [], fetchError = null } = {}) {
    const ledger = { setHotComments: vi.fn() };
    const deps = {
      clipState: ledger,
      getCurrentAid: vi.fn(() => aid),
      fetchHotComments: vi.fn(async () => {
        if (fetchError) throw fetchError;
        return comments;
      })
    };
    return { ledger, deps };
  }

  it("有 aid：fetchHotComments(20) 拉取 + 落账 comments + 返回 {comments}（无 note）", async () => {
    const comments = [{ uname: "u", message: "m" }];
    const { ledger, deps } = makeDeps({ comments });

    const outcome = await fetchHotCommentsWithLedger(deps);

    expect(deps.fetchHotComments).toHaveBeenCalledWith(20);
    expect(ledger.setHotComments).toHaveBeenCalledWith(comments);
    expect(outcome).toEqual({ comments });
  });

  it("无 aid：不拉取，落账清空 + 空列表 + note「无法获取视频 aid」", async () => {
    const { ledger, deps } = makeDeps({ aid: "" });

    const outcome = await fetchHotCommentsWithLedger(deps);

    expect(deps.fetchHotComments).not.toHaveBeenCalled();
    expect(ledger.setHotComments).toHaveBeenCalledWith([]);
    expect(outcome).toEqual({ comments: [], note: "无法获取视频 aid" });
  });

  it("拉取失败：落账清空 + 空列表 + note 带错误 message（不抛错）", async () => {
    const { ledger, deps } = makeDeps({ fetchError: new Error("网络错误") });

    const outcome = await fetchHotCommentsWithLedger(deps);

    expect(ledger.setHotComments).toHaveBeenCalledWith([]);
    expect(outcome.comments).toEqual([]);
    expect(outcome.note).toContain("网络错误");
  });

  it("缺省 deps：落账接线到 core/state 的 clipState", async () => {
    const spy = vi.spyOn(clipState, "setHotComments").mockImplementation(() => {});
    try {
      const comments = [{ uname: "u", message: "m" }];
      const outcome = await fetchHotCommentsWithLedger({
        getCurrentAid: () => 100,
        fetchHotComments: async () => comments
      });
      expect(spy).toHaveBeenCalledWith(comments);
      expect(outcome).toEqual({ comments });
    } finally {
      spy.mockRestore();
    }
  });
});
