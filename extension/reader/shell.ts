// reader/shell.ts — 阅读壳唯一事务（CONTEXT.md「阅读壳」词条的代码落点，
// 工单 .scratch/tickets/arch-slim/issues/02-reader-shell.md）。
//
// 进入与退出 Digest 面板阅读形态各只剩一条路：enterReaderShell（按意图三档
// open 进入 / restore 恢复 / focus-chat 进对话）与 exitReaderShell（逆事务）。
// 八步无闪变时序（suppressUntil → 摘播放器快捷按钮 → resolveReaderEntryUrl →
// ensureUiReady → replaceReaderModeUrl → ensureReaderStyles → 翻 body/html
// 门控属性 → enterReaderMode）与 restore 档 shell 完好性自查只存在于本文件，
// 唯一性由 tests/reader/shell-sequence.test.ts 扫描断言把关。
//
// 挂在现有 ensureReaderDomain 接缝后：本模块属常驻 chunk（message-handler 的
// reading-view 分支、ui-renderer 关闭按钮、digest-button 守卫判定静态委托到
// 这里），reader 重符号一律经 core/lazy-* 动态装载边取用，不把重域拖进常驻
// 图。依赖方向：shell → core/lazy-*（动态边）+ 各常驻叶子，无环。
//
// 三个消费面：
//   - core/message-handler.ts：reader-enter / reader-restore / reader-enter-chat
//     / reader-close 四个消息分支退化成一两行委托；
//   - ui/ui-renderer.ts：Digest 面板关闭按钮的关闭链退化为 exitReaderShell 委托；
//   - ui/digest-button.ts：定时自查的失同步判定改用 isReaderShellIntact
//    （原本地手抄的同一判定收口为唯一实现）。
//
// 另有 enterReaderShellOnUrlNavigation：URL 跳转编排（bindUrlChangeHandler）的
// 进入入口。页内跳转到 boc_reader=1 地址而视图未开时走它——与消息意图三档共
// 享同一条进入链（runReaderEntrySequence 唯一实现），但无 player-ai 前奏
// （URL 跳转没有用户点击在先，不抑制也不摘 AI 悬浮按钮，与收口前行为逐字
// 一致），并把「进入前播报」「失败口径」作为编排侧参数注入。

import { suppressUntil } from "../ai/player-ai-state.js";
import { replaceReaderModeUrl } from "../bilibili/reader-url.js";
import {
  cleanVideoUrl,
  isReaderMode,
  stripReaderModeUrl
} from "../bilibili/video-id-shared.js";
import { ensureReaderChatTab } from "../core/lazy-chat-tab.js";
import { ensureUiReady } from "../core/lazy-ui.js";
import { loadPlayerAi, isPlayerAiLoaded } from "../core/lazy-player-ai.js";
import { ensureReaderDomain } from "../core/lazy-reader.js";
import { ensureReaderStyles, removeReaderStyles } from "../shared/style-injector.js";
import { logWarn } from "../shared/logging.js";
import { ids, isReaderViewOpen } from "./state.js";

export type ReaderShellIntent = "open" | "restore" | "focus-chat";

export interface EnterReaderShellOptions {
  readerUrl: string;
  intent: ReaderShellIntent;
  /** focus-chat 档专用：非空 = 激活对话 tab 后自动发送快捷提示词；空 = 只定位/聚焦 */
  prompt?: string;
}

// 空 readerUrl 的语义是「已在阅读模式内，只聚焦/激活」。但 background 的
// player-ai / reading-chat 链在视图未开时也传空串（triggerReaderModeInTab 的
// 空 readerUrl 参数）——此时必须用当前地址兜底构造阅读 URL，否则 URL 改写、
// 阅读表与 data-boc-reader-mode 门控全被跳过，enterReaderMode 落在无样式的
// 半进入态（页面布局微变但阅读模式不出现）。拼法与 ui/digest-button.ts
// buildReaderUrl 一致（cleanVideoUrl 清成规范 URL 再加 boc_reader=1）。
function resolveReaderEntryUrl(readerUrl: string): string {
  if (readerUrl || isReaderViewOpen()) {
    return readerUrl;
  }
  const base = cleanVideoUrl(location.href);
  try {
    const parsed = new URL(base);
    parsed.searchParams.set("boc_reader", "1");
    return parsed.toString();
  } catch {
    return base;
  }
}

