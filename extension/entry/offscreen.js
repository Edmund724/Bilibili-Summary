// offscreen.js — 隐藏后台页面，负责 SSE 流式请求，避免 Side Panel 被冻结。
// 同时承接 ASR 音频「下载 → 解码 → 切片 → 转写」任务（asr-decode 端口）：
// service worker 无 AudioContext，解码+重采样在这里用 OfflineAudioContext
// 完成；转写引擎与适配器也加载在本 context——音频字节与 API Key 都不出
// offscreen，跨 port 只回传转写文本结果。
import { streamChat } from "../ai/client.js";
import { buildBudgetPlan } from "../ai/budgeter.js";
import { orchestrateMapReduce } from "../ai/map-reduce.js";
import { resolveFollowupContext } from "../ai/followup-router.js";
import { trimRecentTurns } from "../ai/followup-context.js";
import { buildCostGuardNotice } from "../ai/cost-guard.js";
import { MAX_AUDIO_BYTES, ASR_DECODE_TIMEOUT_MS } from "../asr/offscreen-bridge.js";
import { buildChunkPlan, buildWavChunks, makeDecodedBuffer } from "../asr/chunker.js";
import { streamWavChunks } from "../asr/stream-chunker.js";
import { createTranscriptionEngine } from "../asr/engine.js";
import { transcribe as transcribeOpenAi } from "../asr/adapters/openai-transcriptions.js";
import { isFragmentedMp4, adtsFromFmp4, parseAudioSpecificConfig } from "../asr/adts.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { shouldCloseAfterAsrTask } from "./offscreen-lifecycle.js";

let activeAbortController = null;
let pendingCostGuard = null;
let idleTimeoutId = null;
var STREAM_IDLE_TIMEOUT_MS = 90000;

// 同一文档双通道存活计数：聊天（"offscreen-chat" 端口）用计数维护，
// 解码任务（"asr-decode" 端口）用存活端口集合维护——终态判定要排除
// 本次任务的端口自身（done/error 时它还连着），集合比计数少一分监听
// 注册时序依赖。asr-decode 任务终态后由 maybeCloseSelfAfterAsr 据此决定
// 是否自关文档（判定纯函数在 ./offscreen-lifecycle.js）。
let currentChatCount = 0;
const activeAsrPorts = new Set();

// ASR 解码任务中止哨兵：decodeSegment/onChunk 检查 aborted 后抛出，
// 外层 catch 识别后静默退出（不 post error），与「断连视为取消」语义一致。
const ASR_ABORT_SENTINEL = Object.freeze({ asrAborted: true });

function armIdleTimeout(abortController, port) {
  clearIdleTimeout();
  idleTimeoutId = setTimeout(function () {
    if (abortController && !abortController.signal.aborted) {
      abortController.abort();
      port.postMessage({
        type: "error",
        error: "请求超时（90 秒未返回任何数据），已自动中断"
      });
    }
  }, STREAM_IDLE_TIMEOUT_MS);
}

