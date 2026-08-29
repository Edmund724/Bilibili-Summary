// offscreen 协议共享常量：同一 offscreen 文档（entry/offscreen.html）被两条
// 链路共同创建/复用——sidepanel 聊天自愈（pages/sidepanel-offscreen-ensure.js）
// 与 background asr-decode-prepare（asr/offscreen-bridge.js）；转写并发上限也
// 被 offscreen 接线层（entry/offscreen-asr.js ASR_ADAPTERS）与调度引擎默认值
// （asr/engine.js）同时引用。收拢到此处保证取值唯一。
//
// 本模块会被 content / sidepanel / offscreen / background 多个 bundle 打包，
// 必须保持叶子：纯常量、零 chrome API、零其他模块 import。

// offscreen 文档 URL（相对扩展根）：background 创建/探测与 sidepanel
// getContexts 查询共用同一取值。
export const OFFSCREEN_URL = "entry/offscreen.html";

// 创建 reason 统一取 BLOBS：文档实际承载 ASR 解码 + 转写（WAV Blob 仅在本
// context 内经 FormData 上传）与聊天 SSE 流式拉取。不能用 AUDIO_PLAYBACK——
// Chrome 对无真实播放的 AUDIO_PLAYBACK 文档 30 秒强制关闭，长视频解码会被
// 打断（详见 asr/offscreen-bridge.js ensureAsrOffscreenDocument 注释）。
export const OFFSCREEN_CREATE_REASON = "BLOBS";

// ASR 转写并发上限：offscreen ASR_ADAPTERS 与 asr/engine.js 调度默认共用。
export const ASR_CONCURRENCY = 5;
