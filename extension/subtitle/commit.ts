// extension/subtitle/commit.ts
// 「字幕接受」事务的唯一入口（CONTEXT.md 域词条）。
//
// 一段字幕成为当前视频生效字幕的六步序列——稳定排序（from 升序，读路径
// findActiveSubtitleIndex 二分依赖）→ 写 state（selectedSubtitleId/Url/Lang +
// subtitleBody）→ fetchState="ready" → 清 noSubtitleReason → await
// refreshDerivedContent()（笔记/SRT/TXT/预览派生）→ 通知 "subtitle-ready"
//（发射无条件：视图门控的裁决权归 reader 侧 init-essentials 分派链，见
// acceptSubtitle 内注）。两个事务均支持可选 runId 代次自检（M23 runId 协调）：
// 调用方传入自己的抓取代次时，写 state 前先与 clipState.fetchRunId 比对，代次
// 已被 URL 变化递增/新一轮抓取推进则抛 STALE_RUN 让位——reset 与在飞提交的
// 竞态由此收口在事务内（自检与首个 state 写入之间无 await，同步 reset 无法
// 楔入）。asr/fallback 的收尾不传 runId（它有自己的 isStale 视频键门控，见
// asr/fallback.ts），行为不变。历史上该序列在 fetcher.js（CC 缓存命中/网络新抓）与
// asr/fallback.js（ASR 缓存命中/转写完成）手抄了 4 处，逆操作（无字幕出口）
// 又在 subtitle/ui.js 的 applyNoSubtitleState + 两处调用点手抄——不变量的依据
//（selection.js 的排序注释）活在第三个文件里。本模块收口后一处持有事务：
// bug 只会发生在一个地方、也只修一个地方。
//
// 静态图无环约束（本设计的核心）：本模块禁止静态 import ui/ui-renderer.js 与
// subtitle/ui.js——二者是链层渲染/UI 模块（ui.js 还静态引用 fetcher），被
// commit 静态引用会把渲染闭包拖进事务层并成环。renderMeta /
// renderSubtitleSelect / setStatus 由 fetcher 在模块求值期经 configureCommitUi
// 注入一次。其余依赖全部是叶子或常驻轻模块：core/state、subtitle/selection、
// subtitle/core、reader/reader-bus（常驻轻 seam，arch-slim-2/03 自 presenter.ts
// 改名）、reader/view-state（常驻微
// 模块，纯 state 读取）、shared/logging。
//（digest-only-ui：经典侧栏面板的预览 textarea 已删除，commit 不再清空它。）

import { clipState } from "../core/state.js";
import type { NoSubtitleReason, SubtitleBodyItem } from "../core/state.js";
import { sortSubtitleBodyByFrom } from "./selection.js";
import { refreshDerivedContent } from "./core.js";
import { notifyReaderPresenter } from "../reader/reader-bus.js";
import { ensureRunActive } from "../shared/error-helpers.js";

export interface CommitUiCallbacks {
  setStatus(message: string): void;
}

// 渲染/状态栏回调（fetcher 注入，见模块头注）。接受事务本身不渲染（历史行为：
// loadSubtitle / fallback 的四个接受点均不调 renderMeta，渲染由调用方编排负责）；
// 无字幕出口只回 reader 的 subtitle-ready 通知（renderReadingView 落空态）与
// setStatus（skip 分支的引导文案）。
//（digest-only-ui：经典侧栏面板的 renderMeta/renderSubtitleSelect 已随旧壳
// 删除——无字幕出口对面板的元信息/下拉渲染改由 reader-bus 通知驱动。）
let commitUi: CommitUiCallbacks | null = null;

// 由 fetcher 在模块求值期注入一次（取自 subtitle/ui.js 的 setStatus 与
// ui-renderer 的 setStatus）。重复调用以最后一次为准
//（测试换纪元时随 fetcher 重新求值，天然幂等）。
export function configureCommitUi({ setStatus }: CommitUiCallbacks) {
  commitUi = { setStatus };
}

export interface AcceptSubtitleArgs {
  body: unknown[] | null | undefined;
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  selectedSubtitleLang: string;
  // 发起方抓取代次（可选，M23 runId 协调）：传入则提交前与 clipState.fetchRunId
  // 比对，已被 URL 变化递增/新一轮抓取推进时抛 STALE_RUN 让位（旧视频字幕不
  // 写进已重置的 state）。未传不校验（asr/fallback 收尾路径自有门控）。
  runId?: number;
}