function clearIdleTimeout() {
  if (idleTimeoutId) {
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "asr-decode") {
    activeAsrPorts.add(port);
    port.onDisconnect.addListener(() => {
      activeAsrPorts.delete(port);
    });
    port.onMessage.addListener((msg) => {
      if (!msg || msg.action !== "asr-decode") return;
      handleAsrDecodeTask(msg.task || {}, port);
    });
    return;
  }
  if (!port || port.name !== "offscreen-chat") {
    return;
  }
  // 聊天通道计数：asr-decode 终态自关判定的输入（见 maybeCloseSelfAfterAsr）
  currentChatCount += 1;

  port.onMessage.addListener(async (msg) => {
    if (!msg) return;
    if (msg.action === "stop") {
      abortActiveRequest();
      return;
    }
    if (msg.action === "cost-guard-confirm") {
      if (pendingCostGuard) {
        const resolve = pendingCostGuard.resolve;
        pendingCostGuard = null;
        resolve(msg.ok !== false);
      }
      return;
    }
    if (msg.action !== "chat") return;

    try {
      abortActiveRequest();
      activeAbortController = new AbortController();

      const resolved = await resolveProviderWithKey(port, msg.providerId);
      if (resolved.error) {
        clearActiveRequestState();
        return;
      }
      const { provider, apiKey } = resolved;

      armIdleTimeout(activeAbortController, port);

      // 阶梯分派：预算内（≤100k token）走单次流式；超预算走 Map-Reduce 分段编排。
      const plan = buildBudgetPlan({
        body: Array.isArray(msg.context?.subtitleBody) ? msg.context.subtitleBody : [],
        chapters: Array.isArray(msg.context?.chapters) ? msg.context.chapters : []
      });
      if (plan.mode === "map-reduce") {
        // 追问压缩：已有成稿笔记 + 分段小结时，改走「压缩摘要 + 检索注入 + 单次调用」，
        // 不再重跑 Map-Reduce（token 随追问近乎常数）。
        const followupContext = await resolveFollowupContext({
          context: msg.context || {},
          plan,
          history: Array.isArray(msg.history) ? msg.history : [],
          userPrompt: msg.prompt || ""
        });
        if (followupContext) {
          // 近 N 轮 verbatim 封顶：只带最近几轮历史，token 不随追问轮数增长。
          const trimmedHistory = trimRecentTurns(msg.history);
          const followupResult = await streamChat({
            provider: { ...provider, apiKey },
            context: followupContext,
            userPrompt: msg.prompt || "",
            history: trimmedHistory,
            thinkingLevel: msg.thinkingLevel,
            port,
            signal: activeAbortController.signal,
            onActivity: function () { armIdleTimeout(activeAbortController, port); }
          });
          // 兜底：压缩摘要 + 检索注入仍意外溢出（HTTP context-length）时，绝不静默无输出。
          if (followupResult === "overflow") {
            port.postMessage({ type: "error", error: "追问内容仍超出上下文预算，请换个更具体的问题重试" });
          }
          return;
        }

        // 成本护栏：发起 Map-Reduce 前预估 ≥5 次调用 → 弹确认，可取消。
        const guard = buildCostGuardNotice({
          estimatedCalls: plan.estimatedCalls,
          estimatedTokens: plan.estimatedTokens
        });
        if (guard.shouldPrompt) {
          // 等待用户确认期间暂停空闲超时计时，确认后重新武装。
          clearIdleTimeout();
          const confirmed = await askCostGuard(port, guard.message);
          if (!confirmed) {
            port.postMessage({ type: "stopped", reason: "已取消" });
            return;
          }
          armIdleTimeout(activeAbortController, port);
        }

        await orchestrateMapReduce({
          provider: { ...provider, apiKey },
          context: msg.context || {},
          plan,
          port,
          signal: activeAbortController.signal,
          thinkingLevel: msg.thinkingLevel,
          onProgress: function (notice) {
            // 进度回吐 + 每段完成重挂空闲超时（覆盖下一段模型调用）
            port.postMessage({ type: "notice", data: notice });
            armIdleTimeout(activeAbortController, port);
          }
        });
        return;
      }

      const result = await streamChat({
        provider: { ...provider, apiKey },
        context: msg.context || {},
        userPrompt: msg.prompt || "",
        history: Array.isArray(msg.history) ? msg.history : [],
        thinkingLevel: msg.thinkingLevel,
        port,
        signal: activeAbortController.signal,
        onActivity: function () { armIdleTimeout(activeAbortController, port); }
      });

      // 单次路径 context-length 溢出 → 自动转 Map-Reduce 重试一次
      //（仅一次：map-reduce 各调用自身更短，再溢出就抛出错误；activeAbortController 复用，stop 仍可中止）。
      if (result === "overflow") {
        await orchestrateMapReduce({
          provider: { ...provider, apiKey },
          context: msg.context || {},
          plan,
          port,
          signal: activeAbortController.signal,
          thinkingLevel: msg.thinkingLevel,
          onProgress: function (notice) {
            // 进度回吐 + 每段完成重挂空闲超时（覆盖下一段模型调用）
            port.postMessage({ type: "notice", data: notice });
            armIdleTimeout(activeAbortController, port);
          }
        });
      }
    } catch (e) {
      port.postMessage({ type: "error", error: String(e?.message || e) });
    } finally {
      clearIdleTimeout();
      clearActiveRequestState();
    }
  });

  port.onDisconnect.addListener(() => {
    currentChatCount -= 1;
    if (pendingCostGuard) {
      const resolve = pendingCostGuard.resolve;
      pendingCostGuard = null;
      resolve(false);
    }
    abortActiveRequest();
    clearIdleTimeout();
    clearActiveRequestState();
  });
});

