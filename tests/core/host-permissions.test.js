// core/host-permissions.js（S2 按需申请 host 权限的纯逻辑层）测试。
// 覆盖：
// - origin 提取与去重（collectOrigins）：baseUrl → origin，含非法/边界情形（空串、
//   非 http(s)、解析失败、端口保留、带 path 的 baseUrl）；
// - 保存手势链上的批量申请（requestProviderOrigins）：一次手势只发一次 request
//   （多平台合并成单次调用）、授权通过 → ok、拒绝 → 明确错误不静默、异常与缺失
//   chrome API 的兜底、无 origin 可申请时连 request 都不发；
// - 探针预检（hasHostPermission）：已授权/未授权/取不到 chrome.permissions；
// - 删除时 origin 回收判定（collectOrphanOrigins / revokeOrphanOrigin）：无主才回收、
//   仍被 AI/ASR 任一 provider 使用则不回收、被删行自身按 id 剔除、回收失败回报。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  extractOriginFromBaseUrl,
  collectOrigins,
  requestProviderOrigins,
  hasHostPermission,
  collectOrphanOrigins,
  revokeOrphanOrigin,
  permissionRevokeErrorMessage,
  HOST_PERMISSION_HINT
} from "../../extension/core/host-permissions.js";

beforeEach(() => {
  resetModuleState();
});