// 壳完好性自查（唯一判定，restore 自愈与 digest 按钮守卫共用的同一 predicate）：
// 状态说视图开着，但 DOM 侧任一必要呈现条件缺失——壳被页面重渲染整树摘走、
// .open 掉了、ready 门控卡 0、html/body 门控属性被页面侧清掉。任一命中面板都
// 不可见，而 readingViewOpen 仍为 true，digest 按钮被守卫永久压住——表现为
// 「侧边栏和按钮一起消失，只能刷新」。restore 档据此在进入链前收敛失同步。
// 注意：本判定是纯 DOM 谓词，不含 readingViewOpen 状态位；「视图开着且失整」
// 的组合判断由调用方表达（restore 档的 beforeEntry / digest-button 的守卫）。
export function isReaderShellIntact(): boolean {
  const shell = document.getElementById(ids.readingView);
  return Boolean(
    shell?.isConnected &&
      shell.classList.contains("open") &&
      shell.getAttribute("data-boc-reader-ready") !== "0" &&
      document.body.getAttribute("data-boc-reader-mode") === "1" &&
      document.documentElement.getAttribute("data-boc-reader-mode") === "1"
  );
}

// ===== 唯一进入链（八步时序的后六步；前两步按入口前奏补齐） =====
//
// ensureUiReady（壳就绪）→ beforeEntry（restore 档的失同步自查在此插，见下）→
// resolveReaderEntryUrl → replaceReaderModeUrl → ensureReaderStyles → 翻
// body/html 门控属性 → enterReaderMode（视图未开才进）。
//
// 无闪变不变式：先挂阅读表再翻属性——门控属性是样式生效开关，表提前挂（哪怕
// link 尚未加载完）不会误伤普通页面；属性翻转瞬间阅读样式已注入，无闪变窗口。
//
// beforeEntry 供 restore 档插入「壳完好性自查 + 失整先收敛」：closeReadingView
// 要取壳节点，必须排在 ensureUiReady 之后（收敛前先把壳补回来），故不能放在
// 本链之外。错误不在此捕获——ensureUiReady / enterReaderMode 失败统一抛给各
// 公开入口的兜底口径（消息意图档记日志、导航入口写状态栏），与收口前各分支
// 的失败语义一致。
interface ReaderEntrySequenceOptions {
  readerUrl: string;
  beforeEntry?: () => Promise<void>;
}

async function runReaderEntrySequence(options: ReaderEntrySequenceOptions): Promise<void> {
  // 候选03：先确保 UI 壳存在，再设置阅读模式属性并进入重域。ensureUiReady
  // 经 core/lazy-ui 惰性构建 UI 壳，与后续 reader 操作串成同一 promise 链，
  // 避免并发触发导致壳构建两次。
  await ensureUiReady();
  await options.beforeEntry?.();
  const readerUrl = resolveReaderEntryUrl(options.readerUrl);
  if (readerUrl) {
    replaceReaderModeUrl(readerUrl);
    // S3：先挂阅读表再翻属性（无闪变时序，见上方不变式注）
    ensureReaderStyles();
    document.documentElement.setAttribute("data-boc-reader-mode", "1");
    document.body.setAttribute("data-boc-reader-mode", "1");
  }
  if (!isReaderViewOpen()) {
    // 候选02：enterReaderMode 属 reader 重域，经 ensureReaderDomain 装载后
    // 进入（点击路径的本地动态装载对用户无感）。
    const reader = await ensureReaderDomain();
    await reader.enterReaderMode();
  }
}

// restore 档的失同步自愈（进入链前收敛）：状态开着而壳失整时先走退出事务把
// 失同步状态清干净（readingViewOpen 卡 true、digest 按钮被压住的那档故障），
// 再交给进入链重开。收敛失败只记日志不阻断（与收口前处理器口径一致）；重开
// 会话态由各 tab 的恢复路径接管（对话从会话历史恢复、概览读缓存）。
async function restoreSelfHealBeforeEntry(): Promise<void> {
  if (!isReaderViewOpen() || isReaderShellIntact()) {
    return;
  }
  try {
    const reader = await ensureReaderDomain();
    reader.closeReadingView();
  } catch (error) {
    logWarn("[BOC] reading view restore: close failed", error);
  }
}