function abortActiveRequest() {
  if (activeAbortController && !activeAbortController.signal.aborted) {
    activeAbortController.abort();
  }
  activeAbortController = null;
}

// asr-decode 任务终态（done / error / 断连取消）后的自关判定，三处终态
// 共用本函数，不得各写一份。本文档同时承载聊天与解码：聊天端口还在
// （currentChatCount > 0）或有其他解码任务在跑（刷新竞态下新任务可能已
// 连上本文档）时保留；否则文档已无承载，自关以释放渲染进程。调用方必须
// 已把终态消息 postMessage 发完——文档关闭后无法再 postMessage。
function maybeCloseSelfAfterAsr(port) {
  // 排除本次终态任务的端口：done/error 时它还连着（页面收到终态后才
  // 断连收尾），断连取消时可能已被断连监听移出——Set.delete 幂等，
  // 两种时序都正确。
  activeAsrPorts.delete(port);
  if (activeAsrPorts.size > 0 || !shouldCloseAfterAsrTask(currentChatCount)) {
    return;
  }
  try {
    const closing = chrome.offscreen.closeDocument();
    // closeDocument 返回 Promise：异步失败（如文档已被并发关闭）同样仅记录
    if (closing && typeof closing.catch === "function") {
      closing.catch((error) => {
        logWarn("[BOC] offscreen closeDocument after asr task failed", {
          error: getErrorMessage(error)
        });
      });
    }
  } catch (error) {
    logWarn("[BOC] offscreen closeDocument after asr task failed", {
      error: getErrorMessage(error)
    });
  }
}

function clearActiveRequestState() {
  activeAbortController = null;
}

// 向侧边栏弹成本护栏确认，等待其回复 { action: "cost-guard-confirm", ok: boolean }。
// 断连时 resolve(false)（视为取消）。
function askCostGuard(port, message) {
  return new Promise((resolve) => {
    pendingCostGuard = { resolve };
    port.postMessage({ type: "cost-guard", data: { message } });
  });
}

// 取「选中的平台 + 其 API Key」：provider 来自 ai-providers-list，key 来自 get-ai-provider-key。
// 任一缺失（平台不存在 / key 读取失败 / 需要 key 但未配置）返回带 error 的对象；成功返回 { provider, apiKey }。
async function resolveProviderWithKey(port, providerId) {
  const providersResp = await chrome.runtime.sendMessage({ type: "ai-providers-list" });
  const list = (providersResp?.providers || []).filter(p => p.enabled);
  const provider = list.find(p => p.id === providerId) || null;
  if (!provider) {
    port.postMessage({ type: "error", error: "未找到选中的平台" });
    return { error: true };
  }

  const keysResp = await chrome.runtime.sendMessage({ type: "get-ai-provider-key", providerId });
  if (!keysResp?.ok) {
    port.postMessage({ type: "error", error: keysResp?.error || "读取 API Key 失败" });
    return { error: true };
  }
  const apiKey = String(keysResp.apiKey || "").trim();
  if (provider.requiresKey !== false && !apiKey) {
    port.postMessage({ type: "error", error: "该平台 API Key 未配置" });
    return { error: true };
  }
  return { provider: { ...provider, apiKey }, apiKey };
}

