// extension/core/provider-handlers.ts
// Provider 消息处理器的通用工厂。
// extension/entry/background.js 里 AI 平台与 ASR 平台各有一组形状相同的
// 消息处理器（列表 / 读取 Key / 保存列表 / 写单个 Key / 删除 / 连通性测试），
// 本工厂提取这组共享结构：调用方注入对应 store 的函数与探针，换回一组
// (message, sender, sendResponse) → boolean 形状的标准处理器。background 的
// 路由表保持消息名不变，只换处理器指向。不持有状态、不直接碰
// chrome.storage——存储交互全部经由注入的 store 函数。
//
// 响应负载契约（与被替换的原处理器一致）：
// - list / save / remove 成功 → { ok: true, providers: items }
// - get 成功 → { ok: true, apiKey }；缺 providerId → 同步回包
//   { ok: false, error: "缺少 providerId" } 并返回 false
// - setKey 成功 → { ok: true }
// - test 成功 → 原样转发探针负载；输入不完整 → 同步回包 { ok: false, error }
//   并返回 false
// - 所有 Promise 路径返回 true（异步回包）

export interface ProviderHandlersMessage {
  providerId?: string | number;
  providers?: unknown[];
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: unknown;
}

export type SendResponse = (response: unknown) => void;

export interface ProviderMessageHandlersDeps {
  loadProviders: () => Promise<unknown[]>;
  saveProviders: (items: unknown[]) => Promise<unknown[]>;
  deleteProvider: (providerId: string) => Promise<unknown[]>;
  loadKeys: () => Promise<Record<string, string>>;
  saveKey?: (providerId: string, apiKey: string) => Promise<unknown>;
  probe: (provider: unknown) => Promise<unknown>;
  pickTestProvider?: (message: ProviderHandlersMessage) => { provider: unknown } | { error: string };
}

export interface ProviderMessageHandlers {
  list: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
  get: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
  save: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
  remove: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
  test: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
  setKey?: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
}

export function createProviderMessageHandlers({
  loadProviders,
  saveProviders,
  deleteProvider,
  loadKeys,
  saveKey,
  probe,
  pickTestProvider
}: ProviderMessageHandlersDeps): ProviderMessageHandlers {
  // 缺省探针输入装配：平铺字段消息（ai-providers-test 的契约）。
  // baseUrl 缺失属于同步失败：回包 { ok: false, error: "请填写 baseUrl" }
  // 并让处理器返回 false；Key 解析是异步的：优先消息直带的 apiKey（用户
  // 重输的场景），否则按 providerId 从已存 Key 代查，都没有则为空串。
  function pickFlatTestProvider(message: ProviderHandlersMessage): { provider: Promise<unknown> } | { error: string } {
    const baseUrl = String(message.baseUrl || "").trim();
    const providerId = String(message.providerId || "").trim();
    const model = String(message.model || "").trim();
    if (!baseUrl) {
      return { error: "请填写 baseUrl" };
    }
    return {
      provider: Promise.resolve()
        .then(async () => {
          const directApiKey = String(message.apiKey || "").trim();
          if (directApiKey) {
            return directApiKey;
          }
          if (!providerId) {
            return "";
          }
          const keys = await loadKeys();
          return String(keys[providerId] || "").trim();
        })
        .then((apiKey) => ({ baseUrl, apiKey, model }))
    };
  }

  const pickProbeProvider = pickTestProvider || pickFlatTestProvider;

  function list(_message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    loadProviders()
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  function get(message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    const msg = message as ProviderHandlersMessage;
    const providerId = String(msg.providerId || "").trim();
    if (!providerId) {
      sendResponse({ ok: false, error: "缺少 providerId" });
      return false;
    }
    loadKeys()
      .then((keys) => {
        const apiKey = String(keys[providerId] || "").trim();
        sendResponse({ ok: true, apiKey });
      })
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  function save(message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    const msg = message as ProviderHandlersMessage;
    saveProviders(msg.providers || [])
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  function remove(message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    const msg = message as ProviderHandlersMessage;
    deleteProvider(String(msg.providerId || ""))
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  function setKey(message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    const msg = message as ProviderHandlersMessage;
    saveKey!(String(msg.providerId || ""), String(msg.apiKey || ""))
      .then(() => sendResponse({ ok: true }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  function test(message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    const picked = pickProbeProvider(message as ProviderHandlersMessage);
    if ("error" in picked) {
      sendResponse({ ok: false, error: picked.error });
      return false;
    }
    Promise.resolve(picked.provider)
      .then((provider) => probe(provider))
      .then((resp) => sendResponse(resp))
      // 探针本身不抛错（失败以 { ok: false } 负载返回），能到这里的基本是
      // Key 存储读取失败；沿用转发探针负载的处理器的容错写法。
      .catch((error: Error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  const handlers: ProviderMessageHandlers = { list, get, save, remove, test };
  // ASR 平台没有“写单个 Key”的消息（Key 随 saveProviders 收割进 local），
  // 只有注入了 saveKey 的家族才带 setKey 处理器。
  if (saveKey) {
    handlers.setKey = setKey;
  }
  return handlers;
}

// ===== ASR 回退运行时配置处理器 =====

export interface AsrRuntimeConfigSettings {
  activeAsrProviderId?: string;
  asrLanguage?: string;
  asrAutoFallback?: boolean;
}

export interface AsrRuntimeConfigHandlerDeps {
  getMergedSettings: () => Promise<AsrRuntimeConfigSettings>;
  loadProviders: () => Promise<unknown[]>;
  getAsrProviderKey: (providerId: string) => Promise<string>;
}

export function createAsrRuntimeConfigHandler({
  getMergedSettings,
  loadProviders,
  getAsrProviderKey
}: AsrRuntimeConfigHandlerDeps) {
  return function handleGetAsrRuntimeConfig(
    _message: unknown,
    _sender: unknown,
    sendResponse: SendResponse
  ): boolean {
    getMergedSettings()
      .then(async (settings) => {
        const activeId = String(settings.activeAsrProviderId || "").trim();
        const [providers, activeKey] = await Promise.all([
          loadProviders(),
          activeId ? getAsrProviderKey(activeId) : Promise.resolve("")
        ]);
        sendResponse({
          ok: true,
          providers,
          activeAsrProviderId: activeId,
          activeKey,
          asrLanguage: settings.asrLanguage,
          asrAutoFallback: settings.asrAutoFallback === true
        });
      })
      .catch((error: Error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  };
}
