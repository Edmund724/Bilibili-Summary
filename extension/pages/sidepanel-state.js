// sidepanel-state.js — sidepanel 跨子模块共享的可变状态（sidepanel-split 后续
// 收拢产物）。
//
// sidepanel.js 原本持有 20 个模块级可变量，其中 13 个被 conversation-store /
// chat-runtime 子模块经 deps getter/setter 跨模块读写。本模块把这 13 个字段
// 收拢为一个可变状态对象，pages/* 子模块与 sidepanel.js 直接 import 它，deps
// 里只留 UI/transport 回调、storage 抽象与常量。
//
// 依赖方向（无环）：本文件是零依赖叶子——唯一 import 是 ../core/defaults.js
// 的纯常量（DEFAULT_INITIAL_QUICK_PROMPTS / DEFAULT_PRESET_PROMPTS，纯数据无
// 逻辑），用于给出 aiPrefs 的初始值。sidepanel.js / sidepanel-conversation-
// store.js / sidepanel-chat-runtime.js 单向 import 本文件。
//
// 纯局部单例（suggestionsNode / contextNoticeTimer / liveContextSyncTimer /
// liveContextSyncForceRefresh / modelSelectMeasureCanvas / initCompleted / els /
// subtitleWaiter / conversationStore / chatRuntime 实例 / shouldAutoScroll-
// Messages）不进本对象：它们只被单一模块使用，留在各自模块里。
//
// 测试注意：本对象是模块级单例，测试里若配合 vi.resetModules 切换模块纪元，
// 需重新 import 本模块取新鲜实例；单纪元内复用时请在 beforeEach 手动重置字段。

import { DEFAULT_INITIAL_QUICK_PROMPTS, DEFAULT_PRESET_PROMPTS } from "../core/defaults.js";

export const sidepanelState = {
  // ---- 上下文（loadContextState 写，UI 渲染读） ----
  // 当前应用的上下文快照（视频信息/字幕等）；null = 无上下文
  contextData: null,
  // contextData 对应的上下文键（buildContextKey 产物）
  currentContextKey: "",
  // 可用 AI 平台列表（loadProvidersAndPrefs 过滤 enabled 后写入）
  providers: [],
  // ---- 对话（conversation-store 与 chat-runtime 双侧读写） ----
  // 当前会话的一问一答数组 [{ role, content }]
  chatHistory: [],
  // 持久化的历史会话列表（storage 的内存镜像）
  savedConversations: [],
  // 当前会话 id（"" = 无当前会话）
  currentConversationId: "",
  // 当前会话元信息（id/标题/上下文绑定等）；null = 无当前会话
  currentConversationMeta: null,
  // ---- 实时上下文（loadContextState 维护的"活跃标签页"快照，与 contextData
  // 分离：流式守卫冻结 contextData 时 live 侧继续断供更新） ----
  liveContextData: null,
  liveContextKey: "",
  // 活跃标签页 URL（isBoundConversationMismatched / 历史列表 live 匹配读）
  liveTabUrl: "",
  // ---- AI 偏好（loadProvidersAndPrefs 整体替换，modelSelect/预设局部改写） ----
  aiPrefs: {
    aiSystemPrompt: "",
    aiInitialQuickPrompts: DEFAULT_INITIAL_QUICK_PROMPTS.slice(),
    aiPresetPrompts: DEFAULT_PRESET_PROMPTS.slice()
  },
  // ---- 杂项标志 ----
  // content 侧音频转写进行中的兜底信号（boc-subtitle-status 广播写，
  // subtitleWaiter 轮询读）
  asrTranscribingActive: false,
  // 思考档位（off/low/high）。双持久化：localStorage boc_ai_thinking_level +
  // sync settings.aiThinkingLevel；读取以 settings ?? localStorage 为准
  //（写点在 sidepanel.js 的 setThinkingLevel / loadProvidersAndPrefs）。
  aiThinkingLevel: "off"
};
