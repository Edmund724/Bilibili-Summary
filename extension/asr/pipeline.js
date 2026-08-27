// extension/asr/pipeline.js
// ASR 管线编排：取音轨 → 下载 → 解码切片 → 按平台 type 分发适配器逐片
// 转写（openai-transcriptions 最多 2 片并发，其余串行）→ 时间戳加片偏移
// 合并为 B 站字幕格式 [{from,to,content}]。
//
// 每步都做 ensureRunActive(runId) 守卫：转写中切换视频，旧任务立即中止，
// 不污染新视频状态。网络错误/5xx 复用 fetcher.js 的 retryAsync 指数退避
// 重试（本管线按 2 次重试调用）。

import { getSourceAudioUrl } from "./audio-source.js";
import { downloadAudioViaBackground } from "./downloader.js";
import { buildChunkPlan, processAudio } from "./chunker.js";
import { transcribe as transcribeOpenAi } from "./adapters/openai-transcriptions.js";
import { transcribe as transcribeDashscopeFiletrans } from "./adapters/dashscope-filetrans.js";
import { transcribe as transcribeStepfunSse } from "./adapters/stepfun-sse.js";
import { ensureRunActive } from "../shared/error-helpers.js";
import { retryAsync } from "../subtitle/fetcher.js";
import { createOffscreenDecodeHost } from "./offscreen-bridge.js";

// type → 适配器映射。映射表缺 type 时 throw 明确错误，避免静默走错分支。
// 并发策略：映射表项的 concurrency 元数据驱动（见 runAsrPipeline）；
// openai-transcriptions 最多 2 片并发，其余类型单任务串行。
const ADAPTERS = {
  "openai-transcriptions": { adapter: transcribeOpenAi, concurrency: 2 },
  "dashscope-filetrans": { adapter: transcribeDashscopeFiletrans, concurrency: 1 },
  "stepfun-sse": { adapter: transcribeStepfunSse, concurrency: 1 }
};

// 并发窗口：最多 limit 个任务同时执行，按完成顺序收集结果（无顺序依赖，
// 合成阶段按片 index 排序即可）。返回与 tasks 等长的结果数组。
// 个别任务失败（非 STALE_RUN）收集为 Error 结果；STALE_RUN 中止并上抛。
async function runWithConcurrency(tasks, limit = 2) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) {
        return;
      }
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        // runId 作废：中止整个管线并上抛（不能收集成失败片，否则会
        // 被合并逻辑误判为"无人声"）。
        if (error?.code === "STALE_RUN") {
          throw error;
        }
        results[index] = error;
      }
    }
  };
  const workers = [];
  const count = Math.min(limit, tasks.length);
  for (let i = 0; i < count; i += 1) {
    workers.push(worker());
  }
  try {
    await Promise.all(workers);
  } catch (error) {
    // worker 内 STALE_RUN 直接抛出，其余错误收集为结果
    throw error;
  }
  return results;
}

// 逐片转写（含重试），onProgress 透传给上层展示逐片进度。
async function transcribeChunk({ chunk, provider, runId, onProgress }) {
  const adapter = ADAPTERS[provider.type]?.adapter;
  const task = () =>
    adapter({
      wavBlob: chunk.wavBlob,
      startSec: chunk.startSec,
      durationSec: chunk.durationSec,
      provider,
      signal: undefined,
      onProgress: () => onProgress?.(`语音识别中 ${chunk.index + 1} 片…`)
    });
  const result = await retryAsync(task, 2, 500);
  ensureRunActive(runId);
  return { ...result, durationSec: chunk.durationSec };
}

// 把单片的转写结果合成 {from,to,content}[]：
//   有 segments → 每条 = startSec + seg.start/end；
//   无 → 整片一条粗粒度字幕 {from:startSec, to:startSec+durationSec}。
// to 不超过片末边界（chunk.durationSec 由 pipeline 推算，此处兜底取
// 入参 durationSec）；content trim。
export function synthesizeChunk({ startSec, durationSec, result }) {
  const out = [];
  const chunkDur = Number(result?.durationSec || 0) || Number(durationSec) || 0;
  if (result?.segments && result.segments.length > 0) {
    for (const seg of result.segments) {
      const content = String(seg.text || "").trim();
      if (!content) {
        continue;
      }
      const from = Number(startSec) + Number(seg.start);
      const segEnd = Number(seg.end);
      const to = chunkDur > 0
        ? Math.min(Number(startSec) + segEnd, Number(startSec) + chunkDur)
        : Number(startSec) + segEnd;
      out.push({ from, to, content });
    }
  } else {
    const text = String(result?.text || "").trim();
    if (text) {
      out.push({
        from: Number(startSec),
        to: chunkDur > 0 ? Number(startSec) + chunkDur : Number(startSec) + Number(durationSec),
        content: text
      });
    }
  }
  return out;
}

