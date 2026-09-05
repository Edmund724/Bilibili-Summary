// extension/core/provider-handlers.ts
// Provider 消息处理器的通用工厂。
// extension/entry/background.js 里 AI 平台与 ASR 平台各有一组形状相同的
// 消息处理器（列表 / 读取 Key / 保存列表 / 删除），本工厂提取这组共享结构：
// 调用方注入对应 store 的函数，换回一组 (message, sender, sendResponse) →
// boolean 形状的标准处理器。background 的路由表保持消息名不变，只换处理器
// 指向。不持有状态、不直接碰 chrome.storage——存储交互全部经由注入的 store
// 函数。（连通性 test 处理器与 probe/pickTestProvider 注入面已随 arch-slim-2/03
// 死能力退役：生产零注入，探针由 options 页直调 ai/provider-test.js 与
// asr/provider-test.js。）
//
// 响应负载契约（与被替换的原处理器一致）：
// - list / save / remove 成功 → { ok: true, providers: items }
// - get 成功 → { ok: true, apiKey }；缺 providerId → 同步回包
//   { ok: false, error: "缺少 providerId" } 并返回 false
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

// ===== 异步错误回包包装单源（arch-slim-2/03）=====
// 「Promise → sendResponse」协议的唯一收口：task 决议值即完整 ok 负载（原样
// 回包）；task 拒绝统一映射为 { ok: false, error: <msg> }，缺省取 error.message
// （与被替换的逐字手抄一致）。文案带前缀/兜底的调用点传 toError（如
// background 的 request-provider-origins / fetch-json / player-ai-quick-action）。
export function withOkResponse(
  task: Promise<unknown>,
  sendResponse: SendResponse,
  toError: (error: unknown) => string = (error) => (error as Error).message
): void {
  task
    .then((payload) => sendResponse(payload))
    .catch((error) => sendResponse({ ok: false, error: toError(error) }));
}

export interface ProviderMessageHandlersDeps {
  loadProviders: () => Promise<unknown[]>;
  saveProviders: (items: unknown[]) => Promise<unknown[]>;
  deleteProvider: (providerId: string) => Promise<unknown[]>;
  loadKeys: () => Promise<Record<string, string>>;
}

export interface ProviderMessageHandlers {
  list: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
  get: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
  save: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
  remove: (message: unknown, sender: unknown, sendResponse: SendResponse) => boolean;
}

export function createProviderMessageHandlers({
  loadProviders,
  saveProviders,
  deleteProvider,
  loadKeys
}: ProviderMessageHandlersDeps): ProviderMessageHandlers {
  function list(_message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    withOkResponse(
      loadProviders().then((items) => ({ ok: true, providers: items })),
      sendResponse
    );
    return true;
  }

  function get(message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    const msg = message as ProviderHandlersMessage;
    const providerId = String(msg.providerId || "").trim();
    if (!providerId) {
      sendResponse({ ok: false, error: "缺少 providerId" });
      return false;
    }
    withOkResponse(
      loadKeys().then((keys) => {
        const apiKey = String(keys[providerId] || "").trim();
        return { ok: true, apiKey };
      }),
      sendResponse
    );
    return true;
  }

  function save(message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    const msg = message as ProviderHandlersMessage;
    withOkResponse(
      saveProviders(msg.providers || []).then((items) => ({ ok: true, providers: items })),
      sendResponse
    );
    return true;
  }

  function remove(message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    const msg = message as ProviderHandlersMessage;
    withOkResponse(
      deleteProvider(String(msg.providerId || "")).then((items) => ({ ok: true, providers: items })),
      sendResponse
    );
    return true;
  }

  return { list, get, save, remove };
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
    withOkResponse(
      (async () => {
        const settings = await getMergedSettings();
        const activeId = String(settings.activeAsrProviderId || "").trim();
        const [providers, activeKey] = await Promise.all([
          loadProviders(),
          activeId ? getAsrProviderKey(activeId) : Promise.resolve("")
        ]);
        return {
          ok: true,
          providers,
          activeAsrProviderId: activeId,
          activeKey,
          asrLanguage: settings.asrLanguage,
          asrAutoFallback: settings.asrAutoFallback === true
        };
      })(),
      sendResponse,
      (error) => (error as Error)?.message || String(error)
    );
    return true;
  };
}
