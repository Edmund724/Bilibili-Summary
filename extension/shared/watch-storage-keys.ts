// extension/shared/watch-storage-keys.ts
// chrome.storage.onChanged 的区/键过滤薄 seam（arch-slim-3/riders R3）。
// 此前五处监听（content 播放器 AI 开关门、reader 设置 watcher、reader chat-tab
// 供给刷新、options 设置面板、debug-log-gate）各自 addListener 并各自手写
// area 门 + 键存在性检查；此处收口为单条真实 chrome.storage.onChanged 监听
// （首个订阅者时懒注册、末个退订时摘除），按订阅者声明的「区 → 键清单」
// 逐订阅者过滤分发。
// 分发必须仍经 chrome.storage.onChanged.addListener 注册的真实监听完成——
// 测试以捕获该 API 的 stub 回调方式触发，不存在绕过 API 直调回调的捷径。

// 区 → 键清单：声明了哪区才监听哪区，区内的键命中才分发。
export interface StorageKeyWatch {
  sync?: readonly string[];
  local?: readonly string[];
}

type StorageChangeMap = { [key: string]: chrome.storage.StorageChange };
type StorageOnChangeHandler = (changes: StorageChangeMap, areaName: string) => void;

interface StorageKeySubscription {
  watch: StorageKeyWatch | undefined;
  handler: StorageOnChangeHandler;
}

const subscriptions = new Set<StorageKeySubscription>();
// 已注册监听的宿主事件对象（注册在哪个 chrome.storage.onChanged 上）；null = 未注册。
let registeredHost: typeof chrome.storage.onChanged | null = null;

function subscriptionMatches(subscription: StorageKeySubscription, changes: StorageChangeMap, areaName: string): boolean {
  if (!subscription.watch) {
    // 未声明键清单 = 不过滤：任意区任意键都分发。
    return true;
  }
  const keys = subscription.watch[areaName as keyof StorageKeyWatch];
  if (!keys) {
    return false;
  }
  return keys.some((key) => Object.prototype.hasOwnProperty.call(changes, key));
}

const dispatchListener = (changes: StorageChangeMap, areaName: string): void => {
  // 快照迭代：handler 内再订阅/退订不影响本轮分发。
  for (const subscription of [...subscriptions]) {
    if (!subscriptionMatches(subscription, changes, areaName)) {
      continue;
    }
    subscription.handler(changes, areaName);
  }
};

export function watchStorageKeys(handler: StorageOnChangeHandler, watch?: StorageKeyWatch): () => void {
  const subscription: StorageKeySubscription = { watch, handler };
  subscriptions.add(subscription);
  // 懒注册：首个订阅者才挂真实监听；宿主换代（测试重装 stub）时补注册。
  const host = typeof chrome === "undefined" ? undefined : chrome.storage?.onChanged;
  if (host && registeredHost !== host) {
    host.addListener(dispatchListener);
    registeredHost = host;
  }
  return () => {
    subscriptions.delete(subscription);
    if (registeredHost && subscriptions.size === 0) {
      registeredHost.removeListener(dispatchListener);
      registeredHost = null;
    }
  };
}