// 全部片段合成 → 按 from 排序 → content 拼接 trim 为空返回 []（上层提示
// "未识别到语音内容"）。
export function mergeChunkResults(chunks, results) {
  const merged = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const result = results[i];
    if (!result || result instanceof Error) {
      continue;
    }
    merged.push(...synthesizeChunk({ startSec: chunk.startSec, durationSec: chunk.durationSec, result }));
  }
  merged.sort((a, b) => a.from - b.from);
  return merged;
}

// ===== 主入口 =====

// runAsrPipeline({ bvid, cid, durationSec, provider, runId, onProgress, decodeHost })
// → [{from,to,content}]（空数组表示未识别到语音内容）。
// decodeHost 为可选注入的解码宿主（测试传合成宿主，生产默认走
// createOffscreenDecodeHost：一次全量解码 + 分块回传）。
export async function runAsrPipeline({ bvid, cid, durationSec, provider, runId, onProgress, decodeHost }) {
  const type = String(provider?.type || "").trim();
  const entry = ADAPTERS[type];
  if (!entry) {
    throw new Error("暂不支持的平台类型：" + (type || "未知"));
  }
  const host = decodeHost || createOffscreenDecodeHost();

  // 切片计划：openai-transcriptions 带时间戳 10 分钟一片、无时间戳按
  // settings.asrChunkMinutes（默认 3 分钟）；其余类型由 chunker 决策
  // （dashscope-filetrans 不切整段；stepfun-sse 25 分钟一片）。
  let plan;
  if (type === "openai-transcriptions") {
    const chunkMinutes = Number(provider?.chunkMinutes || 0) || 3;
    plan = buildChunkPlan(type, provider?.supportsTimestamps === true, chunkMinutes);
  } else {
    plan = buildChunkPlan(type, provider?.supportsTimestamps === true, 3);
  }

  // 取音轨
  ensureRunActive(runId);
  onProgress?.("无字幕轨，正在获取音频流…");
  const source = await getSourceAudioUrl({ bvid, cid });
  ensureRunActive(runId);

  // 下载音频（background 侧绕防盗链）
  onProgress?.("音频下载中…");
  const arrayBuffer = await downloadAudioViaBackground({
    url: source.url,
    backupUrls: source.backupUrls || []
  });
  ensureRunActive(runId);

  // 解码 + 切片 + WAV 编码（宿主在 offscreen 文档跑）
  onProgress?.("音频解码中…");
  const rawChunks = await processAudio(arrayBuffer, { decodeHost: host, plan });
  ensureRunActive(runId);
  if (rawChunks.length === 0) {
    return [];
  }

  // processAudio 返回的 chunk 只有 {index,startSec,wavBlob}，无时长字段；
  // 这里按片间 startSec 间隙 + 入参总时长推算每片时长（片边界与 chunker
  // 的 decideChunks 连续切片一致）。
  const totalDuration = Number(durationSec) > 0 ? Number(durationSec) : rawChunks[rawChunks.length - 1].startSec + 1;
  const chunks = rawChunks.map((chunk, i) => {
    const endSec = i + 1 < rawChunks.length ? rawChunks[i + 1].startSec : totalDuration;
    return { ...chunk, durationSec: endSec - chunk.startSec };
  });

  // 逐片转写：并发窗口取映射表 concurrency 元数据（openai-transcriptions 2，
  // 其余单任务串行）；结果按片 index 有序，合成阶段排序。
  const total = chunks.length;
  const concurrency = Number(entry.concurrency) || 1;
  const progress = (msg) => onProgress?.(`${msg}（共 ${total} 片）`);
  if (concurrency > 1) {
    const results = await runWithConcurrency(
      chunks.map((chunk) => () => transcribeChunk({ chunk, provider, runId, onProgress: progress })),
      concurrency
    );
    ensureRunActive(runId);
    return mergeChunkResults(chunks, results);
  }

  // 串行分支：dashscope-filetrans（整段一片）与 stepfun-sse 后续票。
  const serialResults = [];
  for (const chunk of chunks) {
    serialResults.push(await transcribeChunk({ chunk, provider, runId, onProgress: progress }));
    ensureRunActive(runId);
  }
  return mergeChunkResults(chunks, serialResults);
}

export { ensureRunActive, retryAsync, runWithConcurrency };
