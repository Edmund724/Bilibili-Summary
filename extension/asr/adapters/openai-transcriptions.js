// extension/asr/adapters/openai-transcriptions.js
// OpenAI 兼容语音转写适配器：POST {baseUrl}/audio/transcriptions。
// 适用 SiliconFlow（免费，只返回纯文本）/ 本地 Whisper（verbose_json
// 句级时间戳）/ 自定义（自动探测时间戳能力）。
//
// 关键约束（spec 6.7 / 7.1）：
//   - 用 FormData 上传，绝不手动设 Content-Type（浏览器自动带 boundary）；
//   - apiKey 存在才带 Authorization: Bearer（本地 Whisper 常无 Key）；
//   - 转写语言：provider.language 为 zh/en 时以查询参数 ?language=zh|english
//     传给平台（SiliconFlow 辰星/SenseVoice 的英文识别依赖该参数）；auto 省略，
//     交服务端自动检测；
//   - 兼容性降级：非 2xx 或响应体无 segments → 以 response_format=json
//     自动重试一次（只取 text），返回里省略 segments 表达"无时间戳"，
//     调用方据此合成整片粗粒度字幕。

// 把识别语言转成平台查询参数：?language=zh / ?language=english。
// SiliconFlow 辰星 / SenseVoice 系列的英文识别依赖 ?language=english（multipart
// 字段不生效），只有显式选择 zh/en 才附带；auto 省略让服务端自动检测
// （本地 Whisper 也无此参数，其语言自动识别）。
export function buildTranscriptionUrl(baseUrl, language) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  const lang = String(language || "").trim().toLowerCase();
  if (lang !== "zh" && lang !== "en") {
    return `${normalized}/audio/transcriptions`;
  }
  return `${normalized}/audio/transcriptions?language=${lang === "zh" ? "zh" : "english"}`;
}

// 构造 FormData（纯函数便于单测断言字段）
function buildTranscriptionForm(wavBlob, provider, responseFormat) {
  const form = new FormData();
  form.append("file", wavBlob, "chunk.wav");
  form.append("model", provider?.model || "");
  form.append("response_format", responseFormat || "verbose_json");
  // 不把 language 放 multipart 字段——SiliconFlow 辰星/SenseVoice 只认查询
  // 参数 ?language=zh|english，字段会被忽略；语言参数由 buildTranscriptionUrl
  // 附加到 URL（auto 省略，服务端自动检测，兼容中英混排与外语视频）。
  return form;
}

// 归一化 segments 列表：只保留 { start, end, text } 且 text 非空白，
// start/end 转数字；无有效 segments 返回 undefined（调用方按无时间戳处理）。
function normalizeSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return undefined;
  }
  const normalized = [];
  for (const seg of segments) {
    const start = Number(seg?.start);
    const end = Number(seg?.end);
    const text = String(seg?.text || "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
      continue;
    }
    normalized.push({ start, end, text });
  }
  return normalized.length > 0 ? normalized : undefined;
}

// 单次 POST 请求。HTTP 2xx 且 JSON 解析成功 → status=0 并带 text/segments；
// 否则 status=HTTP 码（-1 表示响应体解析失败）并附响应体片段 detail。
// 不抛错，交给调用方决定降级或重试（网络错误/Abort 除外）。
async function postTranscription({ wavBlob, provider, signal, responseFormat }) {
  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("平台 baseUrl 未配置");
  }
  const form = buildTranscriptionForm(wavBlob, provider, responseFormat);
  const headers = {};
  const apiKey = String(provider?.apiKey || "").trim();
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let response;
  try {
    response = await fetch(buildTranscriptionUrl(baseUrl, provider?.language), {
      method: "POST",
      headers,
      body: form,
      signal
    });
  } catch (error) {
    if (signal?.aborted) {
      const abortError = new Error("已停止生成");
      abortError.name = "AbortError";
      throw abortError;
    }
    throw error;
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // 忽略响应体读取失败
    }
    return { status: response.status, detail, text: "", segments: undefined };
  }

  try {
    const data = await response.json();
    return {
      status: 0,
      detail: "",
      text: String(data?.text || "").trim(),
      segments: normalizeSegments(data?.segments)
    };
  } catch {
    return { status: -1, detail: "响应体不是合法 JSON", text: "", segments: undefined };
  }
}

// 统一入口。返回 { text, segments? }；segments 缺省表示该平台无时间戳，
// 调用方（pipeline）据此合成整片粗粒度字幕。
export async function transcribe({ wavBlob, startSec, durationSec, provider, signal, onProgress }) {
  // 首次尝试 verbose_json：平台支持则带句级时间戳。
  const first = await postTranscription({ wavBlob, provider, signal, responseFormat: "verbose_json" });
  if (first.status === 0 && first.segments) {
    onProgress?.();
    return { text: first.text, segments: first.segments };
  }

  // 兼容性降级：非 2xx 或响应体无 segments（如 SiliconFlow 只回 { text }）
  // → 以 response_format=json 重试一次，只取 text。
  const second = await postTranscription({ wavBlob, provider, signal, responseFormat: "json" });
  onProgress?.();
  if (second.status === 0) {
    return { text: second.text };
  }

  // json 降级也失败：抛 HTTP 错误（5xx/网络错误由调用方 retryAsync 重试）。
  const err = new Error(second.status > 0 ? `HTTP ${second.status}${second.detail ? `: ${second.detail}` : ""}` : (second.detail || "转写请求失败"));
  err.status = second.status;
  throw err;
}
