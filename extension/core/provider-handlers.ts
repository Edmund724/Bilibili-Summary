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
  void (async () => {
    try {
      const payload = await task;
      sendResponse(payload);
    } catch (error) {
      sendResponse({ ok: false, error: toError(error) });
    }
  })();
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
      (async () => ({ ok: true, providers: await loadProviders() }))(),
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
      (async () => {
        const keys = await loadKeys();
        const apiKey = String(keys[providerId] || "").trim();
        return { ok: true, apiKey };
      })(),
      sendResponse
    );
    return true;
  }

  function save(message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    const msg = message as ProviderHandlersMessage;
    withOkResponse(
      (async () => ({ ok: true, providers: await saveProviders(msg.providers || []) }))(),
      sendResponse
    );
    return true;
  }

  function remove(message: unknown, _sender: unknown, sendResponse: SendResponse): boolean {
    const msg = message as ProviderHandlersMessage;
    withOkResponse(
      (async () => ({
        ok: true,
        providers: await deleteProvider(String(msg.providerId || ""))
      }))(),
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

// ===== 「激活平台」单趟解析处理器（arch-slim-3/09，CONTEXT.md 域词条）=====

// 无可用平台的可读文案单源（原 ai/active-provider.ts 定义，随解析链收口搬入
// 处理器——错误在解析期产生，文案与产生点同居）。
export const NO_ACTIVE_PROVIDER_MESSAGE = "还没有配置 AI 平台，请先在插件设置中添加并启用。";

export interface AiResolvedProviderHandlerDeps {
  getMergedSettings: () => Promise<{ defaultModel?: unknown }>;
  loadProviders: () => Promise<unknown[]>;
  loadKeys: () => Promise<Record<string, string>>;
}

// 解析策略双档：providerId 给定 = 精确匹配（offscreen 聊天链，找不到即报错）；
// 缺省 = 设置 defaultModel → 首个启用平台回落（content 概览/选区解释）。
// requiresKey !== false 且密钥缺失在解析期即拒绝——content 侧此前不校验、会
// 拖到 HTTP 期才失败，两调用方统一收紧（arch-slim-3/09 行为裁决）。回包
// provider 为平台记录（含 hasSavedKey、不含明文 Key），apiKey 单列。
export function createAiResolvedProviderHandler({
  getMergedSettings,
  loadProviders,
  loadKeys
}: AiResolvedProviderHandlerDeps) {
  return function handleResolveAiProvider(
    message: unknown,
    _sender: unknown,
    sendResponse: SendResponse
  ): boolean {
    withOkResponse(
      (async () => {
        const requestedId = String((message as { providerId?: unknown })?.providerId || "").trim();
        const providers = (await loadProviders()) || [];
        const enabled = providers.filter(
          (item) =>
            item &&
            (item as { enabled?: unknown }).enabled !== false &&
            String((item as { id?: unknown })?.id || "").trim()
        );
        let provider: Record<string, unknown> | null = null;
        if (requestedId) {
          provider =
            (enabled.find(
              (item) => String((item as { id?: unknown }).id) === requestedId
            ) as Record<string, unknown>) || null;
          if (!provider) {
            throw new Error("未找到选中的平台");
          }
        } else {
          const settings = await getMergedSettings();
          const preferredId = String(settings?.defaultModel || "").trim();
          provider =
            (enabled.find((item) => String((item as { id?: unknown }).id) === preferredId) ||
              enabled[0] ||
              null) as Record<string, unknown> | null;
          if (!provider) {
            throw new Error(NO_ACTIVE_PROVIDER_MESSAGE);
          }
        }
        const providerId = String(provider.id);
        const keys = (await loadKeys()) || {};
        const apiKey = String(keys[providerId] || "").trim();
        if (provider.requiresKey !== false && !apiKey) {
          throw new Error("该平台 API Key 未配置");
        }
        return { ok: true, provider, apiKey };
      })(),
      sendResponse,
      (error) => (error as Error)?.message || String(error)
    );
    return true;
  };
}