// ===== ASR 下载 + 解码 + 切片 + 转写任务 =====

// type → 适配器映射（原 pipeline.js ADAPTERS 表随转写迁入 offscreen）。
// 映射表缺 type 时发 error，页面显示「暂不支持的平台类型」。
const ASR_ADAPTERS = {
  "openai-transcriptions": { adapter: transcribeOpenAi, concurrency: 5 }
};

// ASR 运行时配置：offscreen 直调 background 的 get-asr-runtime-config 取
// provider + Key + 语言（与 AI 聊天 resolveProviderWithKey 走同一通道）。
// Key 只进本 context，不经过页面、也不放进 port 任务消息。5s 超时竞速镜像
// 原 fetcher requestAsrRuntimeConfig 的 race 模式。
async function requestAsrRuntimeConfig(timeoutMs = 5000) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("get-asr-runtime-config timeout")), timeoutMs);
  });
  const response = await Promise.race([
    chrome.runtime.sendMessage({ type: "get-asr-runtime-config" }),
    timeoutPromise
  ]);
  if (!response?.ok) {
    throw new Error(response?.error || "get-asr-runtime-config failed");
  }
  return response;
}

// 配置级缺失/关闭/无激活 provider → code "asr-skip"：页面 fallback catch 后
// 映射为静默 skip（与设置闸门 skip 同语义，零用户可见错误）。reason 为结构化
// 原因（"asr-disabled" / "no-asr-config"），随 port 错误消息透传回页面、最终落
// clipState.noSubtitleReason 供 sidepanel 按原因提示；消息失败/超时的 asr-skip
// 不带 reason（未知，页面归 null 走通用文案）。
function makeAsrSkipError(cause, reason = "") {
  const error = new Error(String(cause?.message || cause || "ASR 配置缺失"));
  error.code = "asr-skip";
  if (reason) {
    error.reason = reason;
  }
  return error;
}

// 从运行时快照解析 provider（附 Key 与生效语言）。快照关闭 / 无激活平台 /
// 激活平台不在列表中 → 抛 asr-skip（带结构化 reason，见 makeAsrSkipError）。
export function resolveAsrProvider(config) {
  if (config.asrAutoFallback === false) {
    throw makeAsrSkipError("ASR 自动回退未开启", "asr-disabled");
  }
  const activeId = String(config.activeAsrProviderId || "").trim();
  const activeProvider = (config.providers || []).find((p) => p.id === activeId);
  if (!activeProvider) {
    throw makeAsrSkipError("没有激活的语音识别平台", "no-asr-config");
  }
  // 生效转写语言：全局 asrLanguage 设置（popup 顶部切换，默认 auto）；
  // auto 不传语言参数，交服务端自动检测。
  const provider = { ...activeProvider, apiKey: String(config.activeKey || "") };
  provider.language = config.asrLanguage || "auto";
  return provider;
}

