// extension/asr/pipeline.js
// ASR 管线编排（页面侧，只做编排不碰音频字节）：取音轨 → offscreen 下载/
// 解码/切片/逐片转写（转写引擎与解码同 context，跨 port 只传文本结果）→
// 时间戳加片偏移合并为 B 站字幕格式 [{from,to,content}]。
//
// 页面不再感知 provider/Key：平台选择、Key 组装、语言档位全部在 offscreen
// 侧完成（entry/offscreen.js 直调 background 的 get-asr-runtime-config），
// 调度引擎（asr/engine.js，活队列 + 逐片重试 + 失败计数）也在 offscreen。
// 页面职责只剩：回退决策由上游 fallback 承担；本模块负责取音轨地址、
// 发任务、收文本结果、合并、空结果诊断。
//
// 本模块不做任何过期守卫：转写与视频切换解耦（切走视频任务照跑、成果照落
// 缓存），中止只剩真断连（页面关闭/扩展重载 → port disconnect）。

import { getSourceAudioUrl } from "./audio-source.js";
import { createOffscreenChunkHost } from "./offscreen-bridge.js";

// 把单片的转写结果合成 {from,to,content}[]：
//   有 segments → 每条 = startSec + seg.start/end；
//   无 → 整片一条粗粒度字幕 {from:startSec, to:startSec+durationSec}。
// to 不超过片末边界（chunk.durationSec 由 offscreen 按实际解码时长交付，
// 此处兜底取入参 durationSec）；content trim。
function synthesizeChunk({ startSec, durationSec, result }) {
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
// "未识别到语音内容"）。chunkResults 为按片 index 对齐的单片记录
// [{ index, startSec, durationSec, result }]（offscreen 桥 done 后已排序）；
// 转写失败片 / 解码失败段不在其中（offscreen 引擎跳过并计数），不参与合并。
function mergeChunkResults(chunkResults) {
  const merged = [];
  for (const record of chunkResults) {
    if (!record?.result) {
      continue;
    }
    merged.push(...synthesizeChunk({ startSec: record.startSec, durationSec: record.durationSec, result: record.result }));
  }
  merged.sort((a, b) => a.from - b.from);
  return merged;
}

// ===== 主入口 =====

// runAsrPipeline({ bvid, cid, onProgress, chunkHost, onEmptyDiagnostic })
// → [{from,to,content}]（空数组表示未识别到语音内容）。
// 不做任何过期守卫（runId/视频键复核均已移除）：调用方（asr/fallback）自行
// 决定 UI 应用时机，转写本身与视频切换解耦，跑完即返回。chunkHost 为可选
// 注入的任务宿主（测试传合成宿主，生产默认走 createOffscreenChunkHost：
// offscreen 文档内下载+解码+切片+逐片转写，每片完成即回传文本结果）。
export async function runAsrPipeline({ bvid, cid, onProgress, chunkHost, onEmptyDiagnostic }) {
  const host = chunkHost || createOffscreenChunkHost();

  // 取音轨（页面同域能力：playurl 依赖 B 站页面 cookie，走 contentFetchJson）
  onProgress?.("无字幕轨，正在获取音频流…");
  const source = await getSourceAudioUrl({ bvid, cid });

  // offscreen 文档内完成下载 → 解码 → 切片 → 逐片转写（engine 并发调度），
  // 每片完成即把文本结果经 port 发回；音频字节与 API Key 都不出 offscreen。
  // 防盗链规则由 prepare 阶段在 background 加上。
  onProgress?.("音频下载与解码中…");
  const { results, totalChunks, skippedSegments, failedChunks } = await host({
    audioUrl: source.url,
    backupUrls: source.backupUrls || [],
    onProgress
  });

  const merged = mergeChunkResults(results);
  if (merged.length === 0 && typeof onEmptyDiagnostic === "function") {
    // 空结果诊断：静音场景已在解码层显式报错，剩下的事件级证据随适配器
    // 诊断字段上来，失败计数（转写失败片 / 解码失败跳过段）一并拼进文案。
    const diagnostics = results
      .map((r) => r?.result?._asrDiag)
      .filter(Boolean)
      .slice(0, 1);
    const plannedChunks = Number(totalChunks) > 0 ? Number(totalChunks) : results.length;
    let diagText =
      `分片 ${plannedChunks} 片、各片文本长度[${results.map((r) => String(r?.result?.text || "").length).join(",")}]`;
    if (diagnostics[0]) {
      diagText += `；事件诊断 ${JSON.stringify(diagnostics[0])}`;
    }
    const failureParts = [];
    if (Number(failedChunks) > 0) {
      failureParts.push(`${Number(failedChunks)} 片转写失败`);
    }
    if (Number(skippedSegments) > 0) {
      failureParts.push(`${Number(skippedSegments)} 段解码失败已跳过`);
    }
    if (failureParts.length > 0) {
      diagText += `；${failureParts.join("、")}`;
    }
    try {
      onEmptyDiagnostic(diagText.slice(0, 400));
    } catch {
      // 诊断回调异常不影响主流程
    }
  }
  return merged;
}
