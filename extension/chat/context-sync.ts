// extension/chat/context-sync.ts — 触发源驱动的实时上下文同步调度（候选5 自
// sidepanel.ts 迁出；PR5 自 extension/pages/sidepanel-context-sync.ts 迁入 chat
// 域并重定义触发源）。
//
// scheduleLiveContextSync 的防抖 + 强刷合并机制保留；防抖到期后转调 deps.sync
//（post-sync 分支编排留在组合根）。触发源分两个世界：
//   - sidepanel 世界（过渡期保留，语义与迁移前一致）：visibility / focus /
//     tabs.onActivated / tabs.onUpdated——「侧栏常驻、用户在 B 站页面间切换」。
//     监听挂载留在 sidepanel.ts bindEvents。
//   - reader 世界（PR5 新增，供 reader 对话 tab 组合根接线）：boc:urlchange
//     URL watcher 事件（core/url-watcher.ts 广播）+ reader 打开/关闭事件。
//     reader 模式下对话 tab 就在视频页内，标签页切换大半不存在，等价触发源
//     换成这两个。
//
// 依赖方向（无环）：纯防抖状态机，不 import chat-state（post-sync 分支
// 编排由 deps.sync 回调承载，组合根组装）；定时器可注入（生产用 window，
// 测试手动推进）。本模块不 import 组合根。

export interface CreateLiveContextSyncDeps {
  // 防抖到期后的同步执行体（post-sync 分支编排留在组合根：流式守卫判定 +
  // chip 更新 / 初始态渲染 / 建议区渲染的组合属于页面级职责）
  sync: (forceRefresh?: boolean) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
}

export interface LiveContextSync {
  // scheduleLiveContextSync：forceRefresh 挂起合并（false 不覆盖 true），
  // 防抖间隔 220ms，挂起的强刷走 120ms 快档（与迁移前一致）。
  schedule: (forceRefresh?: boolean) => void;
  // syncLiveContextState：防抖到期执行体（测试可直接驱动）。
  sync: (forceRefresh?: boolean) => Promise<void>;
  // 触发源的事件处理体（监听挂载留在组合根 bindEvents）。
  handlers: {
    // ---- sidepanel 世界（过渡期保留） ----
    onVisibilityChange: () => void;
    onFocus: () => void;
    onTabActivated: () => void;
    onTabUpdated: (tabId: number, changeInfo: { status?: string; url?: string }, tab: { active?: boolean } | undefined) => void;
    // ---- reader 世界（PR5 新增） ----
    onUrlChange: () => void;
    onReaderOpened: () => void;
    onReaderClosed: () => void;
  };
}

export function createLiveContextSync(deps: CreateLiveContextSyncDeps): LiveContextSync {
  // 防抖定时器句柄与挂起的 forceRefresh（纯局部单例，随工厂实例存活）
  let liveContextSyncTimer = 0;
  let liveContextSyncForceRefresh = false;

  function schedule(forceRefresh = false): void {
    liveContextSyncForceRefresh = liveContextSyncForceRefresh || forceRefresh;
    if (liveContextSyncTimer) {
      deps.clearTimer(liveContextSyncTimer);
    }
    liveContextSyncTimer = deps.setTimer(() => {
      const nextForceRefresh = liveContextSyncForceRefresh;
      liveContextSyncTimer = 0;
      liveContextSyncForceRefresh = false;
      void deps.sync(nextForceRefresh);
    }, forceRefresh ? 120 : 220);
  }

  function sync(forceRefresh = false): Promise<void> {
    return deps.sync(forceRefresh);
  }

  // 触发源的事件处理体（监听挂载留在组合根 bindEvents，语义与迁移前一致）：
  //   - 可见性/聚焦/切签：一律 forceRefresh=false——全网络重拉（content 侧
  //     popup-refresh → refreshClip 全量重抓字幕）不是它们的语义，状态是否有变
  //     交给签名短路判定：content 侧未变时一次往返即返回 unchanged，不再有
  //     任何字幕/热评网络开销。
  //   - tabs.onUpdated：URL 变化保持 forceRefresh=true（切 P/切视频必须全网络
  //     重拉，会与 debounce 里已挂起的 false 合并取强）；status==="complete"
  //     保持 false（若 content 已随加载重建了状态，签名必然不同会走全量；
  //     相同则短路，不再借完成事件做无谓的强制重拉）。仅响应 active 标签页的
  //     url 变化或加载完成。
  //   - onUrlChange（reader 世界）：URL watcher 的 boc:urlchange 事件，等价于
  //     tabs.onUpdated 的 url 变化 → 强刷快档（导航级低频事件；与 debounce 里
  //     挂起的弱刷合并取强）。
  //   - onReaderOpened / onReaderClosed（reader 世界）：对话 tab 所在视图打开 /
  //     关闭。打开 → 弱刷一轮（签名短路判定是否有变，与可见性恢复同语义）；
  //     关闭 → 对话区随视图卸载，无需同步（no-op；组合根可不接线）。
  return {
    schedule,
    sync,
    handlers: {
      onVisibilityChange: () => {
        if (!document.hidden) {
          schedule(false);
        }
      },
      onFocus: () => {
        schedule(false);
      },
      onTabActivated: () => {
        schedule(false);
      },
      onTabUpdated: (tabId: number, changeInfo: { status?: string; url?: string }, tab: { active?: boolean } | undefined): void => {
        void tabId;
        if (!tab?.active) {
          return;
        }
        if (!changeInfo.url && changeInfo.status !== "complete") {
          return;
        }
        schedule(Boolean(changeInfo.url));
      },
      onUrlChange: () => {
        schedule(true);
      },
      onReaderOpened: () => {
        schedule(false);
      },
      onReaderClosed: () => {
        // 视图关闭即对话区卸载：无挂起同步的必要（防抖到期前的残留同步无害，
        // 不引入 cancel 原语——与迁移前的状态机形状保持一致）。
      }
    }
  };
}
