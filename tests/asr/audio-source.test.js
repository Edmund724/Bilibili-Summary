// audio-source.js 单测：DASH 音轨选择（bandwidth 最小）、URL 组装、无音轨报错。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let fetchMock;

async function loadModule() {
  return import("../../extension/asr/audio-source.js");
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
});

function audioTrack(id, bandwidth, baseUrl, backupUrl = []) {
  const track = { id, bandwidth, baseUrl };
  if (backupUrl.length > 0) {
    track.backupUrl = backupUrl;
  }
  return track;
}

function buildDashData(audio) {
  return { audio };
}

describe("selectAudioTrack", () => {
  it("多条 audio 选 bandwidth 最小的一条", async () => {
    const { selectAudioTrack } = await loadModule();
    const result = selectAudioTrack(
      buildDashData([
        audioTrack(30232, 192000, "https://upx.bilivideo.com/audio-192.m4s"),
        audioTrack(30216, 64800, "https://upx.bilivideo.com/audio-64.m4s"),
        audioTrack(30280, 320000, "https://upx.bilivideo.com/audio-320.m4s")
      ])
    );
    expect(result.url).toBe("https://upx.bilivideo.com/audio-64.m4s");
    expect(result.backupUrls).toEqual([]);
  });

  it("bandwidth 相同时保持原顺序，取第一条", async () => {
    const { selectAudioTrack } = await loadModule();
    const result = selectAudioTrack(
      buildDashData([
        audioTrack(30216, 64800, "https://upx.bilivideo.com/a.m4s"),
        audioTrack(30216, 64800, "https://upx.bilivideo.com/b.m4s")
      ])
    );
    expect(result.url).toBe("https://upx.bilivideo.com/a.m4s");
  });

  it("backupUrl 列表原样透出", async () => {
    const { selectAudioTrack } = await loadModule();
    const backups = ["https://upx.bilivideo.com/bak-1.m4s", "https://upx.bilivideo.com/bak-2.m4s"];
    const result = selectAudioTrack(
      buildDashData([audioTrack(30216, 64800, "https://upx.bilivideo.com/a.m4s", backups)])
    );
    expect(result.backupUrls).toEqual(backups);
  });

  it("dash 缺失（undefined）抛指定文案", async () => {
    const { selectAudioTrack } = await loadModule();
    expect(() => selectAudioTrack(undefined)).toThrow("该视频没有可用音轨，无法语音识别");
  });

  it("audio 为空数组抛指定文案", async () => {
    const { selectAudioTrack } = await loadModule();
    expect(() => selectAudioTrack(buildDashData([]))).toThrow(
      "该视频没有可用音轨，无法语音识别"
    );
  });

  it("audio 非数组（纯图文视频无音轨字段）抛指定文案", async () => {
    const { selectAudioTrack } = await loadModule();
    expect(() => selectAudioTrack(buildDashData(null))).toThrow(
      "该视频没有可用音轨，无法语音识别"
    );
  });
});

describe("buildPlayurlUrl", () => {
  it("按 bvid/cid 组装参数，fnval=16 platform=html5 high_quality=1", async () => {
    const { buildPlayurlUrl } = await loadModule();
    const url = buildPlayurlUrl("BV1xx411c7mD", "12345");
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("api.bilibili.com");
    expect(parsed.pathname).toBe("/x/player/playurl");
    expect(parsed.searchParams.get("bvid")).toBe("BV1xx411c7mD");
    expect(parsed.searchParams.get("cid")).toBe("12345");
    expect(parsed.searchParams.get("fnval")).toBe("16");
    expect(parsed.searchParams.get("platform")).toBe("html5");
    expect(parsed.searchParams.get("high_quality")).toBe("1");
  });
});

describe("getSourceAudioUrl", () => {
  it("走注入 transport 请求 playurl 并选最小 bandwidth 音轨", async () => {
    const { getSourceAudioUrl } = await loadModule();
    const transport = vi.fn(async () => ({
      code: 0,
      data: {
        dash: {
          audio: [
            audioTrack(30280, 320000, "https://upx.bilivideo.com/audio-320.m4s"),
            audioTrack(30216, 64800, "https://upx.bilivideo.com/audio-64.m4s")
          ]
        }
      }
    }));
    const result = await getSourceAudioUrl({ bvid: "BV1xx411c7mD", cid: "12345" }, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    const url = new URL(transport.mock.calls[0][0]);
    expect(url.hostname).toBe("api.bilibili.com");
    expect(url.searchParams.get("bvid")).toBe("BV1xx411c7mD");
    expect(url.searchParams.get("cid")).toBe("12345");
    expect(result.url).toBe("https://upx.bilivideo.com/audio-64.m4s");
  });

  it("playurl 返回非 0 code 时抛接口错误", async () => {
    const { getSourceAudioUrl } = await loadModule();
    const transport = vi.fn(async () => ({ code: -404, message: "啥都木有" }));
    await expect(getSourceAudioUrl({ bvid: "b", cid: "c" }, transport)).rejects.toThrow("啥都木有");
  });

  it("接口成功但无音轨时抛指定文案", async () => {
    const { getSourceAudioUrl } = await loadModule();
    const transport = vi.fn(async () => ({ code: 0, data: { dash: { audio: [] } } }));
    await expect(getSourceAudioUrl({ bvid: "b", cid: "c" }, transport)).rejects.toThrow(
      "该视频没有可用音轨，无法语音识别"
    );
  });
});