// 收 { task: { audioUrl, backupUrls } }：在 offscreen 文档内完成「下载（HEAD
// 探大小、主备 URL 轮换）→ 解码 → 校验 → 切片 → 逐片转写」，每片转写完成
// 即把文本结果经 port 发回页面（chrome.runtime 消息是 JSON 序列化，二进制
// 跨 context 会变成数字键对象字节全损——音频字节与 API Key 都不出本 context，
// 跨 port 只传文本结果与小 JSON）。provider/Key/语言由本侧直调 background
// 获取，配置级问题以 code "asr-skip" 结束。
async function handleAsrDecodeTask(task, port) {
  let aborted = false;
  port.onDisconnect.addListener(() => {
    // 断连视为取消：下载/解码/调度各处检查标志并静默退出（原 asr-audio 通道风格）
    aborted = true;
    // 断连即终态：页面已不再等结果，按需自关文档。下方各早退点（下载/
    // 解码/引擎关闭后的 aborted 分支）都经由本监听覆盖，不再各自挂判定。
    maybeCloseSelfAfterAsr(port);
  });
  try {
    const audioUrl = String(task?.audioUrl || "").trim();
    if (!audioUrl) {
      throw new Error("asr-decode 任务参数不完整");
    }

    // 运行时配置先行：配置级问题不做任何下载/解码。
    let provider;
    try {
      provider = resolveAsrProvider(await requestAsrRuntimeConfig());
    } catch (error) {
      if (error?.code === "asr-skip") {
        throw error;
      }
      // 消息失败/超时也按配置缺失处理（页面静默 skip，与原 fallback 同语义）
      logWarn("[BOC] get-asr-runtime-config failed, skipping asr task", {
        error: getErrorMessage(error)
      });
      throw makeAsrSkipError(error);
    }

    // 适配器与切片计划由 provider.type 决定（原 pipeline 的 ADAPTERS 表与
    // buildChunkPlan 调用随转写迁入 offscreen，页面不再感知平台类型）。
    const adapterEntry = ASR_ADAPTERS[provider.type];
    if (!adapterEntry) {
      throw new Error("暂不支持的平台类型：" + provider.type);
    }
    const chunkSeconds = buildChunkPlan(provider.type).chunkSeconds;

    // 转写调度引擎：解码流式产片 push 进活队列（解码与转写流水线重叠），
    // 每片完成即经 onChunkResult 把文本结果发回页面，不等全部完成。
    const engine = createTranscriptionEngine({
      transcribe: (chunk, { onProgress }) =>
        adapterEntry.adapter({
          wavBlob: chunk.wavBlob,
          startSec: chunk.startSec,
          durationSec: chunk.durationSec,
          provider,
          signal: undefined,
          onProgress
        }),
      isAborted: () => aborted,
      concurrency: adapterEntry.concurrency,
      onChunkResult: (chunk, result) => {
        // engine 交付的单片形状 { ...adapterResult, durationSec }；拆开回传，
        // result 只含适配器结果（text/segments?/…），durationSec 为兄弟字段。
        const { durationSec, ...adapterResult } = result;
        port.postMessage({
          type: "chunk-result",
          index: chunk.index,
          startSec: chunk.startSec,
          durationSec,
          result: adapterResult
        });
      },
      // 引擎产出的进度文本（语音识别中 N 片…）原样中继给页面
      onProgress: (text) => {
        try {
          port.postMessage({ type: "progress", text });
        } catch {
          // port 已断开，忽略
        }
      }
    });

    const audioBytes = await fetchAudioBytes([audioUrl, ...(task?.backupUrls || [])], aborted);
    if (aborted) return;

    // 主路径：fMP4 音轨拆 ADTS 分段，逐段解码 + 流式切片喂入转写引擎（有界
    // 内存）。历史背景：旧实现把整条音轨一次性 decodeAudioData——4 小时视频在
    // 48kHz 双声道下产出 ~6.4GB Float32 AudioBuffer，offscreen 渲染进程被 OOM
    // 击杀，扩展整包崩溃。分段后峰值降到 O(单段 + 单片)，音轨长度不再受内存
    // 限制。段级解码降级（Q8a）：单段失败重试 1 次，仍失败跳过计数继续。
    const fragment = isFragmentedMp4(audioBytes);
    const segments = fragment ? adtsFromFmp4(audioBytes, parseAudioSpecificConfig(audioBytes) || {}) : [];
    if (fragment && segments.length === 0) {
      // 判为 fMP4 却无音帧可提取：显式失败，绝不落入下方全量解码（会再次 OOM）
      throw new Error("音频解码失败：无法从 fMP4 提取音帧");
    }

    let totalChunks;
    let skippedSegments = 0;
    if (segments.length > 0) {
      const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioCtor) {
        throw new Error("当前环境没有 AudioContext，无法解码");
      }
      const audioCtx = new AudioCtor();
      try {
        const stop = () => {
          if (aborted) throw ASR_ABORT_SENTINEL;
        };
        const stream = await streamWavChunks(segments, {
          chunkSeconds,
          decodeSegment: (seg) => {
            stop();
            return decodeSegmentTo16kMono(seg, audioCtx);
          },
          onChunk: (chunk) => {
            stop();
            engine.push(chunk);
          },
          decodeRetries: 1,
          skipFailedSegments: true,
          isAbortError: (error) => error === ASR_ABORT_SENTINEL
        });
        totalChunks = stream.totalChunks;
        skippedSegments = stream.skippedSegments;
      } finally {
        audioCtx.close();
      }
    } else {
      // 非 fMP4（B 站 fnval=16 音轨均为 fMP4，理论不会走到）：历史行为全量解码。
      // 静音/零时长校验 + 切片（chunkSeconds<=0 不切，整段一片，与 chunker
      // 既有语义一致）。data 是裸 Float32Array，须经 makeDecodedBuffer 适配为
      // chunker 契约的 AudioBuffer 鸭子类型（sampleRate 16k + diagnostic），
      // 否则会被误报「时长为零」。
      const { data, diagnostic } = await decodeTo16kMono(audioBytes, 0);
      const chunks = buildWavChunks(makeDecodedBuffer(data, { diagnostic }), { chunkSeconds });
      for (const chunk of chunks) {
        if (aborted) return;
        engine.push(chunk);
      }
      totalChunks = chunks.length;
    }
    if (aborted) return;

    // close() 汇总：acceptedChunks/completedChunks/failedChunks/droppedByAbort。
    // 等待全部在途片消化（最后一片的转写可能晚于解码结束数秒）。
    const summary = await engine.close();
    if (aborted) return;
    // 全部段解码失败（零片产出）才算整体失败；个别段/片失败已跳过计数。
    if (!(summary.acceptedChunks > 0)) {
      throw new Error("音频切片为空，无法转写");
    }
    port.postMessage({
      type: "done",
      totalChunks: summary.acceptedChunks,
      skippedSegments,
      failedChunks: summary.failedChunks
    });
    // 终态消息发完才判定自关（文档关闭后无法再 postMessage）
    maybeCloseSelfAfterAsr(port);
  } catch (e) {
    if (aborted) {
      return;
    }
    try {
      const payload = { type: "error", error: String(e?.message || e) };
      if (e?.code) {
        payload.code = e.code;
      }
      if (e?.reason) {
        payload.reason = e.reason;
      }
      port.postMessage(payload);
    } catch {
      // port 已断开，忽略
    }
    // error 终态消息发完再判定自关（断连取消已在上方 aborted 早退 +
    // 断连监听处覆盖，走不到这里）
    maybeCloseSelfAfterAsr(port);
  }
}

