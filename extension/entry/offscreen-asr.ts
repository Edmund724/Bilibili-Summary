// offscreen-asr.ts — ASR 音频「下载 → 解码 → 切片 → 转写」全链路（自
// entry/offscreen.js 拆出）：service worker 无 AudioContext，解码 + 重采样在
// offscreen 文档里用 OfflineAudioContext 完成；转写引擎与适配器也加载在本
// context——音频字节与 API Key 都不出 offscreen，跨 port 只回传转写文本结果。
//
// 模块形状参照仓库注入惯例（如 asr/fallback.js 的 createAsrFallback(deps)）：
// createAsrDecodeHandler({ onTaskTerminal }) 返回 "asr-decode" 端口的任务执行
// 函数。文档生命周期簿记（存活 asr 端口集合 / 聊天端口计数 / 自关判定）留在
// entry/offscreen.ts，任务终态（断连取消 / done / error）经注入的
// onTaskTerminal(port) 回调通知入口层做自关判定——本模块不感知簿记状态。
// chrome.runtime / AudioContext 等全局在 offscreen 环境固定可直接用；纯逻辑
// （resolveAsrProvider / makeAsrSkipError）保持模块级可导出可测。

import {
  MAX_AUDIO_BYTES,
  ASR_DECODE_TIMEOUT_MS,
  ASR_MSG_PROGRESS,
  ASR_MSG_CHUNK_RESULT,
  ASR_MSG_DONE,
  ASR_MSG_ERROR
} from "../asr/protocol.js";
import { buildChunkPlan, buildWavChunks, makeDecodedBuffer } from "../asr/chunker.js";
import { streamWavChunks } from "../asr/stream-chunker.js";
import { createTranscriptionEngine as _createTranscriptionEngine } from "../asr/engine.js";
import { transcribe as transcribeOpenAi } from "../asr/adapters/openai-transcriptions.js";
import { isFragmentedMp4, createAdtsExtractor, parseAudioSpecificConfig } from "../asr/adts.js";
import { ASR_CONCURRENCY } from "../shared/offscreen-constants.js";
import { getErrorMessage, withTimeout } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import type { AsrProvider } from "../asr/asr-provider-store.js";

// 本地接口描述 offscreen-asr 实际消费的 asr/* 契约子集（如 Summary 只看
// accepted/failed 两个字段），导入函数经断言收窄到该形状，运行时零变化。
// TODO: 与 engine.ts/chunker.ts 导出的完整类型对账后可收拢（chunk 形状
// WavChunk vs TranscribeChunk 需先统一）。

interface AsrChunk {
  index: number;
  startSec: number;
  durationSec: number;
  wavBlob: Blob;
}

interface TranscriptionEngineOptions {
  transcribe: (chunk: AsrChunk, ctx: { onProgress: (text: string) => void }) => Promise<Record<string, unknown>>;
  isAborted: () => boolean;
  concurrency: number;
  onChunkResult: (chunk: AsrChunk, result: Record<string, unknown>) => void;
  onProgress: (text: string) => void;
}

interface TranscriptionEngineSummary {
  acceptedChunks: number;
  failedChunks: number;
}

interface TranscriptionEngine {
  push: (chunk: AsrChunk) => void;
  close: () => Promise<TranscriptionEngineSummary>;
}

const createTranscriptionEngine = _createTranscriptionEngine as unknown as (
  opts: TranscriptionEngineOptions
) => TranscriptionEngine;

interface WavChunk {
  index: number;
  startSec: number;
  durationSec: number;
  wavBlob: Blob;
}

interface BuildWavChunksResult {
  chunks: WavChunk[];
}

const _buildWavChunks = buildWavChunks as unknown as (
  buffer: AudioBuffer,
  opts: { chunkSeconds: number }
) => WavChunk[];

interface DecodedBufferResult {
  data: Float32Array;
  diagnostic: { durationSec: number; peak: number };
}

const _makeDecodedBuffer = makeDecodedBuffer as unknown as (
  data: Float32Array,
  meta: { diagnostic: { durationSec: number; peak: number } }
) => AudioBuffer;

