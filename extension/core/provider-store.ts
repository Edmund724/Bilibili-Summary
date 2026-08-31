// extension/core/provider-store.ts
// Provider 列表 + API Key 双存储的通用工厂。
// extension/core/ai-provider-store.ts（对话平台）与
// extension/asr/asr-provider-store.ts（语音转写平台）原本互为镜像：
// 本工厂提取两者共享的列表 CRUD 结构，两个模块退化为只传 storage key
// 与 normalizeProvider 的薄适配层。只与 chrome.storage 交互，不涉及消息路由。
// 另承载两平台探针（ai-provider-store / asr-provider-store）共用的错误文案
// 拼装 helper，保证 AI/ASR 连通性测试的文案逐字一致。
//
// 存储布局（不变式，两个平台一致）：provider 列表持久化在 chrome.storage.sync，
// API Key 单独存放在 chrome.storage.local —— apiKey 永不进同步列表：写回 sync
// 的列表只含 normalizeProvider 产出的字段，明文 Key 只落在 local 的
// keysStorageKey，列表对外只带 hasSavedKey 布尔占位。

export type ProviderKeys = Record<string, string>;

export interface ProviderBase {
  id: string;
}

export interface CreateProviderStoreDeps<T extends ProviderBase> {
  listStorageKey: string;
  keysStorageKey: string;
  normalizeProvider: (item: unknown) => T | null;
}

export interface ProviderStore<T extends ProviderBase> {
  loadKeys: () => Promise<ProviderKeys>;
  getKey: (providerId: string | null | undefined) => Promise<string>;
  saveKey: (providerId: string, apiKey: string) => Promise<ProviderKeys>;
  loadProviders: () => Promise<Array<T & { hasSavedKey: boolean }>>;
  saveProviders: (items: unknown[]) => Promise<Array<T & { hasSavedKey: boolean }>>;
  deleteProvider: (providerId: string) => Promise<Array<T & { hasSavedKey: boolean }>>;
}

export function createProviderStore<T extends ProviderBase>({
  listStorageKey,
  keysStorageKey,
  normalizeProvider
}: CreateProviderStoreDeps<T>): ProviderStore<T> {
  // 读取已存 API Key（providerId -> apiKey 的映射）。Key 单独存 local，
  // 不随 sync 的 provider 列表明文回传。
  async function loadKeys(): Promise<ProviderKeys> {
    const localData = await chrome.storage.local.get([keysStorageKey]);
    const keys = localData?.[keysStorageKey];
    return keys && typeof keys === "object" ? (keys as ProviderKeys) : {};
  }

  // 读取单个 provider 的已存 Key（按 id 查）。供探针在不要求用户重输 Key 时使用。
  async function getKey(providerId: string | null | undefined): Promise<string> {
    if (!providerId) return "";
    const keys = await loadKeys();
    return String(keys[providerId] || "").trim();
  }

  // 写入/清除单个 provider 的 Key：非空 trim 后写入，空值视为清除。
  async function saveKey(providerId: string, apiKey: string): Promise<ProviderKeys> {
    const keys = await loadKeys();
    const trimmed = String(apiKey || "").trim();
    if (trimmed) {
      keys[providerId] = trimmed;
    } else {
      delete keys[providerId];
    }
    await chrome.storage.local.set({ [keysStorageKey]: keys });
    return keys;
  }

  // 读取 provider 列表，Key 不明文回传，只带 hasSavedKey 占位。
  async function loadProviders(): Promise<Array<T & { hasSavedKey: boolean }>> {
    const [syncData, keys] = await Promise.all([
      chrome.storage.sync.get([listStorageKey]),
      loadKeys()
    ]);
    const list = Array.isArray(syncData[listStorageKey]) ? syncData[listStorageKey] : [];
    return (list as unknown[])
      .map(normalizeProvider)
      .filter((p): p is T => Boolean(p))
      .map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
  }

  // 保存 provider 列表。列表项若带 apiKey 字段则一并写入 Key 存储
  // （空/缺失 = 保留已存 Key，不清除），但回传列表只带 hasSavedKey 占位。
  async function saveProviders(items: unknown[]): Promise<Array<T & { hasSavedKey: boolean }>> {
    const rawList = Array.isArray(items) ? items : [];
    const keys = await loadKeys();
    const nextList: T[] = [];
    for (const raw of rawList) {
      const normalized = normalizeProvider(raw);
      if (!normalized) continue;
      nextList.push(normalized);
      const incomingKey = String((raw as { apiKey?: unknown }).apiKey || "").trim();
      if (incomingKey) {
        keys[normalized.id] = incomingKey;
      }
    }
    await Promise.all([
      chrome.storage.sync.set({ [listStorageKey]: nextList }),
      chrome.storage.local.set({ [keysStorageKey]: keys })
    ]);
    // 返回带 hasSavedKey 的列表，方便前端渲染占位
    return nextList.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
  }

  // 删除 provider，其已存 Key 一并清理（不残留孤儿 Key）。
  async function deleteProvider(providerId: string): Promise<Array<T & { hasSavedKey: boolean }>> {
    const list = await loadProviders();
    const next = list
      .filter((p) => p.id !== providerId)
      .map((p) => {
        // 列表项带 hasSavedKey 占位，归一化函数不接受该字段，剥掉再存
        const { hasSavedKey: _omit, ...rest } = p;
        return rest as unknown as T;
      });
    await chrome.storage.sync.set({ [listStorageKey]: next });
    const keys = await loadKeys();
    if (keys && providerId in keys) {
      delete keys[providerId];
      await chrome.storage.local.set({ [keysStorageKey]: keys });
    }
    return next.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
  }

  return { loadKeys, getKey, saveKey, loadProviders, saveProviders, deleteProvider };
}

// ===== 探针错误文案拼装（AI / ASR 探针共享） =====

// 探针网络层失败的文案。error?.message || error 兜底照顾非 Error 抛出物
//（字符串、对象）。文案逐字节冻结：tests 断言「无法连接」。
export function formatProbeConnectionError(error: unknown): string {
  return `无法连接：${(error as Error | undefined)?.message || error}`;
}

// 探针非 2xx 的文案：附响应体前 200 字符；响应体读取失败时无 detail。
export async function formatProbeHttpError(response: { status: number; text: () => Promise<string> }): Promise<string> {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {}
  return `HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
}
