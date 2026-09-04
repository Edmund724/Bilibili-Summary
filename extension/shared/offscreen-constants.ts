// offscreen 协议共享常量：同一 offscreen 文档（entry/offscreen.html）被两条
// 链路共同创建/复用——sidepanel 聊天自愈（pages/sidepanel-offscreen-ensure.js）
// 与 background asr-decode-prepare（asr/offscreen-bridge.bg.js）；转写并发上限也
// 被 offscreen 接线层（entry/offscreen-asr.js ASR_ADAPTERS）与调度引擎默认值
// （asr/engine.js）同时引用。收拢到此处保证取值唯一。
//
// 本模块会被 content / sidepanel / offscreen / background 多个 bundle 打包，
// 必须保持叶子：纯常量、零 chrome API、零其他模块 import。

// offscreen 文档 URL（相对扩展根）：background 创建/探测与 sidepanel
// getContexts 查询共用同一取值。
export const OFFSCREEN_URL: string = "entry/offscreen.html";

// 创建 reason 统一取 BLOBS：文档实际承载 ASR 解码 + 转写（WAV Blob 仅在本
// context 内经 FormData 上传）与聊天 SSE 流式拉取。不能用 AUDIO_PLAYBACK——
// Chrome 对无真实播放的 AUDIO_PLAYBACK 文档 30 秒强制关闭，长视频解码会被
// 打断（详见 asr/offscreen-bridge.bg.js ensureAsrOffscreenDocument 注释）。
export const OFFSCREEN_CREATE_REASON: string = "BLOBS";

// ASR 转写并发上限：offscreen ASR_ADAPTERS 与 asr/engine.js 调度默认共用。
// 取值 10 来自 eval/ 并发扫描实测（XingChenASR-V3.2，120s 片）：并发 10 相对 9
// 墙钟加速 1.26x 且单请求耗时基本不涨；12 以上段均被服务端排队拉长（+19%），
// 20 并发墙钟反而恶化到比 9 并发更慢。10 是吞吐/稳定的最优档。
export const ASR_CONCURRENCY: number = 10;