// 依次尝试主地址与备用地址下载，返回字节数组。HEAD 先探大小：超上限直接
// 拒绝（不发起 GET），报「视频过长」；HEAD 非 ok 也照常走 GET（部分 CDN
// 不支持 HEAD）。任一次 GET 非 ok 或返回体为空视为失败，继续试下一个地址。
async function fetchAudioBytes(urls, aborted) {
  let headDone = false;
  for (const url of urls) {
    if (aborted) return null;
    if (!headDone) {
      await probeSize(url);
      headDone = true;
    }
    if (aborted) return null;
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

// HEAD 探大小：Content-Length 超上限直接拒绝（超长视频不下载不解码）
async function probeSize(url) {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) {
    // HEAD 非 ok：部分 CDN 不支持 HEAD，交给 GET 兜底
    return;
  }
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 0 && length > MAX_AUDIO_BYTES) {
    throw new Error("视频过长");
  }
}

// 解码输入字节为 16kHz 单声道 Float32Array（解码 + 重采样 + 起点对齐）。
// AudioContext 解码用 detach 语义的 decodeAudioData，传入副本避免破坏
// 数据。startSec 仅用于对齐采样起点（本链路恒传 0，整段从头解码）。
// 降级路径：B 站 DASH 音轨是 fragmented MP4（moof/mdat 分片），Chrome 的
// decodeAudioData 不支持（报 "Unable to decode audio data"），先尝试直接
// 解码，失败且判定为 fMP4 时把 AAC 帧包装成 ADTS 流重试（Chrome 支持 ADTS）。
async function decodeTo16kMono(audioBytes, startSec = 0) {
  const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtor) {
    throw new Error("当前环境没有 AudioContext，无法解码");
  }
  const audioCtx = new AudioCtor();
  try {
    let decoded = null;
    let decodeError = null;
    try {
      decoded = await withTimeout(audioCtx.decodeAudioData(bytesToArrayBuffer(audioBytes)), ASR_DECODE_TIMEOUT_MS);
    } catch (error) {
      decodeError = error;
    }

    if (!decoded) {
      // fMP4 音轨已由句柄外流式路径（streamWavChunks）接管；此处落到
      // decodeAudioData 失败即整段不可解（非 fMP4 的异常容器），直接报错。
      throw decodeError || new Error("音频解码失败：无法解码音频数据");
    }

    const targetRate = 16000;
    const outLength = Math.max(1, Math.round(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, outLength, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await withTimeout(offline.startRendering(), ASR_DECODE_TIMEOUT_MS);
    const mono = rendered.getChannelData(0);
    if (!(mono.length > 0)) {
      throw new Error("音频解码失败：解码结果为空采样");
    }
    // 诊断信息：解码时长与峰值幅度。峰值≈0 说明解码出来是静音——用于区分
    // "视频真没人声"与"音轨获取/容器解码出了问题"（B 站 fMP4 有兼容性风险）。
    // 校验（静音/零时长显式报错）由 chunker 的 validateDecodedAudio 统一负责。
    let peak = 0;
    for (let i = 0; i < mono.length; i += 1) {
      const abs = Math.abs(mono[i]);
      if (abs > peak) peak = abs;
    }
    const diagnostic = { durationSec: Math.round(rendered.duration * 100) / 100, peak };
    console.info("[BOC][asr-decode] 解码完成", diagnostic);
    const startSample = Math.round(Number(startSec || 0) * targetRate);
    if (startSample <= 0 || startSample >= mono.length) {
      return { data: mono, diagnostic };
    }
    return { data: mono.subarray(startSample), diagnostic };
  } finally {
    audioCtx.close();
  }
}

// 单段 ADTS 解码 → 16kHz 单声道 Float32Array（流式路径逐段调用）。
// 段级解码 + 段级重采样：Chrome 的 decodeAudioData 对超长 ADTS 流
// （完整音轨 ~46MB / 96min）解码失败，实测每段（~10 moof / 1MB）可正常解码。
async function decodeSegmentTo16kMono(segment, audioCtx) {
  const targetRate = 16000;
  const segmentDecoded = await withTimeout(
    audioCtx.decodeAudioData(bytesToArrayBuffer(segment)),
    ASR_DECODE_TIMEOUT_MS
  );
  const segLen = Math.max(1, Math.round(segmentDecoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, segLen, targetRate);
  const src = offline.createBufferSource();
  src.buffer = segmentDecoded;
  src.connect(offline.destination);
  src.start(0);
  const segMono = (await withTimeout(offline.startRendering(), ASR_DECODE_TIMEOUT_MS)).getChannelData(0);
  if (!(segMono.length > 0)) {
    throw new Error("音频解码失败：解码结果为空采样");
  }
  return segMono;
}

function bytesToArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) {
    return bytes.slice(0);
  }
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  if (Array.isArray(bytes)) {
    return new Uint8Array(bytes).buffer;
  }
  throw new Error("无法识别的音频数据格式");
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("音频解码超时")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
