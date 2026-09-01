// extension/asr/fallback.ts
// 无字幕轨时的 ASR 回退策略簇（自 subtitle/fetcher.js 原样迁出，工厂 + 依赖
// 注入 seam）：maybeRunAsrFallback 为回退入口，awaitActiveAsrTranscribe 供
// fetcher 的抓取失败兜底等待共享转写，finishAsrFallback 为工厂内私有收尾。
//
// 依赖分层：
//   - 直 import（传递 import 闭包不触及 subtitle/fetcher.js）：shared/
//     error-helpers、shared/logging、core/state、subtitle/cache、subtitle/selection；
//   - 注入 deps（传递闭包含 runtime.js→fetcher 或随 UI/上下文成环）：
//     getSettings、loadProviders（provider 列表，asrProviders 已摘出 settings，
//     fetcher 经 asr-providers-list 消息直读 provider-store）、setStatus、
//     setMessage、acceptSubtitle / commitNoSubtitle（字幕接受事务的唯一入口，
//     subtitle/commit.js，沿用依赖注入 seam——本模块对 subtitle 的直 import
//     只保留 cache/selection 纯叶子，事务层闭包含 core→gateway/messaging，
//     仍不走静态边）、runAsrPipeline（pipeline 闭包经
//     offscreen-bridge.page →shared/messaging→fetcher）、
//     broadcastSubtitleStatus（fetcher 内部函数）。
// 模块不 import extension/entry/ 与 extension/pages/ 的任何内容。

import { ensureRunActive, isStaleRunError, getErrorMessage } from "../shared/error-helpers.js";
import { logInfo, logWarn } from "../shared/logging.js";
import { state, clipState } from "../core/state.js";
import {
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  clearSubtitleCacheByKey,
  saveSubtitleToCache,
  clearStaleAsrSubtitleCache
} from "../subtitle/cache.js";
import { validateSubtitleByDuration } from "../subtitle/selection.js";

const _clearStaleAsrSubtitleCache = clearStaleAsrSubtitleCache as unknown as (opts: {
  bvid: string;
  cid: string;
  keepKey: string;
}) => Promise<void>;

// STALE_RUN 信号构造：在本模块里只表示"调用方让位、零 UI 写入"（fetcher 的
// catch 对 STALE_RUN 静默返回），不再表示转写被中止——切视频不取消任务。
function throwStaleRun(): never {
  const error = new Error("Stale refresh run") as Error & { code: string };
  error.code = "STALE_RUN";
  throw error;
}

// offscreen asr-skip 错误的结构化原因 → clipState.noSubtitleReason 取值。
// 仅认识 offscreen 显式标注的两类配置级原因；消息失败/超时的 asr-skip 不带
// reason（未知）→ 归 null，sidepanel 展示通用无字幕文案。
const KNOWN_ASR_SKIP_REASONS = new Set(["asr-disabled", "no-asr-config"]);

function noSubtitleReasonFromAsrSkipError(error: unknown): string | null {
  const reason = (error as { reason?: string }).reason;
  return typeof reason === "string" && KNOWN_ASR_SKIP_REASONS.has(reason) ? reason : null;
}

export interface AsrSettings {
  asrAutoFallback?: boolean;
  activeAsrProviderId?: string;
  asrLanguage?: string;
}

export interface AsrProviderMeta {
  id: string;
  name?: string;
  model?: string;
  type?: string;
}

export interface SubtitleItem {
  from: number;
  to: number;
  content: string;
}

export interface AcceptSubtitleArgs {
  body: SubtitleItem[];
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  selectedSubtitleLang: string;
}

export interface CommitNoSubtitleArgs {
  noSubtitleReason: string;
  asrResult: string;
}

export interface AsrPipelineArgs {
  bvid: string;
  cid: string;
  onProgress?: (message: string) => void;
  onEmptyDiagnostic?: (diagText: string) => void;
}

export interface CreateAsrFallbackDeps {
  getSettings: () => Promise<AsrSettings>;
  loadProviders: () => Promise<AsrProviderMeta[]>;
  setStatus: (message: string) => void;
  setMessage: (message: string) => void;
  acceptSubtitle: (args: AcceptSubtitleArgs) => Promise<unknown>;
  commitNoSubtitle: (args: CommitNoSubtitleArgs) => Promise<unknown>;
  runAsrPipeline: (args: AsrPipelineArgs) => Promise<SubtitleItem[]>;
  broadcastSubtitleStatus: (status: string) => void;
}

