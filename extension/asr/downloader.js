// extension/asr/downloader.js
// 防盗链下载 + 大文件分块回传。分两层：
//   - background 侧：handleAsrDownload（消息驱动的下载编排），用会话规则临时
//     给 bilivideo 资源补 Referer/Origin 头，主地址失败依次试备用地址；
//   - 页面/内容侧：downloadAudioViaBackground（连 port 收块拼回 ArrayBuffer）。
// 本模块可能同时在 background 与页面两个环境加载，顶层不触碰 worker-only
// API（chrome.declarativeNetRequest 只在 handleAsrDownload 函数体内访问）。

// 会话规则 id：固定值即可，一次只跑一个下载任务，冲突概率低；
// updateSessionRules 采用"移除全部旧规则再添加"的方式天然去重。
export const ASR_AUDIO_SESSION_RULE_ID = 32001;
// 端口名：background 侧按名字识别连接
export const ASR_AUDIO_PORT_NAME = "asr-audio-chunk";
// 单块上限 4MB（MV3 结构化克隆对 ArrayBuffer 无额外配额限制，4MB 块足够小）
export const CHUNK_SIZE = 4 * 1024 * 1024;
// 音频体积上限 200MB
const MAX_BYTES = 200 * 1024 * 1024;

export const MAX_AUDIO_BYTES = MAX_BYTES;

// ===== background 侧 =====

// 为本次下载添加 Referer/Origin 会话规则（dnr 为 MV3 专属 API，仅 background 可用）
async function addDownloadRules() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ASR_AUDIO_SESSION_RULE_ID],
    addRules: [
      {
        id: ASR_AUDIO_SESSION_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: "https://www.bilibili.com" },
            { header: "Origin", operation: "set", value: "https://www.bilibili.com" }
          ]
        },
        condition: {
          urlFilter: "||bilivideo.com",
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ]
  });
}

// 清掉本下载会话添加的规则（updateSessionRules 同时支持移除与添加）；
// 成功失败都要调（try/finally 兜底）。会话规则随浏览器重启自动清空，
// 无需持久化。
async function removeDownloadRules() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ASR_AUDIO_SESSION_RULE_ID]
  });
}

// HEAD 探大小：超上限直接拒绝，不发起 GET
async function probeSize(url) {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`音频地址不可用（HTTP ${response.status}）`);
  }
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 0 && length > MAX_BYTES) {
    throw new Error("视频过长");
  }
}

// 依次尝试主地址与备用地址下载，返回字节数（数组）。
// 任一次返回体为空则视为失败，继续尝试下一个地址。
async function fetchAudioBytes(urls) {
  for (const url of urls) {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      continue;
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length === 0) {
      continue;
    }
    return buffer;
  }
  throw new Error("音频下载失败");
}

// background 消息处理编排：临时加规则 → HEAD 探大小 → 下载 → 按块回传 →
// 收尾清规则。port 断连视为取消，静默终止（规则仍会被 finally 清理）。
export async function handleAsrDownload({ audioUrl, backupUrls }, port) {
  await addDownloadRules();
  try {
    await probeSize(audioUrl);
    const buffer = await fetchAudioBytes([audioUrl, ...(backupUrls || [])]);

    let seq = 0;
    for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
      const bytes = buffer.slice(offset, offset + CHUNK_SIZE);
      port.postMessage({ type: "chunk", seq, bytes });
      seq += 1;
    }
    port.postMessage({ type: "done", byteLength: buffer.length });
  } catch (error) {
    try {
      port.postMessage({ type: "error", message: error?.message || String(error) });
    } catch {
      // port 已断开，忽略
    }
  } finally {
    await removeDownloadRules();
  }
}

// ===== 页面/内容侧 =====

// 把 ArrayBuffer 切成 ≤CHUNK_SIZE 的 Uint8Array 块（纯函数便于单测）
export function sliceChunks(arrayBuffer) {
  const source = new Uint8Array(arrayBuffer);
  const chunks = [];
  for (let offset = 0; offset < source.length; offset += CHUNK_SIZE) {
    chunks.push(source.slice(offset, offset + CHUNK_SIZE));
  }
  return chunks;
}

// 把块列表按 seq 排好拼回单个 ArrayBuffer（纯函数便于单测）
export function assembleChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

// 页面侧封装：连 background 的下载端口收块，拼回完整 ArrayBuffer。
// 块消息 { type:"chunk", seq, bytes }，收尾 { type:"done", byteLength } 或
// { type:"error", message }；port 意外断连且未收到 done 时报错。
export function downloadAudioViaBackground({ url, backupUrls }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const port = chrome.runtime.connect({ name: ASR_AUDIO_PORT_NAME });
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {
        // ignore
      }
      callback(value);
    };

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "chunk") {
        chunks.push({ seq: msg.seq, bytes: msg.bytes });
        return;
      }
      if (msg.type === "done") {
        const ordered = chunks
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map((item) => item.bytes);
        finish(resolve, assembleChunks(ordered));
        return;
      }
      if (msg.type === "error") {
        finish(reject, new Error(msg.message || "音频下载失败"));
      }
    });

    port.onDisconnect.addListener(() => {
      if (!settled) {
        finish(reject, new Error("音频下载中断：后台连接已断开"));
      }
    });

    port.postMessage({ audioUrl: url, backupUrls: backupUrls || [] });
  });
}
