// extension/core/provider-handlers.js
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

export function createProviderMessageHandlers({
  loadProviders,
  saveProviders,
  deleteProvider,
  loadKeys,
  saveKey,
  probe,
  pickTestProvider
}) {
  // 缺省探针输入装配：平铺字段消息（ai-providers-test 的契约）。
  // baseUrl 缺失属于同步失败：回包 { ok: false, error: "请填写 baseUrl" }
  // 并让处理器返回 false；Key 解析是异步的：优先消息直带的 apiKey（用户
  // 重输的场景），否则按 providerId 从已存 Key 代查，都没有则为空串。
  function pickFlatTestProvider(message) {
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

  function list(message, sender, sendResponse) {
    loadProviders()
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  function get(message, sender, sendResponse) {
    const providerId = String(message.providerId || "").trim();
    if (!providerId) {
      sendResponse({ ok: false, error: "缺少 providerId" });
      return false;
    }
    loadKeys()
      .then((keys) => {
        const apiKey = String(keys[providerId] || "").trim();
        sendResponse({ ok: true, apiKey });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  function save(message, sender, sendResponse) {
    saveProviders(message.providers || [])
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  function remove(message, sender, sendResponse) {
    deleteProvider(String(message.providerId || ""))
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  function setKey(message, sender, sendResponse) {
    saveKey(String(message.providerId || ""), String(message.apiKey || ""))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  function test(message, sender, sendResponse) {
    const picked = pickProbeProvider(message);
    if (picked && picked.error) {
      sendResponse({ ok: false, error: picked.error });
      return false;
    }
    Promise.resolve(picked.provider)
      .then((provider) => probe(provider))
      .then((resp) => sendResponse(resp))
      // 探针本身不抛错（失败以 { ok: false } 负载返回），能到这里的基本是
      // Key 存储读取失败；沿用转发探针负载的处理器的容错写法。
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  const handlers = { list, get, save, remove, test };
  // ASR 平台没有“写单个 Key”的消息（Key 随 saveProviders 收割进 local），
  // 只有注入了 saveKey 的家族才带 setKey 处理器。
  if (saveKey) {
    handlers.setKey = setKey;
  }
  return handlers;
}

// ===== ASR 回退运行时配置处理器 =====

// 内容脚本（无字幕轨时的 ASR 转写回退，subtitle/fetcher.js）的运行时配置
// 消息处理器工厂。provider-store 存储层由此收口在 background 侧，内容
// bundle 不再打包 chrome.storage provider 存储。一次 getMergedSettings() 取
// 归一化设置（标量项；asrProviders 已摘出 settings，列表经注入的
// loadProviders 直读 provider-store），再按激活平台 id 单查已存 Key，
// 回包一致快照：
//   { ok, providers, activeAsrProviderId, activeKey, asrLanguage, asrAutoFallback }
// providers 为 provider-store 归一化列表（Key 不明文回传）；activeKey 是激活
// 平台的已存 Key——响应中唯一的 Key 材料，暴露面与旧内容侧直读存储（只持有
// 激活平台的 Key）一致。存储读取失败 → { ok: false, error }，由调用方决定降级。
export function createAsrRuntimeConfigHandler({ getMergedSettings, loadProviders, getAsrProviderKey }) {
  return function handleGetAsrRuntimeConfig(message, sender, sendResponse) {
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
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  };
}
