// 字幕状态相位的进程内镜像叶子（PR3 转写中间态的数据源）。
//
// 背景：subtitle/fetcher.js 的 broadcastSubtitleStatus 用 chrome.runtime.sendMessage
// 把抓取/转写阶段（asr-transcribing / asr-done / asr-failed）广播给 popup /
// sidepanel 等扩展上下文。但 content script 发出的 runtime 广播**不会回送给
// 发送方所在 context 自己**——reader 与转写编排（asr/fallback 工厂经 fetcher
// 动态装载）同在 content script 进程，监听 chrome.runtime.onMessage 收不到。
// 因此 reader 域的转写中间态呈现改经本叶子直读/订阅同进程相位；跨上下文场景
// （popup/sidepanel）仍走原 chrome 广播，行为不变。
//
// 设计约束：零依赖常驻叶子（fetcher 与 reader 域都可静态 import，不拖重符号）；
// 只记「最后相位」+ 同步通知订阅者，不排队的 pub/sub——转写相位是状态而非事件流，
// 迟到的订阅方（如阅读模式打开晚于转写发起）经 getSubtitleStatusPhase() 读到
// 当前相位即可恢复呈现。

type SubtitleStatusListener = (phase: string) => void;

let lastPhase = "";
const listeners = new Set<SubtitleStatusListener>();

// 发布新相位：先更新 last（订阅方回调内读 get 拿到的必须是新值），再逐个通知。
// 单个订阅者回调抛错不影响其他订阅者（呈现层回调，绝不能打断抓取主流程的调用方）。
export function publishSubtitleStatusPhase(phase: string): void {
  const next = String(phase || "");
  if (!next) {
    return;
  }
  lastPhase = next;
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch {
      // 呈现回调异常不影响其他订阅者与发布方
    }
  }
}

// 当前（最后发布的）相位；从未发布过返回空串。
export function getSubtitleStatusPhase(): string {
  return lastPhase;
}

// 订阅相位变化，返回退订函数。不回放当前相位（需要当前值的订阅方在订阅后
// 自行读 getSubtitleStatusPhase()，避免回调内再入）。
export function subscribeSubtitleStatusPhase(listener: SubtitleStatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