// 进行中的 ASR 转写共享单元（activeAsrTranscribes Map 的值类型）。字段语义与
// 工厂内 Map 注释的不变量一一对应：
//   - promise：共享转写 promise——同视频并发抓取命中后等待同一成果，不重启
//     转写；缓存写入由发起者的 promise 链负责，任务终态按自身 cacheKey 除名；
//   - platformName：发起时激活平台名（共享命中方的收尾文案复用同一名字）；
//   - videoKey：发起转写时的 "bvid|cid" 视频身份快照——与转写解耦的关键：
//     切视频不取消任务，fetcher 失败兜底按"当前视频"探针/等待
//    （hasActiveAsrTranscribe / awaitActiveAsrTranscribe 只匹配 videoKey）。
export interface ActiveAsrTranscribe {
  promise: Promise<SubtitleItem[]>;
  platformName: string;
  videoKey: string;
}

export interface AsrFallback {
  maybeRunAsrFallback: (args: { runId: number }) => Promise<"skip" | "done" | "empty" | "error">;
  awaitActiveAsrTranscribe: (args: { runId: number; bvid: string; cid: string }) => Promise<void>;
  hasActiveAsrTranscribe: (args: { bvid: string; cid: string }) => boolean;
}

export function createAsrFallback(deps: CreateAsrFallbackDeps): AsrFallback {
  const {
    getSettings,
    loadProviders,
    setStatus,
    setMessage,
    acceptSubtitle,
    commitNoSubtitle,
    runAsrPipeline,
    broadcastSubtitleStatus
  } = deps;

  // 进行中的 ASR 转写共享单元（Map<cacheKey, { promise, platformName, videoKey }>）：
  // 同视频并发 refreshClip（侧边栏 focus/切 tab 的 sync 都会经 popup-refresh
  // 触发新一轮抓取）与"切走再切回"在此命中后等待同一 promise，不再重启转写。
  // 历史上每次 refreshClip 都 fetchRunId+1，几小时的长视频转写会被下一次 sync
  // 静默打断——成果既不写缓存也不进总结上下文，用户再点抓取只能从头重转。
  // key 为 ASR 缓存键（bvid/cid/provider/model/language），videoKey 为
  // bvid|cid 快照（供 fetcher 失败兜底按"当前视频"探针/等待）。
  // 转写与视频切换解耦：切走视频不取消任务，任务在后台跑完、成果照落缓存，
  // Map 记录只随任务终态按 cacheKey 清除。
  const activeAsrTranscribes = new Map<string, ActiveAsrTranscribe>();

  // 无字幕轨时的语音识别回退入口。流程：
  //   skip（未启用开关 / 无激活平台 / offscreen 侧配置级 asr-skip）→ 返回
  //   "skip"，调用方（fetcher 的 finishNoSubtitle）走无字幕出口逆事务
  //  （commit.commitNoSubtitle，skip 分支的状态栏文案已追加引导句）；
  //   缓存命中 → 直接走字幕接受事务收尾（不发 playurl、不下载、不转写）；
  //   成功 → 塞伪轨道 + 字幕接受事务 + 写缓存，返回 "done"；
  //   空结果 / 失败 → 落回无字幕出口逆事务并展示对应文案。
  // 过期语义与转写解耦：runId 守卫只拦截"发起前调用方已被顶掉"（早期快出，
  // 零副作用）；转写一旦发起就不再因切视频/runId 前进而中止——isStale（bvid/cid
  // 快照 vs 实时 clip）只门控 UI 应用点，成果一律落缓存并广播终态。
  async function maybeRunAsrFallback({ runId }: { runId: number }): Promise<"skip" | "done" | "empty" | "error"> {
    // 视频键快照在 try 内赋值（发起转写时的 bvid/cid）；catch 的 stale 收尾
    // 复用同一判据。赋值前发生的错误（入口守卫阶段）不涉及转写，恒走 fresh
    // 分类，UI 收尾与现状一致。
    let bvid = "";
    let cid = "";
    // 运行守卫类型契约：isStale 恒为 () => boolean，语义是"视频键是否已切换"
    // （bvid/cid 快照 vs 实时 clip），不是 runId 前进——runId 守卫只拦截发起前
    // 的调用方更替（ensureRunActive），见下方赋值点与函数注释。
    let isStale: () => boolean = () => false;
    try {
      ensureRunActive(runId);

      // 设置判定：开关未启用或没有激活平台 → skip（与现状行为一致，仅文案变化）。
      // 快速出口先于消息请求：回退关闭时不产生 background 往返。
      // noSubtitleReason 随 skip 原因落 state，供 sidepanel 拦截总结时按原因提示。
      const settings = state.settings || (await getSettings());
      const enabled = settings.asrAutoFallback === true;
      const activeId = String(settings.activeAsrProviderId || "").trim();
      if (!enabled) {
        clipState.setNoSubtitleReason("asr-disabled");
        return "skip";
      }
      if (!activeId) {
        clipState.setNoSubtitleReason("no-asr-config");
        return "skip";
      }

      // provider 元数据（name/model，无 Key——Key 单独存储、组装在 offscreen）
      // 从 provider-store 列表取（注入的 loadProviders），仅用于平台名展示与
      // 缓存键；激活平台不在列表中 → skip。转写所需的完整 provider+Key+语言由
      // offscreen 直调 background 的 get-asr-runtime-config 获取（配置级缺失/
      // 关闭时 offscreen 回 asr-skip，由下方 catch 静默跳过），apiKey 不再进
      // 页面 context。
      const providers = await loadProviders();
      const activeProvider = (Array.isArray(providers) ? providers : []).find((p) => p.id === activeId);
      if (!activeProvider) {
        clipState.setNoSubtitleReason("no-asr-config");
        return "skip";
      }
      const language = String(settings.asrLanguage || "").trim() || "auto";
      const platformName = activeProvider.name || "语音识别平台";
      const model = String(activeProvider.model || "").trim();
      // 固定本轮视频身份：孤儿清理/缓存键/过期判据都以发起转写时的 bvid+cid
      // 快照为准；videoKey 同时作为共享单元的"当前视频"探针键。
      bvid = state.clip.bvid;
      cid = state.clip.cid;
      const videoKey = `${bvid}|${cid}`;
      // 过期判据用"视频键是否已切换"而非 runId：runId 会把同视频的下一次
      // refreshClip 误判为过期；换视频时 bvid/cid 变化才需要让 UI 收尾让位
      // （转写本身照跑，成果照落缓存）。
      isStale = () => `${state.clip.bvid}|${state.clip.cid}` !== videoKey;
      const cacheKey = getSubtitleCacheKey({
        bvid,
        cid,
        subtitleId: `asr:${activeId}:${model}:${language}`
      });

      // 缓存命中：直接收尾（校验通过才用，不通过则清掉重新生成）
      const cachedBody = await loadSubtitleFromCache(cacheKey);
      ensureRunActive(runId);
      if (cachedBody && Array.isArray(cachedBody) && cachedBody.length > 0) {
        const cachedCheck = validateSubtitleByDuration(cachedBody as SubtitleItem[], state.clip.videoDuration);
        if (cachedCheck.ok) {
          // 字幕接受事务（subtitle/commit.js）：ASR 缓存命中同样经事务收尾——
          // 旧缓存条目可能无序，幂等稳定排序由事务单点完成（「subtitleBody 按
          // from 升序」不变量）；写 selected 三项 → ready → 清原因 → 刷新派生 →
          // 通知 reader 全在事务内。
          await acceptSubtitle({
            body: cachedBody as SubtitleItem[],
            selectedSubtitleId: "asr",
            selectedSubtitleUrl: "",
            selectedSubtitleLang: `语音识别（${platformName}）`
          });
          setStatus("语音识别完成（缓存命中）。");
          return "done";
        }
        logWarn("[BOC] cached asr subtitle duration mismatch, clearing cache", {
          cacheKey,
          reason: (cachedCheck as { reason?: string }).reason
        });
        await clearSubtitleCacheByKey(cacheKey);
        ensureRunActive(runId);
      }

      setStatus(`无字幕轨，正在使用语音识别（${platformName}）生成字幕…`);
      broadcastSubtitleStatus("asr-transcribing");

      // 同视频并发抓取（侧边栏 sync 触发的 popup-refresh 等）与"切走再切回"
      // 命中进行中的转写：等待共享 promise 而不是重启——重启会让几小时成果
      // 作废且永不落缓存。命中即共享，缓存写入由发起者的 promise 链负责。
      const active = activeAsrTranscribes.get(cacheKey);
      if (active) {
        const sharedBody = await active.promise;
        if (!Array.isArray(sharedBody) || sharedBody.length === 0) {
          if (isStale()) {
            // 切走后共享转写以空结果到站：终态广播由发起者负责，这里静默让位
            throwStaleRun();
          }
          clipState.setNoSubtitleReason("asr-empty");
          setStatus("未识别到语音内容，该视频可能没有人声。");
          return "empty";
        }
        return finishAsrFallback({ runId, body: sharedBody, platformName });
      }

      let emptyDiag = "";
      const transcribePromise = runAsrPipeline({
        bvid,
        cid,
        onProgress: (msg) => {
          // 进度文案只服务当前视频的状态栏：切走后不再污染新视频 UI
          if (!isStale()) {
            setStatus(msg);
          }
        },
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
              await _clearStaleAsrSubtitleCache({ bvid, cid, keepKey: cacheKey });
            }
          }
          return body;
        })
        .finally(() => {
          // 任务终态即除名：按自身 cacheKey 删除，不影响其它视频的并发转写
          activeAsrTranscribes.delete(cacheKey);
        });
      activeAsrTranscribes.set(cacheKey, { promise: transcribePromise, platformName, videoKey });

      const body = await transcribePromise;

      // 空结果：全部为空白 → 返回 "empty"，调用点呈现"未识别到语音内容"文案；
      // 有诊断信息时直接拼进状态栏，用户转述即可定位问题层。
      // 切走后到站的空结果：不写任何 UI（新视频的状态栏不能被旧视频的文案
      // 占用），但 asr-done 终态广播照发，让 sidepanel 的全局等待标志归位。
      if (!Array.isArray(body) || body.length === 0) {
        if (isStale()) {
          logInfo("[BOC] asr transcribe finished empty after video switch; terminal broadcast only", {
            bvid,
            cid,
            ...(emptyDiag ? { diagnostic: emptyDiag } : {})
          });
          broadcastSubtitleStatus("asr-done");
          throwStaleRun();
        }
        clipState.setNoSubtitleReason("asr-empty");
        setStatus(
          `未识别到语音内容，该视频可能没有人声。${emptyDiag ? `（诊断：${emptyDiag}）` : ""}`
        );
        broadcastSubtitleStatus("asr-done");
        return "empty";
      }

      // 切走后到站的成果：缓存已在上面的 promise 链落盘（键绑定发起时的
      // bvid/cid，与当前 UI 无关），广播 asr-done 让全局标志归位并留痕；
      // 不执行 finishAsrFallback（不写 clipState/DOM/reader，避免串台）。
      // 用户切回原视频时经缓存命中或共享单元自动接上。
      if (isStale()) {
        logInfo("[BOC] asr transcribe finished after video switch; result cached, UI deferred", {
          bvid,
          cid,
          itemCount: body.length
        });
        broadcastSubtitleStatus("asr-done");
        return "done";
      }

      return finishAsrFallback({ runId, body, platformName });
    } catch (error) {
      // 发起前/收尾守卫的 STALE_RUN（调用方被更新的抓取顶掉）：原样上抛，
      // fetcher catch 对 STALE_RUN 静默返回，零 UI 写入。
      if (isStaleRunError(error)) {
        throw error;
      }
      // 切走视频后任务失败到站：转写不因切换中止，失败终态也要让 sidepanel
      // 的全局等待标志归位（asr-skip 属良性跳过 → asr-done，其余 → asr-failed），
      // logWarn 留痕；UI 零写入（状态栏/无字幕收尾属于当前视频），转成
      // STALE_RUN 让 fetcher catch 静默吞掉。
      if (isStale()) {
        const phase = (error as { code?: string }).code === "asr-skip" ? "asr-done" : "asr-failed";
        logWarn("[BOC] asr transcribe failed after video switch; terminal broadcast only", {
          bvid,
          cid,
          phase,
          message: getErrorMessage(error)
        });
        broadcastSubtitleStatus(phase);
        throwStaleRun();
      }
      // offscreen 配置级缺失/关闭/无激活平台 → asr-skip：静默跳过本轮回退，
      // 返回 "skip" 走原有无字幕提示（与设置闸门 skip 同语义，零用户可见
      // 错误）。此时"正在使用语音识别"提示与 asr-transcribing 广播已发出，
      // 补一个 asr-done 终态广播解除 sidepanel 一键总结的等待标志。
      // 结构化原因（error.reason）随 skip 落 state：开关关 → asr-disabled，
      // 无激活平台 → no-asr-config，未知（config 消息失败/超时）→ null。
      if ((error as { code?: string }).code === "asr-skip") {
        broadcastSubtitleStatus("asr-done");
        clipState.setNoSubtitleReason(noSubtitleReasonFromAsrSkipError(error));
        return "skip";
      }
      setStatus(`语音识别失败：${getErrorMessage(error)}`);
      broadcastSubtitleStatus("asr-failed");
      // 无字幕出口走字幕接受事务的逆操作（subtitle/commit.js）：清空选中态/
      // body/派生内容，fetchState 落 empty。失败原因随出口写入事务（不再提前
      // 直写）；asrResult 非 skip，不出引导文案。
      await commitNoSubtitle({ noSubtitleReason: "asr-failed", asrResult: "error" });
      return "error";
    }
  }

  // 等待当前视频进行中的共享转写并按其结果收尾（refreshClip 辅助抓取失败时的
  // 兜底路径：不清上下文，跟着共享转写一起完成）。按 bvid/cid 匹配共享单元，
  // 其它视频的后台转写不接——等待与收尾都只属于当前视频，避免把别的视频的
  // 成果上到当前 UI。转写失败由发起者的 catch 负责文案，这里静默退出；runId
  // 守卫只影响 UI 收尾，成果已在共享单元内落缓存。
  async function awaitActiveAsrTranscribe({ runId, bvid, cid }: { runId: number; bvid: string; cid: string }): Promise<void> {
    const videoKey = `${bvid}|${cid}`;
    let active: ActiveAsrTranscribe | null = null;
    for (const entry of activeAsrTranscribes.values()) {
      if (entry.videoKey === videoKey) {
        active = entry;
        break;
      }
    }
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

  // ASR 转写成功后的收尾：塞伪轨道（路径特有的前置动作，留在本模块）→ 字幕
  // 接受事务（subtitle/commit.js）→ 完成提示。pipeline 产物本身已按 from 排序，
  // 事务内幂等再收口一次（含共享转写/缓存副本路径），「subtitleBody 按 from
  // 升序」不变量单点保证。缓存写入已在转写共享单元内完成。runId 只守卫 UI
  // 状态收尾（被更新的抓取顶掉时静默让位，转写成果本身已落缓存）。
  async function finishAsrFallback({ runId, body, platformName }: { runId: number; body: SubtitleItem[]; platformName: string }): Promise<"done"> {
    ensureRunActive(runId);
    clipState.setSubtitles([
      { id: "asr", lan: "asr-zh", lanDoc: `语音识别（${platformName}）`, subtitleUrl: "" },
      ...(state.clip.subtitles || [])
    ]);
    await acceptSubtitle({
      body,
      selectedSubtitleId: "asr",
      selectedSubtitleUrl: "",
      selectedSubtitleLang: `语音识别（${platformName}）`
    });
    setStatus(`语音识别完成，已生成 ${body.length} 条字幕。`);
    broadcastSubtitleStatus("asr-done");
    return "done";
  }

  // 进行中转写探针（"当前视频在转写"语义，按 bvid/cid 匹配）：fetcher 的
  // refreshClip 失败兜底据此决定"继续等待当前视频的音频转写"还是走清上下文
  // 的错误路径。等待与收尾都只针对当前视频，其它视频的后台转写不拦截错误
  // 路径、也不会把别的视频成果上到当前 UI。
  function hasActiveAsrTranscribe({ bvid, cid }: { bvid: string; cid: string }): boolean {
    const videoKey = `${bvid}|${cid}`;
    for (const entry of activeAsrTranscribes.values()) {
      if (entry.videoKey === videoKey) {
        return true;
      }
    }
    return false;
  }

  return { maybeRunAsrFallback, awaitActiveAsrTranscribe, hasActiveAsrTranscribe };
}
