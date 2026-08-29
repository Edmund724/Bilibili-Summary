// extension/asr/fallback.js
// 无字幕轨时的 ASR 回退策略簇（自 subtitle/fetcher.js 原样迁出，工厂 + 依赖
// 注入 seam）：maybeRunAsrFallback 为回退入口，awaitActiveAsrTranscribe 供
// fetcher 的抓取失败兜底等待共享转写，finishAsrFallback 为工厂内私有收尾。
//
// 依赖分层：
//   - 直 import（传递 import 闭包不触及 subtitle/fetcher.js）：shared/
//     error-helpers、shared/logging、core/state、subtitle/cache、subtitle/selection；
//   - 注入 deps（传递闭包含 runtime.js→fetcher 或随 UI/上下文成环）：
//     getSettings、setStatus、setMessage、applyNoSubtitleState、
//     refreshDerivedContent、isReaderViewOpen、notifyReaderPresenter、
//     runAsrPipeline（pipeline 闭包经 offscreen-bridge →core/runtime→fetcher）、
//     broadcastSubtitleStatus（fetcher 内部函数）。
// 模块不 import extension/entry/ 与 extension/pages/ 的任何内容。

import { ensureRunActive, isStaleRunError, getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { state, clipState } from "../core/state.js";
import {
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  clearSubtitleCacheByKey,
  saveSubtitleToCache,
  clearStaleAsrSubtitleCache
} from "../subtitle/cache.js";
import { validateSubtitleByDuration } from "../subtitle/selection.js";

export function createAsrFallback(deps) {
  const {
    getSettings,
    setStatus,
    setMessage,
    applyNoSubtitleState,
    refreshDerivedContent,
    isReaderViewOpen,
    notifyReaderPresenter,
    runAsrPipeline,
    broadcastSubtitleStatus
  } = deps;

  // 进行中的 ASR 转写共享单元：同视频并发 refreshClip（侧边栏 focus/切 tab 的
  // sync 都会经 popup-refresh 触发新一轮抓取）在此命中后等待同一 promise，
  // 不再重启转写。历史上每次 refreshClip 都 fetchRunId+1，几小时的长视频转写
  // 会被下一次 sync 静默打断——成果既不写缓存也不进总结上下文，用户再点抓取
  // 只能从头重转。key 为 ASR 缓存键（bvid/cid/provider/model/language）。
  let activeAsrTranscribe = null;

  // 无字幕轨时的语音识别回退入口。流程：
  //   skip（未启用开关 / 无激活平台 / offscreen 侧配置级 asr-skip）→ 返回
  //   "skip"，调用方走原有无字幕提示（提示文案已追加引导句，见
  //   applyNoSubtitleState 调用处）；
  //   缓存命中 → 直接走成功收尾（不发 playurl、不下载、不转写）；
  //   成功 → 塞伪轨道 + setSubtitleBody + ready + 写缓存，返回 "done"；
  //   空结果 / 失败 → 落回 applyNoSubtitleState 并展示对应文案。
  // runId 全程守卫：切换视频后旧任务立即中止（pipeline 内每步检查）。
  async function maybeRunAsrFallback({ runId }) {
    try {
      ensureRunActive(runId);

      // 设置判定：开关未启用或没有激活平台 → skip（与现状行为一致，仅文案变化）。
      // 快速出口先于消息请求：回退关闭时不产生 background 往返。
      const settings = state.settings || (await getSettings());
      const enabled = settings.asrAutoFallback === true;
      const activeId = String(settings.activeAsrProviderId || "").trim();
      if (!enabled || !activeId) {
        return "skip";
      }

      // provider 元数据（name/model，无 Key——Key 单独存储、组装在 offscreen）
      // 从设置快照取，仅用于平台名展示与缓存键；激活平台不在列表中 → skip。
      // 转写所需的完整 provider+Key+语言由 offscreen 直调 background 的
      // get-asr-runtime-config 获取（配置级缺失/关闭时 offscreen 回 asr-skip，
      // 由下方 catch 静默跳过），apiKey 不再进页面 context。
      const activeProvider = (settings.asrProviders || []).find((p) => p.id === activeId);
      if (!activeProvider) {
        return "skip";
      }
      const language = String(settings.asrLanguage || "").trim() || "auto";
      const platformName = activeProvider.name || "语音识别平台";
      const model = String(activeProvider.model || "").trim();
      // 固定本轮视频身份：孤儿清理/缓存键都以发起转写时的 bvid+cid 为准。
      const bvid = state.clip.bvid;
      const cid = state.clip.cid;
      const cacheKey = getSubtitleCacheKey({
        bvid,
        cid,
        subtitleId: `asr:${activeId}:${model}:${language}`
      });

      // 缓存命中：直接收尾（校验通过才用，不通过则清掉重新生成）
      const cachedBody = await loadSubtitleFromCache(cacheKey);
      ensureRunActive(runId);
      if (cachedBody && Array.isArray(cachedBody) && cachedBody.length > 0) {
        const cachedCheck = validateSubtitleByDuration(cachedBody, state.clip.videoDuration);
        if (cachedCheck.ok) {
          clipState.setSelectedSubtitleId("asr");
          clipState.setSelectedSubtitleUrl("");
          clipState.setSelectedSubtitleLang(`语音识别（${platformName}）`);
          clipState.setSubtitleBody(cachedBody);
          clipState.setSubtitleFetchState("ready");
          await refreshDerivedContent();
          if (isReaderViewOpen()) {
            notifyReaderPresenter("subtitle-ready");
          }
          setStatus("语音识别完成（缓存命中）。");
          return "done";
        }
        logWarn("[BOC] cached asr subtitle duration mismatch, clearing cache", {
          cacheKey,
          reason: cachedCheck.reason
        });
        await clearSubtitleCacheByKey(cacheKey);
        ensureRunActive(runId);
      }

      setStatus(`无字幕轨，正在使用语音识别（${platformName}）生成字幕…`);
      broadcastSubtitleStatus("asr-transcribing");

      // 同视频并发抓取（侧边栏 sync 触发的 popup-refresh 等）命中进行中的转写：
      // 等待共享 promise 而不是重启——重启会让几小时成果作废且永不落缓存。
      if (activeAsrTranscribe && activeAsrTranscribe.cacheKey === cacheKey) {
        const sharedBody = await activeAsrTranscribe.promise;
        if (!Array.isArray(sharedBody) || sharedBody.length === 0) {
          setStatus("未识别到语音内容，该视频可能没有人声。");
          return "empty";
        }
        return finishAsrFallback({ runId, body: sharedBody, platformName });
      }

      // 过期判据用"视频键是否已切换"而非 runId：runId 会把同视频的下一次
      // refreshClip 误判为过期（正是长视频转写被打断的根源）；换视频时
      // bvid/cid 变化才真正需要中止转写（省 API 费用）。
      const videoKey = `${state.clip.bvid}|${state.clip.cid}`;
      const isStale = () => `${state.clip.bvid}|${state.clip.cid}` !== videoKey;
      let emptyDiag = "";
      const transcribePromise = runAsrPipeline({
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        runId,
        isStale,
        onProgress: (msg) => setStatus(msg),
        onEmptyDiagnostic: (diagText) => {
          emptyDiag = diagText;
        }
      })
        .then(async (body) => {
          // 成果即刻落缓存：按 bvid/cid/provider 键控，与后续 UI 状态无关。
          // 历史上写缓存在 ensureRunActive 之后，转写一旦被并发抓取顶掉，
          // 几小时成果直接丢弃。写入带 LRU 淘汰（失败先清理旧视频再重试一次）。
          if (Array.isArray(body) && body.length > 0) {
            const saveResult = await saveSubtitleToCache(cacheKey, body);
            if (saveResult && saveResult.ok === false) {
              // 淘汰后重试仍失败：经既有消息栏一次性上浮，不阻断主流程。
              setMessage("语音识别结果已生成，但本地缓存写入失败（已自动清理旧缓存仍失败），仅本次会话有效。");
            } else {
              // 孤儿清理：新 ASR 转写落盘后，移除同视频其它 provider/model/language
              // 的过期 ASR 变体键；平台字幕轨不是孤儿，保留。清理只在写入成功后
              // 执行——写失败时旧变体仍是唯一可用副本，不能删。
              await clearStaleAsrSubtitleCache({ bvid, cid, keepKey: cacheKey });
            }
          }
          return body;
        })
        .finally(() => {
          if (activeAsrTranscribe && activeAsrTranscribe.cacheKey === cacheKey) {
            activeAsrTranscribe = null;
          }
        });
      activeAsrTranscribe = { cacheKey, promise: transcribePromise, platformName };

      const body = await transcribePromise;

      // 空结果：全部为空白 → 返回 "empty"，调用点呈现"未识别到语音内容"文案；
      // 有诊断信息时直接拼进状态栏，用户转述即可定位问题层
      if (!Array.isArray(body) || body.length === 0) {
        setStatus(
          `未识别到语音内容，该视频可能没有人声。${emptyDiag ? `（诊断：${emptyDiag}）` : ""}`
        );
        broadcastSubtitleStatus("asr-done");
        return "empty";
      }

      return finishAsrFallback({ runId, body, platformName });
    } catch (error) {
      // 失败兜底：错误文案进状态，不崩；落回原有无字幕状态。
      // stale（换视频被顶掉）不广播：新视频的抓取流程会发出自己的阶段标记。
      if (isStaleRunError(error)) {
        throw error;
      }
      // offscreen 配置级缺失/关闭/无激活平台 → asr-skip：静默跳过本轮回退，
      // 返回 "skip" 走原有无字幕提示（与设置闸门 skip 同语义，零用户可见
      // 错误）。此时"正在使用语音识别"提示与 asr-transcribing 广播已发出，
      // 补一个 asr-done 终态广播解除 sidepanel 一键总结的等待标志。
      if (error?.code === "asr-skip") {
        broadcastSubtitleStatus("asr-done");
        return "skip";
      }
      setStatus(`语音识别失败：${getErrorMessage(error)}`);
      broadcastSubtitleStatus("asr-failed");
      applyNoSubtitleState();
      return "error";
    }
  }

  // 等待进行中的共享转写并按其结果收尾（refreshClip 辅助抓取失败时的兜底路径：
  // 不清上下文，跟着共享转写一起完成）。转写失败由发起者的 catch 负责文案，
  // 这里静默退出；runId 守卫只影响 UI 收尾，成果已在共享单元内落缓存。
  async function awaitActiveAsrTranscribe(runId) {
    const active = activeAsrTranscribe;
    if (!active) {
      return;
    }
    try {
      const sharedBody = await active.promise;
      if (!Array.isArray(sharedBody) || sharedBody.length === 0) {
        setStatus("未识别到语音内容，该视频可能没有人声。");
        broadcastSubtitleStatus("asr-done");
        return;
      }
      await finishAsrFallback({ runId, body: sharedBody, platformName: active.platformName });
    } catch {
      // 共享转写失败/中止：发起者路径已负责状态与文案
    }
  }

  // ASR 转写成功后的收尾：塞伪轨道 → body → ready → 派生内容 → 完成提示。
  // 缓存写入已在转写共享单元内完成。runId 只守卫 UI 状态收尾（被更新的
  // 抓取顶掉时静默让位，转写成果本身已落缓存）。
  function finishAsrFallback({ runId, body, platformName }) {
    ensureRunActive(runId);
    clipState.setSubtitles([
      { id: "asr", lan: "asr-zh", lanDoc: `语音识别（${platformName}）`, subtitleUrl: "" },
      ...(state.clip.subtitles || [])
    ]);
    clipState.setSelectedSubtitleId("asr");
    clipState.setSelectedSubtitleUrl("");
    clipState.setSelectedSubtitleLang(`语音识别（${platformName}）`);
    clipState.setSubtitleBody(body);
    clipState.setSubtitleFetchState("ready");
    return refreshDerivedContent().then(() => {
      if (isReaderViewOpen()) {
        notifyReaderPresenter("subtitle-ready");
      }
      setStatus(`语音识别完成，已生成 ${body.length} 条字幕。`);
      broadcastSubtitleStatus("asr-done");
      return "done";
    });
  }

  // 进行中转写探针：fetcher 的 refreshClip 失败兜底据此决定"继续等待音频转写"
  // 还是走清上下文的错误路径（原模块级 activeAsrTranscribe 读访问的 seam 形态）。
  function hasActiveAsrTranscribe() {
    return activeAsrTranscribe !== null;
  }

  return { maybeRunAsrFallback, awaitActiveAsrTranscribe, hasActiveAsrTranscribe };
}