interface StreamWavChunksResult {
  totalChunks: number;
  skippedSegments: number;
}

interface StreamWavChunksOptions {
  chunkSeconds: number;
  decodeSegment: (segment: Uint8Array) => Promise<Float32Array>;
  onChunk: (chunk: WavChunk) => void;
  decodeRetries: number;
  skipFailedSegments: boolean;
  isAbortError: (error: unknown) => boolean;
}

const _streamWavChunks = streamWavChunks as unknown as (
  source: AsyncIterable<Uint8Array>,
  opts: StreamWavChunksOptions
) => Promise<StreamWavChunksResult>;

// ASR 解码任务中止哨兵：decodeSegment/onChunk 检查 aborted 后抛出，
// 外层 catch 识别后静默退出（不 post error），与「断连视为取消」语义一致。
const ASR_ABORT_SENTINEL = Object.freeze({ asrAborted: true });

// type → 适配器映射（原 pipeline.js ADAPTERS 表随转写迁入 offscreen）。
// 映射表缺 type 时发 error，页面显示「暂不支持的平台类型」。并发上限与
// asr/engine.js 调度默认共用 shared/offscreen-constants.js 的 ASR_CONCURRENCY。
const ASR_ADAPTERS = {
  "openai-transcriptions": { adapter: transcribeOpenAi, concurrency: ASR_CONCURRENCY }
};

export interface AsrRuntimeConfig {
  asrAutoFallback?: boolean;
  activeAsrProviderId?: string;
  providers?: AsrProvider[];
  activeKey?: string;
  asrLanguage?: string;
}

// ASR 运行时配置：offscreen 直调 background 的 get-asr-runtime-config 取
// provider + Key + 语言（与 AI 聊天 resolveProviderWithKey 走同一通道）。
// Key 只进本 context，不经过页面、也不放进 port 任务消息。5s 超时竞速镜像
// 原 fetcher requestAsrRuntimeConfig 的 race 模式。
async function requestAsrRuntimeConfig(timeoutMs = 5000): Promise<AsrRuntimeConfig> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("get-asr-runtime-config timeout")), timeoutMs);
  });
  const response = await Promise.race([
    chrome.runtime.sendMessage({ type: "get-asr-runtime-config" }),
    timeoutPromise
  ]);
  if (!response || typeof response !== "object" || !(response as { ok?: boolean }).ok) {
    throw new Error((response as { error?: string })?.error || "get-asr-runtime-config failed");
  }
  return response as AsrRuntimeConfig;
}

// 配置级缺失/关闭/无激活 provider → code "asr-skip"：页面 fallback catch 后
// 映射为静默 skip（与设置闸门 skip 同语义，零用户可见错误）。reason 为结构化
// 原因（"asr-disabled" / "no-asr-config"），随 port 错误消息透传回页面、最终落
// clipState.noSubtitleReason 供 sidepanel 按原因提示；消息失败/超时的 asr-skip
// 不带 reason（未知，页面归 null 走通用文案）。
export function makeAsrSkipError(cause: unknown, reason = ""): Error & { code: string; reason?: string } {
  const error = new Error(String((cause as Error | undefined)?.message || cause || "ASR 配置缺失"));
  (error as Error & { code: string }).code = "asr-skip";
  if (reason) {
    (error as Error & { code: string; reason: string }).reason = reason;
  }
  return error as Error & { code: string; reason?: string };
}

