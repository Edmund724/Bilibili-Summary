// 转写中间态呈现（PR3）：字幕 tab 内的 ASR 转写横幅 + 列表淡出禁用。
//
// 数据源（已核实的结论，见工单 09 PR3 实施说明）：
//   - chrome.runtime.sendMessage 的 boc-subtitle-status 广播**不会被发送方所在
//     content script 自己收到**（只达 popup/sidepanel 等扩展上下文），reader 与
//     转写编排同进程，监听 chrome.runtime.onMessage 无效；
//   - 因此相位经 shared/subtitle-status-bus.js 的进程内镜像读取/订阅——镜像由
//     subtitle/fetcher.js 的 broadcastSubtitleStatus 在原广播旁同步发布，跨
//     上下文场景（popup/sidepanel）行为不变；
//   - 分片进度（片 x/y）在页面侧拿不到：切片计划与总数只在 offscreen 文档内
//     （asr/chunker 的 decideChunks 在解码后才知道总时长），页面只收到无总数的
//     进度文本（「语音识别中 N 片…」经 onProgress → setStatus 写进
//     state.ui.statusText）。横幅进度条按「不确定进度」样式呈现，进度行实时
//     显示状态栏文本。
//
// 触发时机三路并保：
//   1. 订阅相位变化（bindReadingTranscribeBanner，lifecycle 组装根模块求值时
//      单点绑定）——转写发起/完成的实时切换；
//   2. renderReadingView 渲染尾部（lifecycle 调用）——打开视图晚于转写发起时，
//      经 getSubtitleStatusPhase() 恢复呈现；
//   3. sync 域 250ms tick（syncReadingViewPlayback 调用）——转写期间状态栏进度
//      文本（state.ui.statusText）被 onProgress 持续改写，tick 让进度行跟着刷新。
// 三处最终都收敛到本模块的 updateReadingTranscribeBanner（内部带脏检查，重复
// 调用零 DOM 写）。

import { state } from "../core/state.js";
import { getSubtitleStatusPhase, subscribeSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { ids } from "./state.js";

// 转写中判定：相位为 asr-transcribing 且字幕体仍为空。
// subtitleBody 非空时强制不算转写中：字幕接受事务（acceptSubtitle）先写 body
// 再由 finishAsrFallback 广播 asr-done，中间窗口相位仍是 asr-transcribing，
// 不能让横幅压住已成稿的列表（防御相位残留）。
export function isReaderTranscribing(): boolean {
  return getSubtitleStatusPhase() === "asr-transcribing" && !(state.clip.subtitleBody?.length > 0);
}

// 显隐 + 列表淡出禁用 + 进度行文本的一次性收敛写（脏检查：状态没变零 DOM 写）。
export function updateReadingTranscribeBanner(): void {
  const banner = document.getElementById(ids.readingTranscribeBanner);
  if (!banner) {
    return;
  }
  const transcribing = isReaderTranscribing();
  const nextHidden = !transcribing;
  if (banner.hidden !== nextHidden) {
    banner.hidden = nextHidden;
  }
  const tabBody = document.getElementById(ids.readingTabBodySubtitle);
  tabBody?.classList.toggle("is-transcribing", transcribing);
  if (transcribing) {
    // 进度行显示实时状态栏文本（「音频下载与解码中…」「语音识别中 2 片…」等，
    // 由 ASR 管线 onProgress 写入）；空文案时给兜底句。
    const progressNode = document.getElementById(ids.readingTranscribeProgress);
    const text = String(state.ui.statusText || "").trim() || "正在转写…";
    if (progressNode && progressNode.textContent !== text) {
      progressNode.textContent = text;
    }
  }
}

// 相位订阅（lifecycle 组装根模块求值时单点绑定一次；视图未开时只更新内部相位，
// 不碰 DOM）。订阅本身不回放当前相位——打开视图的恢复路径由 renderReadingView
// 尾部的 updateReadingTranscribeBanner 覆盖。
let bannerStatusBound = false;
export function bindReadingTranscribeBanner(): void {
  if (bannerStatusBound) {
    return;
  }
  bannerStatusBound = true;
  subscribeSubtitleStatusPhase(() => {
    if (state.reader.readingViewOpen) {
      updateReadingTranscribeBanner();
    }
  });
}