describe("extractOriginFromBaseUrl", () => {
  it("http(s) baseUrl 提取 match pattern（含路径、尾斜杠、query 归一，补 /* 路径）", () => {
    expect(extractOriginFromBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/*");
    expect(extractOriginFromBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/*");
    expect(extractOriginFromBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/*");
    expect(extractOriginFromBaseUrl(" https://api.siliconflow.cn/v1 ")).toBe("https://api.siliconflow.cn/*");
    expect(extractOriginFromBaseUrl("https://api.example.com/v1?x=1")).toBe("https://api.example.com/*");
  });

  it("非法/边界输入返回 null", () => {
    expect(extractOriginFromBaseUrl("")).toBeNull();
    expect(extractOriginFromBaseUrl("   ")).toBeNull();
    expect(extractOriginFromBaseUrl("not a url")).toBeNull();
    expect(extractOriginFromBaseUrl("ftp://api.example.com/v1")).toBeNull();
    expect(extractOriginFromBaseUrl("api.openai.com/v1")).toBeNull();
    expect(extractOriginFromBaseUrl("https://")).toBeNull();
    expect(extractOriginFromBaseUrl(undefined)).toBeNull();
    expect(extractOriginFromBaseUrl(null)).toBeNull();
  });
});

describe("collectOrigins", () => {
  it("去重并保持首次出现顺序，非法项丢弃", () => {
    expect(
      collectOrigins([
        "https://api.openai.com/v1",
        "https://api.openai.com/chat",
        "https://api.siliconflow.cn/v1",
        "",
        "oops",
        undefined
      ])
    ).toEqual(["https://api.openai.com/*", "https://api.siliconflow.cn/*"]);
  });

  it("非数组入参按空处理", () => {
    expect(collectOrigins(null)).toEqual([]);
  });
});

describe("requestProviderOrigins（保存手势链上的批量申请）", () => {
  it("授权通过 → ok，request 收到去重后的 origin", async () => {
    const request = vi.fn(async () => true);
    const resp = await requestProviderOrigins(
      ["https://api.openai.com/v1", "https://api.siliconflow.cn/v1", "https://api.openai.com/chat"],
      request
    );
    expect(resp.ok).toBe(true);
    expect(resp.origins).toEqual(["https://api.openai.com/*", "https://api.siliconflow.cn/*"]);
    expect(request).toHaveBeenCalledWith({
      origins: ["https://api.openai.com/*", "https://api.siliconflow.cn/*"]
    });
  });

  it("多个平台只发一次 request（一次手势只够一次弹窗）", async () => {
    const request = vi.fn(async () => true);
    await requestProviderOrigins(["https://a.example.com/v1", "https://b.example.com/v1"], request);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("无 origin 可申请（空列表 / 全非法）→ 不发 request 也不报错", async () => {
    const request = vi.fn(async () => true);
    expect(await requestProviderOrigins([], request)).toEqual({ ok: true, origins: [] });
    const resp = await requestProviderOrigins(["", "oops"], request);
    expect(resp.ok).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("用户拒绝 → 明确可操作错误，不静默", async () => {
    const request = vi.fn(async () => false);
    const resp = await requestProviderOrigins(["https://api.openai.com/v1"], request);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("未授权");
    expect(resp.error).toContain("https://api.openai.com");
    expect(resp.error).toContain("保存已中止");
  });

  it("request 抛错 → { ok: false, error } 兜底", async () => {
    const request = vi.fn(async () => {
      throw new Error("permissions API unavailable");
    });
    const resp = await requestProviderOrigins(["https://x/v1"], request);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("申请域名权限失败");
  });

  it("未注入 request 实现（非扩展环境）→ 明确失败", async () => {
    const resp = await requestProviderOrigins(["https://x/v1"], undefined);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("不支持申请权限");
  });
});

describe("hasHostPermission（探针/模型列表的权限预检）", () => {
  it("已授权 → true，contains 收到该 origin", async () => {
    const contains = vi.fn(async () => true);
    expect(await hasHostPermission("https://api.openai.com/v1", contains)).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });
  });

  it("未授权 → false", async () => {
    const contains = vi.fn(async () => false);
    expect(await hasHostPermission("https://api.openai.com/v1", contains)).toBe(false);
  });

  it("取不到 chrome.permissions 实现 / URL 非法 / contains 抛错 → 按已授权处理", async () => {
    expect(await hasHostPermission("https://api.openai.com/v1", undefined)).toBe(true);
    expect(await hasHostPermission("oops", vi.fn(async () => false))).toBe(true);
    const throwing = vi.fn(async () => {
      throw new Error("no permissions API");
    });
    expect(await hasHostPermission("https://api.openai.com/v1", throwing)).toBe(true);
  });

  it("统一提示文案导出可用", () => {
    expect(HOST_PERMISSION_HINT).toContain("未授权");
  });
});

describe("collectOrphanOrigins（删除时的 origin 回收判定）", () => {
  const remainingAi = [{ id: "a1", baseUrl: "https://api.openai.com/v1" }];
  const remainingAsr = [{ id: "s1", baseUrl: "https://api.siliconflow.cn/v1" }];

  it("无任何剩余 provider 使用该 origin → 回收", () => {
    expect(collectOrphanOrigins("https://api.openai.com/v1", [])).toEqual(["https://api.openai.com/*"]);
    expect(collectOrphanOrigins("https://api.openai.com/v1", remainingAsr)).toEqual(["https://api.openai.com/*"]);
  });

  it("AI 或 ASR 组仍有 provider 使用同一 origin → 不回收", () => {
    expect(collectOrphanOrigins("https://api.openai.com/v1", remainingAi)).toEqual([]);
    expect(collectOrphanOrigins("https://api.openai.com/v1", [...remainingAi, ...remainingAsr])).toEqual([]);
    expect(collectOrphanOrigins("https://api.siliconflow.cn/v1", [...remainingAi, ...remainingAsr])).toEqual([]);
  });

  it("同 host 不同端口算不同 origin（互不影响）", () => {
    expect(collectOrphanOrigins("http://localhost:11434/v1", [{ id: "a", baseUrl: "http://localhost:8000/v1" }])).toEqual([
      "http://localhost:11434/*"
    ]);
  });

  it("被删平台 baseUrl 非法 → 不回收（无主按无回收处理）", () => {
    expect(collectOrphanOrigins("", remainingAi)).toEqual([]);
    expect(collectOrphanOrigins("oops", [])).toEqual([]);
  });

  it("非数组剩余列表按空列表处理", () => {
    expect(collectOrphanOrigins("https://x/v1", null)).toEqual(["https://x/*"]);
    expect(collectOrphanOrigins("https://x/v1", undefined)).toEqual(["https://x/*"]);
  });
});

describe("revokeOrphanOrigin（删除时的 origin 回收执行）", () => {
  // 删除钩子早于 DOM row.remove()，所以传入的列表含被删行自身
  const deleted = { id: "a1", baseUrl: "https://api.openai.com/v1" };
  const containsGranted = vi.fn(async () => true);

  it("列表含被删行自身也照常回收（按 id 剔除，不自锁）", async () => {
    const remove = vi.fn(async () => true);
    const resp = await revokeOrphanOrigin(deleted, [deleted], { contains: containsGranted, remove });
    expect(resp).toEqual({ origins: ["https://api.openai.com/*"], revoked: true });
    expect(remove).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });
  });

  it("另一组（ASR）仍用同一 origin → 不回收、不发 remove", async () => {
    const remove = vi.fn(async () => true);
    const resp = await revokeOrphanOrigin(deleted, [{ id: "s1", baseUrl: "https://api.openai.com/chat" }], {
      contains: containsGranted,
      remove
    });
    expect(resp).toEqual({ origins: [], revoked: false });
    expect(remove).not.toHaveBeenCalled();
  });

  it("权限本就不在 → 跳过 remove，不算失败", async () => {
    const remove = vi.fn(async () => true);
    const resp = await revokeOrphanOrigin(deleted, [], { contains: vi.fn(async () => false), remove });
    expect(resp).toEqual({ origins: [], revoked: false });
    expect(remove).not.toHaveBeenCalled();
  });

  it("remove 返回 false / 抛错 → 回报失败 origin 供提示", async () => {
    expect(
      await revokeOrphanOrigin(deleted, [], { contains: containsGranted, remove: vi.fn(async () => false) })
    ).toEqual({ origins: ["https://api.openai.com/*"], revoked: false });
    expect(
      await revokeOrphanOrigin(deleted, [], {
        contains: containsGranted,
        remove: vi.fn(async () => {
          throw new Error("remove failed");
        })
      })
    ).toEqual({ origins: ["https://api.openai.com/*"], revoked: false });
  });

  it("被删项 baseUrl 非法 → 什么都不做", async () => {
    const remove = vi.fn(async () => true);
    const resp = await revokeOrphanOrigin({ id: "a1", baseUrl: "oops" }, [], { contains: containsGranted, remove });
    expect(resp).toEqual({ origins: [], revoked: false });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("permissionRevokeErrorMessage", () => {
  it("拼出可操作提示（含 origin 明细）", () => {
    expect(permissionRevokeErrorMessage(["https://api.openai.com"])).toContain("回收域名权限失败");
    expect(permissionRevokeErrorMessage(["https://api.openai.com"])).toContain("https://api.openai.com");
  });
});