// 从运行时快照解析 provider（附 Key 与生效语言）。快照关闭 / 无激活平台 /
// 激活平台不在列表中 → 抛 asr-skip（带结构化 reason，见 makeAsrSkipError）。
export function resolveAsrProvider(config: AsrRuntimeConfig): AsrProvider {
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

export interface AsrTask {
  audioUrl?: string;
  backupUrls?: string[];
}

export interface AsrDecodePort extends chrome.runtime.Port {}

export interface CreateAsrDecodeHandlerDeps {
  onTaskTerminal: (port: chrome.runtime.Port) => void;
}

// 收 { task: { audioUrl, backupUrls } }：在 offscreen 文档内完成「下载（HEAD
// 探大小、主备 URL 轮换）→ 解码 → 校验 → 切片 → 逐片转写」，每片转写完成
// 即把文本结果经 port 发回页面（chrome.runtime 消息是 JSON 序列化，二进制
// 跨 context 会变成数字键对象字节全损——音频字节与 API Key 都不出本 context，
// 跨 port 只传文本结果与小 JSON）。provider/Key/语言由本侧直调 background
// 获取，配置级问题以 code "asr-skip" 结束。
export function createAsrDecodeHandler({ onTaskTerminal }: CreateAsrDecodeHandlerDeps) {
  return async function handleAsrDecodeTask(rawTask: unknown, port: AsrDecodePort): Promise<void> {
    const task = rawTask as AsrTask;
    let aborted = false;
    port.onDisconnect.addListener(() => {
      // 断连视为取消：下载/解码/调度各处检查标志并静默退出（原 asr-audio 通道风格）
      aborted = true;
      // 断连即终态：页面已不再等结果，通知入口层做自关判定。下方各早退点
      // （下载/解码/引擎关闭后的 aborted 分支）都经由本监听覆盖，不再各自挂判定。
      onTaskTerminal(port);
    });
    try {
      const audioUrl = String(task?.audioUrl || "").trim();
      if (!audioUrl) {
        throw new Error("asr-decode 任务参数不完整");
      }

      // 运行时配置先行：配置级问题不做任何下载/解码。
      let provider: AsrProvider;
      try {
        provider = resolveAsrProvider(await requestAsrRuntimeConfig());
      } catch (error) {
        if ((error as { code?: string }).code === "asr-skip") {
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
      const adapterEntry = ASR_ADAPTERS[provider.type as keyof typeof ASR_ADAPTERS];
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
          const { durationSec, ...adapterResult } = result as { durationSec: number } & Record<string, unknown>;
          port.postMessage({
            type: ASR_MSG_CHUNK_RESULT,
            index: chunk.index,
            startSec: chunk.startSec,
            durationSec,
            result: adapterResult
          });
        },
        // 引擎产出的进度文本（语音识别中 N 片…）原样中继给页面
        onProgress: (text) => {
          try {
            port.postMessage({ type: ASR_MSG_PROGRESS, text });
          } catch {
            // port 已断开，忽略
          }
        }
      });

      // 下载侧流式化：fetch + getReader 增量读，fMP4 判定收满 4MB（或流结束）
      // 判一次，ADTS 段完成即产出——峰值内存 O(下载缓冲窗口 + 单段 + 单片），
      // 音轨长度与内存解耦。主备 URL 轮换、HEAD 探大小、abort 检查与错误文案
      // 语义与原 fetchAudioBytes（整段 arrayBuffer 常驻 ≤200MB）逐行对应。
      const source = streamAudioSegments([audioUrl, ...(task?.backupUrls || [])], () => aborted);
      const first = await source.next();
      if (first.done) {
        // 生成器耗尽只发生在 abort 早退（全部 URL 失败/空体时直接抛「音频下载失败」）
        return;
      }

      let totalChunks: number | undefined;
      let skippedSegments = 0;
      if (first.value.raw) {
        // 非 fMP4（B 站 fnval=16 音轨均为 fMP4，理论不会走到）：历史行为全量解码。
        // 静音/零时长校验 + 切片（chunkSeconds<=0 不切，整段一片，与 chunker
        // 既有语义一致）。data 是裸 Float32Array，须经 makeDecodedBuffer 适配为
        // chunker 契约的 AudioBuffer 鸭子类型（sampleRate 16k + diagnostic），
        // 否则会被误报「时长为零」。
        const { data, diagnostic } = await decodeTo16kMono(first.value.raw, 0);
        const chunks = _buildWavChunks(_makeDecodedBuffer(data, { diagnostic }), { chunkSeconds });
        for (const chunk of chunks) {
          if (aborted) return;
          engine.push(chunk);
        }
        totalChunks = chunks.length;
      } else {
        // 主路径：fMP4 音轨拆 ADTS 分段，逐段解码 + 流式切片喂入转写引擎（有界
        // 内存）。历史背景：旧实现把整条音轨一次性 decodeAudioData——4 小时视频在
        // 48kHz 双声道下产出 ~6.4GB Float32 AudioBuffer，offscreen 渲染进程被 OOM
        // 击杀，扩展整包崩溃。分段后峰值降到 O(单段 + 单片），音轨长度不再受内存
        // 限制。段级解码降级（Q8a）：单段失败重试 1 次，仍失败跳过计数继续。
        const AudioCtor = (globalThis as typeof globalThis & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext || (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtor) {
          throw new Error("当前环境没有 AudioContext，无法解码");
        }
        const audioCtx = new AudioCtor();
        try {
          const stop = () => {
            if (aborted) throw ASR_ABORT_SENTINEL;
          };
          // 段来源：首个已就绪的段 + 下载流后续段（下载/提帧/解码/切片全流水，
          // 任何时刻至多持有一个待解码段）。判为 fMP4 但整流后无音帧时生成器
          // 抛「无法从 fMP4 提取音帧」——显式失败，绝不落入上方全量解码（会再次 OOM）。
          async function* segmentSource() {
            yield (first.value as StreamAudioYield).segment!;
            for await (const item of source) {
              if (aborted) return;
              yield (item as StreamAudioYield).segment!;
            }
          }
          const stream = await _streamWavChunks(segmentSource(), {
            chunkSeconds,
            decodeSegment: (seg) => {
              stop();
              return resampleTo16kMono(audioCtx, seg);
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
        type: ASR_MSG_DONE,
        totalChunks: summary.acceptedChunks,
        skippedSegments,
        failedChunks: summary.failedChunks
      });
      // 终态消息发完才通知入口层自关判定（文档关闭后无法再 postMessage）
      onTaskTerminal(port);
    } catch (e) {
      if (aborted) {
        return;
      }
      try {
        const payload: Record<string, unknown> = { type: ASR_MSG_ERROR, error: String((e as Error | undefined)?.message || e) };
        if ((e as { code?: string }).code) {
          payload.code = (e as { code: string }).code;
        }
        if ((e as { reason?: string }).reason) {
          payload.reason = (e as { reason: string }).reason;
        }
        port.postMessage(payload);
      } catch {
        // port 已断开，忽略
      }
      // error 终态消息发完再通知入口层自关判定（断连取消已在上方 aborted 早退 +
      // 断连监听处覆盖，走不到这里）
      onTaskTerminal(port);
    }
  };
}

interface StreamAudioYield {
  segment?: Uint8Array;
  raw?: Uint8Array;
}

// 流式下载音频并产出 ADTS 段（导出仅供测试；fetch/probeSize 为全局注入面）。
// 替代原 fetchAudioBytes 的「整段 response.arrayBuffer() 常驻」：GET 后用
// response.body.getReader() 增量读，每个 chunk 先喂 fMP4 头部判定所需的缓冲
// （收满 HEAD_PROBE_LIMIT 或流结束时判一次，结果缓存），判为 fMP4 则把攒下
// 的头部与后续 chunk 逐个喂 createAdtsExtractor，段完成即 yield（不攒全量）。
// 产出形状：
//   { segment } — 一个已完成分组的 ADTS 段（Uint8Array，fMP4 主路径）
//   { raw }     — 非 fMP4 兜底：整段原始字节一次交出（全量缓冲，理论不走）
// 下载侧语义与原 fetchAudioBytes 一致：HEAD 仅在首个 URL 前探一次大小；任一
// GET 非 ok 或空体换下一个地址；全部失败抛「音频下载失败」。判为 fMP4 但整流
// 后无音帧：抛「无法从 fMP4 提取音帧」（显式失败，绝不落入全量解码）。
export async function* streamAudioSegments(
  urls: string[],
  isAborted: () => boolean
): AsyncGenerator<StreamAudioYield, void, unknown> {
  // 头部判定缓冲上限：4MB，与 isFragmentedMp4 自身的扫描上限（1 << 22）一致
  const HEAD_PROBE_LIMIT = 1 << 22;
  let headDone = false;
  for (const url of urls) {
    if (isAborted()) return;
    if (!headDone) {
      await probeSize(url);
      headDone = true;
    }
    if (isAborted()) return;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      continue;
    }
    const body = response.body;
    if (!(body && typeof body.getReader === "function")) {
      // 异常环境没有流式 body：退回一次性读取（行为等价旧的全量缓冲实现）
      const raw = new Uint8Array(await response.arrayBuffer());
      if (raw.length === 0) {
        continue;
      }
      if (isFragmentedMp4(raw)) {
        const extractor = createAdtsExtractor(parseAudioSpecificConfig(raw) || {});
        for (const seg of extractor.push(raw)) yield { segment: seg };
        for (const seg of extractor.flush()) yield { segment: seg };
        if (extractor.frameCount === 0) {
          throw new Error("音频解码失败：无法从 fMP4 提取音帧");
        }
      } else {
        yield { raw };
      }
      return;
    }
    const reader = body.getReader();
    try {
      // 增量读状态：判定前字节攒进 head（≤4MB）；判为 fMP4 后一次性喂解析器、
      // 后续 chunk 直通；判为非 fMP4 则转入 rawParts 全量收集（兜底路径）。
      let extractor: ReturnType<typeof createAdtsExtractor> | null = null;
      let head: Uint8Array | null = null;
      let decided = false;
      let isFmp4 = false;
      let rawParts: Uint8Array[] | null = null;
      const decide = () => {
        isFmp4 = isFragmentedMp4(head || new Uint8Array(0));
        decided = true;
        if (isFmp4) {
          // moov 在头部缓冲里（B 站 moov 极小，必在首个 moof 前），ASC 判定
          // 失败由 extractor 默认配置兜底（与原 parseAudioSpecificConfig || {} 一致）
          extractor = createAdtsExtractor(parseAudioSpecificConfig(head || new Uint8Array(0)) || {});
        } else {
          rawParts = [];
        }
        // head 留给调用方在判定后统一转交下游（解析器或全量收集）
      };
      while (true) {
        if (isAborted()) {
          return; // finally 里 cancel 连接，静默退出
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value && value.length > 0)) continue;
        if (!decided) {
          head = head ? concatBytes(head, value) : value;
          if (head.length >= HEAD_PROBE_LIMIT) decide();
        }
        if (decided && isFmp4 && head) {
          // 判定后把攒下的头部一次性喂入解析器（头部包含刚到的 value）
          const headBytes = head;
          head = null;
          for (const seg of extractor!.push(headBytes)) yield { segment: seg };
        } else if (decided && isFmp4) {
          for (const seg of extractor!.push(value)) yield { segment: seg };
        } else if (decided) {
          // 非 fMP4 兜底全量收集：判定当轮攒下的头部里已含本 chunk
          rawParts!.push(head || value);
          head = null;
        }
      }
      if (!decided) decide(); // 流结束仍未收满 4MB：用已有头部判定
      if (isFmp4) {
        // 收尾：把头部缓冲喂给解析器 + 最后不足 10 moof 的段
        if (head) {
          const headBytes = head;
          head = null;
          for (const seg of extractor!.push(headBytes)) yield { segment: seg };
        }
        for (const seg of extractor!.flush()) yield { segment: seg };
        if (extractor!.frameCount === 0) {
          throw new Error("音频解码失败：无法从 fMP4 提取音帧");
        }
        return;
      }
      // 非 fMP4 兜底：整段全量缓冲后一次交出；空体视为本次 GET 失败，换下一个 URL
      if (head) {
        rawParts!.push(head);
        head = null;
      }
      const total = rawParts!.reduce((n, part) => n + part.length, 0);
      if (total === 0) {
        continue;
      }
      const raw = new Uint8Array(total);
      let off = 0;
      for (const part of rawParts!) {
        raw.set(part, off);
        off += part.length;
      }
      yield { raw };
      return;
    } finally {
      try {
        reader.cancel();
      } catch {
        // 流已结束/已关闭，忽略
      }
    }
  }
  throw new Error("音频下载失败");
}

// 拼接两段字节（fMP4 头部判定缓冲累积用，仅小缓冲 ≤4MB）
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// HEAD 探大小：Content-Length 超上限直接拒绝（超长视频不下载不解码）
async function probeSize(url: string): Promise<void> {
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

// 共用解码管线：音频字节 → 16kHz 单声道 Float32Array（decodeAudioData 解码 +
// OfflineAudioContext 重采样 + 空采样校验）。复用调用方传入的 AudioContext：
// fMP4 分段路径整条音轨共用一个、由 handleAsrDecodeTask 在 finally 里统一
// close；全量路径经 decodeTo16kMono 自建自关。decodeAudioData 是 detach 语义，
// bytesToArrayBuffer 传副本避免破坏数据。段级解码 + 段级重采样：Chrome 的
// decodeAudioData 对超长 ADTS 流（完整音轨 ~46MB / 96min）解码失败，实测每段
// （~10 moof / 1MB）可正常解码。
async function resampleTo16kMono(audioCtx: AudioContext, audioBytes: Uint8Array): Promise<Float32Array> {
  const targetRate = 16000;
  const decoded = await withTimeout(
    audioCtx.decodeAudioData(bytesToArrayBuffer(audioBytes)),
    ASR_DECODE_TIMEOUT_MS,
    new Error("音频解码超时")
  );
  if (!decoded) {
    throw new Error("音频解码失败：无法解码音频数据");
  }
  const outLength = Math.max(1, Math.round(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, outLength, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const mono = (await withTimeout(offline.startRendering(), ASR_DECODE_TIMEOUT_MS, new Error("音频解码超时"))).getChannelData(0);
  if (!(mono.length > 0)) {
    throw new Error("音频解码失败：解码结果为空采样");
  }
  return mono;
}

// 全量解码入口（非 fMP4 兜底路径，整段字节一次解码）：自建 AudioContext 调
// resampleTo16kMono，返回 { data, diagnostic }。降级路径：B 站 DASH 音轨是
// fragmented MP4（moof/mdat 分片），Chrome 的 decodeAudioData 不支持（报
// "Unable to decode audio data"），fMP4 音轨已由句柄外流式路径（streamWavChunks）
// 接管；此处落到解码失败即整段不可解（非 fMP4 的异常容器），直接报错。
// startSec 仅用于对齐采样起点（本链路恒传 0，整段从头解码）。
// 诊断信息：解码时长与峰值幅度。峰值≈0 说明解码出来是静音——用于区分
// "视频真没人声"与"音轨获取/容器解码出了问题"（B 站 fMP4 有兼容性风险）。
// 校验（静音/零时长显式报错）由 chunker 的 validateDecodedAudio 统一负责。
async function decodeTo16kMono(audioBytes: Uint8Array, startSec = 0): Promise<{ data: Float32Array; diagnostic: { durationSec: number; peak: number } }> {
  const AudioCtor = (globalThis as typeof globalThis & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext || (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) {
    throw new Error("当前环境没有 AudioContext，无法解码");
  }
  const audioCtx = new AudioCtor();
  try {
    let mono: Float32Array | null = null;
    let decodeError: Error | null = null;
    try {
      mono = await resampleTo16kMono(audioCtx, audioBytes);
    } catch (error) {
      decodeError = error as Error;
    }
    if (!mono) {
      throw decodeError || new Error("音频解码失败：无法解码音频数据");
    }
    let peak = 0;
    for (let i = 0; i < mono.length; i += 1) {
      const abs = Math.abs(mono[i]);
      if (abs > peak) peak = abs;
    }
    // 渲染产物 16k 采样：duration = 采样数 / 16000（AudioBuffer 的定义式）
    const diagnostic = { durationSec: Math.round((mono.length / 16000) * 100) / 100, peak };
    console.info("[BOC][asr-decode] 解码完成", diagnostic);
    const startSample = Math.round(Number(startSec || 0) * 16000);
    if (startSample <= 0 || startSample >= mono.length) {
      return { data: mono, diagnostic };
    }
    return { data: mono.subarray(startSample), diagnostic };
  } finally {
    audioCtx.close();
  }
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) {
    return (bytes as unknown as ArrayBuffer).slice(0);
  }
  if (ArrayBuffer.isView(bytes)) {
    return (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  throw new Error("无法识别的音频数据格式");
}
