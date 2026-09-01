// extension/subtitle/commit.ts
// 「字幕接受」事务的唯一入口（CONTEXT.md 域词条）。
//
// 一段字幕成为当前视频生效字幕的六步序列——稳定排序（from 升序，读路径
// findActiveSubtitleIndex 二分依赖）→ 写 state（selectedSubtitleId/Url/Lang +
// subtitleBody）→ fetchState="ready" → 清 noSubtitleReason → await
// refreshDerivedContent()（笔记/SRT/TXT/预览派生）→ reader 开启则通知
// "subtitle-ready"。历史上该序列在 fetcher.js（CC 缓存命中/网络新抓）与
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
// subtitle/core、reader/presenter（常驻轻 seam）、reader/view-state（常驻微
// 模块，纯 state 读取）、shared/dom-utils、reader/ids（纯常量表）、shared/logging。

import { clipState } from "../core/state.js";
import type { NoSubtitleReason, SubtitleBodyItem } from "../core/state.js";
import { sortSubtitleBodyByFrom } from "./selection.js";
import { refreshDerivedContent } from "./core.js";
import { notifyReaderPresenter } from "../reader/presenter.js";
import { isReaderViewOpen } from "../reader/view-state.js";
import { byId } from "../shared/dom-utils.js";
import { ids } from "../reader/ids.js";

export interface CommitUiCallbacks {
  renderMeta(): void;
  renderSubtitleSelect(): void;
  setStatus(message: string): void;
}

// 渲染/状态栏回调（fetcher 注入，见模块头注）。接受事务本身不渲染（历史行为：
// loadSubtitle / fallback 的四个接受点均不调 renderMeta，渲染由调用方编排负责）；
// 无字幕出口需要 renderMeta / renderSubtitleSelect（轨道/元信息落空态）与
// setStatus（skip 分支的引导文案）。
let commitUi: CommitUiCallbacks | null = null;

// 由 fetcher 在模块求值期注入一次（取自 subtitle/ui.js 的 renderMeta /
// renderSubtitleSelect 与 ui-renderer 的 setStatus）。重复调用以最后一次为准
//（测试换纪元时随 fetcher 重新求值，天然幂等）。
export function configureCommitUi({ renderMeta, renderSubtitleSelect, setStatus }: CommitUiCallbacks) {
  commitUi = { renderMeta, renderSubtitleSelect, setStatus };
}

export interface AcceptSubtitleArgs {
  body: unknown[] | null | undefined;
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  selectedSubtitleLang: string;
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
  selectedSubtitleLang
}: AcceptSubtitleArgs): Promise<unknown[] | null | undefined> {
  const sortedBody = sortSubtitleBodyByFrom(body);
  clipState.setSelectedSubtitleId(selectedSubtitleId);
  clipState.setSelectedSubtitleUrl(selectedSubtitleUrl);
  clipState.setSelectedSubtitleLang(selectedSubtitleLang);
  clipState.setSubtitleBody(sortedBody as SubtitleBodyItem[]);
  clipState.setSubtitleFetchState("ready");
  clipState.setNoSubtitleReason(null);
  await refreshDerivedContent();
  if (isReaderViewOpen()) {
    notifyReaderPresenter("subtitle-ready");
  }
  return sortedBody;
}

export interface CommitNoSubtitleArgs {
  noSubtitleReason?: NoSubtitleReason;
  asrResult?: string;
}

// 无字幕出口（逆事务，applyNoSubtitleState + 两处收尾段的唯一实现）：清空选中
// 三项 + body + 派生内容 + 预览 DOM，fetchState 落 "empty"，写 noSubtitleReason，
// 渲染轨道/元信息，reader 开启则通知，skip 时状态栏落引导文案。与接受互为逆：
// 两者写齐同一组字段，任何时刻 state 不落在半事务态。
//
// noSubtitleReason 缺省（undefined）时保留现有值——fetcher 出口的原因已由
// maybeRunAsrFallback 各终态分支写入（asr-disabled / no-asr-config /
// asr-empty / asr-failed / null），这里不得覆盖；显式传参（含 null）则写入。
//
// maybeRunAsrFallback → done 即 return 的守卫属抓取编排（fallback 内部已走
// 接受事务收尾），留在 fetcher 的 finishNoSubtitle，不进本事务。
export async function commitNoSubtitle({ noSubtitleReason, asrResult }: CommitNoSubtitleArgs = {}): Promise<void> {
  if (!commitUi) {
    throw new Error("字幕接受事务的 UI 回调未注入（configureCommitUi），无字幕出口拒绝执行。");
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
  (byId(ids.preview) as HTMLTextAreaElement).value = "";
  if (noSubtitleReason !== undefined) {
    clipState.setNoSubtitleReason(noSubtitleReason);
  }
  commitUi.renderMeta();
  commitUi.renderSubtitleSelect();
  if (isReaderViewOpen()) {
    notifyReaderPresenter("subtitle-ready", "当前视频无字幕。");
  }
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