// 字幕接受（四个写入点的唯一实现）：幂等稳定排序在写 state 前完成——
// 「subtitleBody 按 from 升序」不变量（core.js findActiveSubtitleIndex 二分
// 依赖，依据注释见 selection.js sortSubtitleBodyByFrom）由本模块单点保证。
// 旧缓存条目可能无序、ASR pipeline 产物与共享转写/缓存副本来源不一，均在此
// 统一收口。sorted 副本落 state，不原地修改入参；返回排序后的新数组（调用方
// 一般无需使用，缓存写入方在调用前自行持有有序副本）。
export async function acceptSubtitle({
  body,
  selectedSubtitleId,
  selectedSubtitleUrl,
  selectedSubtitleLang,
  runId
}: AcceptSubtitleArgs): Promise<unknown[] | null | undefined> {
  // runId 代次自检（可选）：守卫先于任何 state 写入，且与下方首个写入之间无
  // await——同步的 resetClipState 无法楔入自检与提交之间。
  if (runId !== undefined) {
    ensureRunActive(runId, clipState.fetchRunId);
  }
  const sortedBody = sortSubtitleBodyByFrom(body);
  clipState.setSelectedSubtitleId(selectedSubtitleId);
  clipState.setSelectedSubtitleUrl(selectedSubtitleUrl);
  clipState.setSelectedSubtitleLang(selectedSubtitleLang);
  clipState.setSubtitleBody(sortedBody as SubtitleBodyItem[]);
  clipState.setSubtitleFetchState("ready");
  clipState.setNoSubtitleReason(null);
  await refreshDerivedContent();
  // 发射无条件：视图门控的裁决权归 reader 侧（init-essentials 分派链按
  // readingViewOpen 跳过、lifecycle 处理体再按当前 state 投影）。这里按视图
  // 开关截断通知会让「抓取完成时视图未开」的轮次永久丢通知，字幕列表停在
  // 进入时的空态——落定后的对账重渲（lifecycle）依赖通知可达。
  notifyReaderPresenter("subtitle-ready");
  return sortedBody;
}

export interface CommitNoSubtitleArgs {
  noSubtitleReason?: NoSubtitleReason;
  asrResult?: string;
  // 发起方抓取代次（可选，语义同 AcceptSubtitleArgs.runId）：传入则出口前
  // 自检，代次已被推进时抛 STALE_RUN 让位，不再把「无字幕」写进新视频的 state。
  runId?: number;
}

// 无字幕出口（逆事务，applyNoSubtitleState + 两处收尾段的唯一实现）：清空选中
// 三项 + body + 派生内容，fetchState 落 "empty"，写 noSubtitleReason，
// 通知（renderReadingView 落空态），skip 时状态栏落引导文案。
//（digest-only-ui：经典侧栏面板的 preview DOM 与 renderMeta/renderSubtitleSelect
// 回调已删除——无字幕出口对阅读视图的呈现收敛到 subtitle-ready 通知。）与接受互为逆：
// 两者写齐同一组字段，任何时刻 state 不落在半事务态。
//
// noSubtitleReason 缺省（undefined）时保留现有值——fetcher 出口的原因已由
// maybeRunAsrFallback 各终态分支写入（asr-disabled / no-asr-config /
// asr-empty / asr-failed / null），这里不得覆盖；显式传参（含 null）则写入。
//
// maybeRunAsrFallback → done 即 return 的守卫属抓取编排（fallback 内部已走
// 接受事务收尾），留在 fetcher 的 finishNoSubtitle，不进本事务。
export async function commitNoSubtitle({ noSubtitleReason, asrResult, runId }: CommitNoSubtitleArgs = {}): Promise<void> {
  if (!commitUi) {
    throw new Error("字幕接受事务的 UI 回调未注入（configureCommitUi），无字幕出口拒绝执行。");
  }
  // runId 代次自检（可选，同 acceptSubtitle）：守卫先于任何 state 写入。
  if (runId !== undefined) {
    ensureRunActive(runId, clipState.fetchRunId);
  }
  clipState.setSelectedSubtitleId("");
  clipState.setSelectedSubtitleUrl("");
  clipState.setSelectedSubtitleLang("");
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("empty");
  clipState.setHotComments([]);
  clipState.setMarkdown("");
  clipState.setSrt("");
  clipState.setTxt("");
  if (noSubtitleReason !== undefined) {
    clipState.setNoSubtitleReason(noSubtitleReason);
  }
  // 发射无条件（同 acceptSubtitle）：裁决权归 reader 侧门控。
  notifyReaderPresenter("subtitle-ready", "当前视频无字幕。");
  if (asrResult === "skip") {
    commitUi.setStatus(buildNoSubtitleStatusMessage());
  }
}

// 无字幕提示（skip 分支）：基础文案 + 引导句。reason 取 clipState.noSubtitleReason
//（可显式传参覆盖）：未配置语音识别平台（no-asr-config）时引导用户去硅基流动
// 免费申请 API Key 并填入设置页；其余维持通用引导句。返回完整提示文案。
// 自 fetcher.js 随迁：文案是无字幕出口事务的一部分，唯一消费点在上面的
// commitNoSubtitle。
export function buildNoSubtitleStatusMessage(
  base = "当前视频无字幕。",
  reason: NoSubtitleReason = clipState.noSubtitleReason
): string {
  if (reason === "no-asr-config") {
    return `${base} 可免费申请硅基流动 API Key 并填入设置页，自动生成字幕。`;
  }
  return `${base} 可在设置页配置语音识别平台自动生成字幕。`;
}
