// extension/core/storage-bridge.ts
// offscreen 文档的 chrome.storage.local 桥（offscreen 端垫片安装器 + SW 端 handler）。
// 平台事实（chrome.offscreen 官方文档「The runtime API is the only extensions API
// supported by offscreen documents」）：offscreen 文档没有 chrome.storage——Map-Reduce
// 与概览跑在 offscreen，经 cache-lru/segment-cache/analysis-orchestrate 的缓存读写
// 会 requireStorageLocal 抛「chrome.storage.local 不可用」，读路径则静默当 miss
// （段缓存自上线起在真实浏览器里从未落过盘）。垫片在 offscreen 启动时检测到无原生
// storage 后安装，get/set/remove 经 runtime 消息转发到 SW 的真实 storage。
// 语义对齐原生 chrome.storage.local：
// - get(null) 全量枚举；get(string)/get(string[]) 只回存在的键；
// - set 整体覆写对应键；remove 对不存在的键是 no-op；
// - SW 端操作抛错 → 垫片 promise reject（与原生 lastError → reject 同形）。
// 有原生 storage 的宿主（SW/content/options）不安装；无 runtime 的环境也不安装。

import { withOkResponse } from "./provider-handlers.js";
import type { SendResponse, StorageLocalBridgeMessage } from "../shared/messaging-protocol.js";

// ===== SW 端 handler 工厂（background.ts 注册到消息路由表）=====

export interface StorageLocalBridgeHandlerDeps {
  storageLocal: Pick<chrome.storage.StorageArea, "get" | "set" | "remove">;
}

export function createStorageLocalBridgeHandler(
  { storageLocal }: StorageLocalBridgeHandlerDeps
): (message: StorageLocalBridgeMessage, sender: unknown, sendResponse: SendResponse) => boolean {
  return function handleStorageLocalBridge(
    message: StorageLocalBridgeMessage,
    _sender: unknown,
    sendResponse: SendResponse
  ): boolean {
    withOkResponse(
      (async () => {
        if (message.op === "get") {
          return { ok: true, data: await storageLocal.get(message.keys ?? null) };
        }
        if (message.op === "set") {
          await storageLocal.set(message.entries ?? {});
          return { ok: true };
        }
        if (message.op === "remove") {
          await storageLocal.remove(message.keys ?? []);
          return { ok: true };
        }
        throw new Error("不支持的 storage 桥操作：" + String((message as { op?: unknown }).op));
      })(),
      sendResponse
    );
    return true;
  };
}

// ===== offscreen 端垫片安装器 =====

interface StorageBridgeResponse {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

function bridgeRequest(
  op: StorageLocalBridgeMessage["op"],
  payload: { keys?: string | string[] | null; entries?: Record<string, unknown> }
): Promise<StorageBridgeResponse> {
  return chrome.runtime.sendMessage({ type: "storage-local-bridge", op, ...payload }) as Promise<StorageBridgeResponse>;
}

export function installStorageLocalBridge(): void {
  const host = globalThis.chrome as unknown as
    | (typeof globalThis & {
        runtime?: { sendMessage?: unknown };
        storage?: { local?: unknown };
      })
    | undefined;
  if (!host?.runtime?.sendMessage) {
    return;
  }
  if (host.storage?.local) {
    return;
  }
  const area = {
    async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
      const resp = await bridgeRequest("get", { keys: keys ?? null });
      if (!resp?.ok) {
        throw new Error(resp?.error || "storage 桥读取失败");
      }
      return resp.data || {};
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const resp = await bridgeRequest("set", { entries: items });
      if (!resp?.ok) {
        throw new Error(resp?.error || "storage 桥写入失败");
      }
    },
    async remove(keys: string | string[]): Promise<void> {
      const resp = await bridgeRequest("remove", { keys });
      if (!resp?.ok) {
        throw new Error(resp?.error || "storage 桥删除失败");
      }
    }
  };
  // 只覆盖缓存域的全部用量（get/set/remove），挂进 chrome.storage.local 槽位——
  // requireStorageLocal 与 segment-cache 的直连调用无需感知桥的存在。
  host.storage = host.storage || {};
  (host.storage as { local?: unknown }).local = area;
}
