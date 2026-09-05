// reader 域懒加载转发助手（arch-slim-2/06：自 ui/ui-renderer.ts 提为共享叶子）。
//
// 为什么是叶子：ui 按 tab 收口后，「装载 reader 域 → 转发回调 → 失败口径」的
// 消费方从壳一家变成壳 + 三个 tab 绑定叶子（reader/subtitle-tab-ui.ts /
// reader/explain-pop-ui.ts / reader/overview-ui.ts），助手必须单源（禁止复制，
// 工单 06 半场裁定：提为共享叶子）。本模块零静态 reader 依赖——唯一的动态边
// 在 core/lazy-reader.ts 内部（reader/index.js chunk 入口不变形），因此可被
// ui 壳闭包静态携带而不拖重域。
//
// - withReader(label, fn)：失败记 logWarn，错误标签一处声明（调用点只传
//   label，文案恒为 "[BOC] <label> failed"，与收口前逐字一致）；label 传 null
//   表示静默——高频滚动/点击路径装载失败不打日志、下次交互自然重试（原语义）。
// - whenReaderReady(fn)：不吞错的内核，供需沿调用方链传播错误的场景
//   （字幕切换链的统一 catch）复用。
//
// ensureReaderDomain 的返回类型在 core/lazy-reader.ts 只声明了启动期窄接口
//（enterReaderMode/closeReadingView/waitForVideoMetadata/seekReadingTarget）；
// 转发的交互回调落在 reader/index.ts 动态域入口的完整导出面上
//（syncReadingViewPlayback/updateReaderPreferences/renderReaderPanels 等）。
// 此处以动态域入口模块类型交叉收口，运行时对象不变（与原调用完全一致）。

import { logWarn } from "../shared/logging.js";
import { ensureReaderDomain } from "../core/lazy-reader.js";

type ReaderDomain = typeof import("../reader/index.js");
type UiReaderDomain = Awaited<ReturnType<typeof ensureReaderDomain>> & ReaderDomain;
const loadReaderDomain = ensureReaderDomain as () => Promise<UiReaderDomain>;

export function whenReaderReady(fn: (reader: UiReaderDomain) => unknown): Promise<unknown> {
  return loadReaderDomain().then(fn);
}

export function withReader(label: string | null, fn: (reader: UiReaderDomain) => unknown): void {
  whenReaderReady(fn).catch((error) => {
    if (label) logWarn(`[BOC] ${label} failed`, error);
  });
}