// 进入事务（三档意图）。返回的 promise 在事务收敛后 resolve（含失败——失败
// 已按档位口径记日志，不再向上抛，调用方的响应时序不受影响）；消息处理器
// 即答语义与收口前一致（sendResponse 不等待事务完成）。
export function enterReaderShell(options: EnterReaderShellOptions): Promise<void> {
  const { intent } = options;
  // 消息载荷的收敛口径沿用收口前处理器：readerUrl / prompt 先 trim（空白视为空）
  const readerUrl = String(options.readerUrl || "").trim();
  const prompt = String(options.prompt || "").trim();
  // 各档失败的日志口径沿用收口前处理器文案（debug 日志，消费方无感知差异）
  const onFailed = (error: unknown): void => {
    logWarn(
      intent === "open"
        ? "[BOC] reading mode trigger failed"
        : intent === "restore"
          ? "[BOC] reading view restore failed"
          : "[BOC] reading chat trigger failed",
      error
    );
  };

  // 前奏一（八步第 1 步）：抑制 player-ai 快捷按钮 2.5s（等阅读模式 URL 翻转
  // 与重域装载完成，防止过渡期重复触发）。restore 档同样抑制（与收口前一致）。
  suppressUntil(Date.now() + 2500);

  return (async () => {
    // 前奏二（八步第 2 步）：摘播放器快捷按钮。restore 档不摘（失同步自愈与
    // 用户点击无关）。原为同步 remove；懒加载后「未加载 ⇒ 无按钮」可直接跳过，
    // 已加载时经 promise 移除（延后一个 tick，视觉无差异）。失败静默：移除
    // 按钮失败不应阻断阅读模式打开，且 suppressedUntil 已保证按钮短期不再弹出。
    if (intent !== "restore" && isPlayerAiLoaded()) {
      void loadPlayerAi()
        .then((playerAi) => playerAi.removePlayerAiQuickActionButton())
        .catch(() => {});
    }
    await runReaderEntrySequence({
      readerUrl,
      beforeEntry: intent === "restore" ? restoreSelfHealBeforeEntry : undefined
    });
    if (intent === "focus-chat") {
      // PR5c：先确保 reader shell（进入链已完成），再激活对话 tab 并（带
      // prompt 时）自动发送快捷提示词。快捷动作路径传 consumeIntent:false
      // （与快捷发送互不踩踏）；无 prompt 则只定位/聚焦对话 tab。
      const chat = await ensureReaderChatTab();
      if (prompt) {
        await chat.runQuickActionPrompt(prompt);
      } else {
        await chat.ensureChatTabActivated({ consumeIntent: false });
      }
    }
  })().catch((error) => {
    // 壳构建等前序步骤失败：进入链整体中止（restore/focus-chat 与收口前的
    // 兜底口径一致；open 档收口前为未处理拒绝，现收敛为记日志，debug 无感）。
    onFailed(error);
  });
}

export interface EnterReaderShellOnUrlNavigationOptions {
  readerUrl: string;
  /** 进入前播报（等它落地才进入，防止反向覆盖 enterReaderMode 的就绪文案） */
  announce?: () => Promise<void> | void;
  /** 进入失败的编排侧口径（如写状态栏）；缺省记日志 */
  onEnterFailed?: (error: unknown) => void;
}

// URL 跳转编排入口（core/message-handler.ts 的 bindUrlChangeHandler）：popstate/
// hashchange/boc:urlchange 落在 boc_reader=1 地址而视图未开时走本入口。与消息
// 意图三档共享同一条进入链（runReaderEntrySequence 唯一实现），但无 player-ai
// 前奏——URL 跳转没有用户点击在先，不抑制也不摘 AI 悬浮按钮（按钮同步由编排
// 自身的 schedulePlayerAiQuickActionSync 负责，与收口前行为一致）。
export function enterReaderShellOnUrlNavigation(
  options: EnterReaderShellOnUrlNavigationOptions
): Promise<void> {
  return (async () => {
    if (options.announce) {
      // 播报失败不阻断进入（与收口前 Promise.all 的吞错口径一致）
      await Promise.resolve(options.announce()).catch(() => {});
    }
    await runReaderEntrySequence({ readerUrl: options.readerUrl });
  })().catch((error) => {
    if (options.onEnterFailed) {
      options.onEnterFailed(error);
    } else {
      logWarn("[BOC] reading view start failed", error);
    }
  });
}

// 退出事务（逆事务）：URL 收敛 → closeReadingView → 摘阅读表。吸收收口前的
// 两处手抄——reader-close 消息处理器与 Digest 面板关闭按钮链（两者语义相同：
// 先收敛地址栏再关视图；关闭按钮不回包、消息路径按结果回包，差异只在失败
// 口径，由调用方在返回的 promise 上自行接）。
export async function exitReaderShell(): Promise<void> {
  // URL 改写保持同步语义（与收口前一致地先收敛地址栏）；非阅读模式 URL 不改
  // 写（页内跳转后关闭按钮可能落在普通地址上）。改写失败向上抛：消息路径据
  // 此按错误回包，且不会继续执行关闭（与收口前 try/catch 短路一致）。
  if (isReaderMode()) {
    replaceReaderModeUrl(stripReaderModeUrl(location.href));
  }
  // closeReadingView 属 reader 重域，经 ensure 装载后执行（视图开着 ⇒ 域几乎
  // 必然已装载，此处只是兜底直开路径）。
  const reader = await ensureReaderDomain();
  reader.closeReadingView();
  // S3：关闭后移除阅读表——门控样式随属性清除（closeReadingView 按
  // presentation-fields 的 clearOnClose 清单翻回）已停止生效，摘表进一步释放
  // 级联；下次进入重挂（link 数据在浏览器缓存，二进宫无闪变）。
  removeReaderStyles();
}
