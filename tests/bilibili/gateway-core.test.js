// bilibili/gateway-core.ts 直测（arch-slim-2/04 拆叶）。
//
// 两层锁定：
// 1. 叶子约束（源码扫描）：gateway-core.ts 不含任何 import——静态、动态、
//    re-export 一律不允许，只准依赖平台全局（URL/Headers/fetch）。这是
//    ADR-0003「拆静态边」的防回内联锁：SW（entry/background.ts）静态图经它
//    只该拿到 isBiliUrl + bgFetchJson；scripts/build.js 的 35KB 守卫防的正是
//    缓存链（state/video-probe/selection→cache→cache-lru）经此回内联。
// 2. 行为语义锁定：bgFetchJson 的头部/凭据/referrer 语义拆叶前后零变化；
//    isBiliUrl 边界另有 gateway.test.js 经 gateway re-export 的既有用例。
//
// Headers stub 说明：实现以 (headers as { size }).size > 0 探测是否附加头部，
// 而真实平台的 Headers 均无 size 属性（Chrome Fetch Standard 与 Node undici 皆
// 无），探针恒 false——既有实现细节，本票逐字保留（见票 Comments）。测试用带
// size 的 Map 子类替身，跨环境确定地覆盖「探针为真 → 附加」分支并断言头部
// 集合构造语义；替身只换 Headers 实现，被测代码路径不变。

import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { bgFetchJson, isBiliUrl } from "../../extension/bilibili/gateway-core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, "../../extension/bilibili/gateway-core.ts"), "utf8");

// 带 size 的 Headers 替身（Map 子类，键小写归一，语义对齐 Fetch Standard）
class FakeHeaders extends Map {
  set(key, value) {
    super.set(String(key).toLowerCase(), value);
    return this;
  }
  get(key) {
    return super.get(String(key).toLowerCase()) ?? null;
  }
}

function okResponse(payload) {
  return { ok: true, json: async () => payload };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gateway-core 叶子约束（源码扫描）", () => {
  it("源码零 import：静态/动态/re-export 均不允许（不拖入任何 extension/ 模块）", () => {
    expect(source).not.toMatch(/(^|\n)\s*import[\s("']/);
    expect(source).not.toMatch(/\bfrom\s+["']/);
    expect(source).not.toMatch(/require\s*\(/);
  });
});

describe("isBiliUrl（拆叶后语义不变）", () => {
  it("B 站 API 域与 hdslb 子域为 true；伪装域与其余输入为 false", () => {
    expect(isBiliUrl("https://api.bilibili.com/x/player/v2?bvid=BV1x")).toBe(true);
    expect(isBiliUrl("https://i0.hdslb.com/bfs/subtitle/a.json")).toBe(true);
    expect(isBiliUrl("https://api.bilibili.com:8080/x/player/v2")).toBe(true);
    expect(isBiliUrl("https://api.bilibili.com.evil.com/x")).toBe(false);
    expect(isBiliUrl("https://example.com/x")).toBe(false);
    expect(isBiliUrl(null)).toBe(false);
    expect(isBiliUrl("")).toBe(false);
    expect(isBiliUrl("not a url")).toBe(false);
  });
});

describe("bgFetchJson（拆叶后头部/凭据语义逐字不变）", () => {
  it("B 站 URL：附加 B 站请求头与 referrer，credentials include / no-store", async () => {
    const fetchMock = vi.fn(async () => okResponse({ code: 0 }));
    vi.stubGlobal("Headers", FakeHeaders);
    vi.stubGlobal("fetch", fetchMock);

    const data = await bgFetchJson("https://api.bilibili.com/x/web-interface/view?bvid=BV1x");

    expect(data).toEqual({ code: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.bilibili.com/x/web-interface/view?bvid=BV1x");
    expect(options.method).toBe("GET");
    expect(options.credentials).toBe("include");
    expect(options.cache).toBe("no-store");
    expect(options.headers.get("accept")).toBe("application/json, text/plain, */*");
    expect(options.headers.get("accept-language")).toBe("zh-CN,zh;q=0.9,en;q=0.8");
    expect(options.headers.get("cache-control")).toBe("no-cache");
    expect(options.headers.get("pragma")).toBe("no-cache");
    expect(options.referrer).toBe("https://www.bilibili.com/");
    expect(options.referrerPolicy).toBe("strict-origin-when-cross-origin");
  });

  it("非 B 站 URL：不附加头部与 referrer，method/credentials/cache 保持", async () => {
    const fetchMock = vi.fn(async () => okResponse({ fine: true }));
    vi.stubGlobal("Headers", FakeHeaders);
    vi.stubGlobal("fetch", fetchMock);

    await bgFetchJson("https://example.com/api");

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).toBeUndefined();
    expect(options.referrer).toBeUndefined();
    expect(options.referrerPolicy).toBeUndefined();
    expect(options.method).toBe("GET");
    expect(options.credentials).toBe("include");
    expect(options.cache).toBe("no-store");
  });

  it("响应非 ok：抛 HTTP <status>", async () => {
    vi.stubGlobal("Headers", FakeHeaders);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 412 })));

    await expect(bgFetchJson("https://api.bilibili.com/x")).rejects.toThrow("HTTP 412");
  });
});
