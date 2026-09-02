// Reader LAYOUT 层 · video-bind 域（阶段 3 自退役的 player-host.js 迁出）。
//
// 本文件只拥有「video 播放事件 ↔ 阅读视图同步」的绑定生命周期：
//   - bindReadingViewVideo：把 timeupdate/seeked/loadedmetadata 经
//     AbortController 绑到 video 上，事件回调经 ports.js 显式端口驱动 SYNC；
//   - unbindReadingViewVideoSync：abort 即移除整组监听。
//
// 阶段 3（B 形态收尾）：player-host 整页接管随 Digest 面板形态退役，原绑定
// 实现里的挂载/布局分支一并删除——loadedmetadata 不再触发 layoutReaderPlayerHost，
// seeked 不再排队控制条恢复（B 形态用户用原生控制条），宿主变化不再排队
// ensureReaderPlayerMounted（video 换新时「重新绑定」由本函数首行的
// readingVideoEl 比对兜底，sync tick 与 seek 入口都会路过）。原 player-host 的
// videoEventsBound 模块级标志删除：绑定与否以元素上的 __bocReadingSyncController
// 为准，单一事实来源（原实现里标志与控制器本就同生命周期，双轨是历史负担）。
//
// 依赖方向（保持层图不变）：本模块属 LAYOUT 层叶子，只依赖 state/video-probe/
// ports，不 import SYNC/LIFECYCLE 域；sync.js 经静态边 import 本模块。
import { state } from "../core/state.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
// 端口半边：SYNC 域回调经 reader 域唯一显式端口（ports.js 叶子，缺失即抛错）。
import { readerPorts } from "./ports.js";

// 解绑 video 同步监听：AbortController 挂在元素上（__bocReadingSyncController），
// abort 即移除整组 timeupdate/seeked/loadedmetadata 监听，无需再逐个
// removeEventListener 并 stash handler 引用。
export function unbindReadingViewVideoSync(): void {
  const prev = state.reader.readingVideoEl;
  if (prev && prev.__bocReadingSyncController) {
    prev.__bocReadingSyncController.abort();
    delete prev.__bocReadingSyncController;
  }
}

export function bindReadingViewVideo(video: HTMLVideoElement | null = getRuntimeVideoElement()): HTMLVideoElement | null {
  if (!video) {
    unbindReadingViewVideoSync();
    state.reader.readingVideoEl = null;
    return null;
  }

  if (state.reader.readingVideoEl === video && video.__bocReadingSyncController) {
    return video;
  }

  unbindReadingViewVideoSync();

  const syncHandler = (event: Event) => {
    if (state.reader.readingViewOpen) {
      // seek 后的滚动跟随重置为 auto（程序化滚动窗口）；布局/控制条恢复分支
      // 随 player-host 整页接管退役（见文件头注）。
      if (event?.type === "seeked") {
        state.reader.setNextScrollBehavior("auto");
      }
      // Resolved at call time through the explicit reader ports leaf
      // (./ports.js), so this never creates a static video-bind → sync.js edge.
      readerPorts.syncReadingViewPlayback();
    }
  };
  const controller = new AbortController();
  const { signal } = controller;
  video.addEventListener("timeupdate", syncHandler, { signal });
  video.addEventListener("seeked", syncHandler, { signal });
  video.addEventListener("loadedmetadata", syncHandler, { signal });
  video.__bocReadingSyncController = controller;
  state.reader.readingVideoEl = video;
  return video;
}
