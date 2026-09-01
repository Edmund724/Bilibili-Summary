// extension/asr/asr-provider-store.ts
// ASR（语音转写）平台 Provider/Key 的设置存储。
// 列表 CRUD 委托给 extension/core/provider-store.js 的 createProviderStore
// （与 AI 平台存储共用同一工厂）：provider 列表持久化在 chrome.storage.sync，
// API Key 单独存放在 chrome.storage.local，不随列表明文回传（列表只带
// hasSavedKey 布尔占位）。直接导出绑定好的 asrProviderStore 实例，消费方
// （background.js 消息路由、运行时配置处理器）调用实例方法。本模块只与
// chrome.storage 交互，不涉及消息路由。
//
// 与 AI 平台存储完全隔离：用不同的 storage key（asrProviders / asrProviderKeys），
// 不和对话平台混用同一个列表。

import { normalizeAsrProvider } from "../core/presets.js";
import { createProviderStore } from "../core/provider-store.js";

export type AsrProviderType = "openai-transcriptions";

export interface AsrProvider {
  id: string;
  presetId: string;
  name: string;
  type: AsrProviderType;
  baseUrl: string;
  model: string;
  supportsTimestamps: boolean;
  enabled: boolean;
  hasSavedKey?: boolean;
  apiKey?: string;
  language?: string;
}

// ===== ASR 平台列表存储 =====

const ASR_PROVIDER_KEYS_STORAGE = "asrProviderKeys";
const ASR_PROVIDERS_STORAGE = "asrProviders";

export const asrProviderStore = createProviderStore<AsrProvider>({
  listStorageKey: ASR_PROVIDERS_STORAGE,
  keysStorageKey: ASR_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAsrProvider as (item: unknown) => AsrProvider | null
});
