// entry/ 局部类型补充：content 入口使用的全局哨兵与 chrome.storage.onChanged。
// 不修改共享的 extension/chrome-types.d.ts，避免并行迁移互相覆盖；主 agent
// 收尾时可统一归并到 chrome-types.d.ts。

export {};

declare global {
  interface Window {
    __BOC_CONTENT_SCRIPT_LOADED__?: string;
    __BOC_CONTENT_BOOTSTRAP_STARTED__?: boolean;
  }

  var __BOC_CONTENT_SCRIPT_LOADED__: string | undefined;
  var __BOC_CONTENT_BOOTSTRAP_STARTED__: boolean | undefined;

  namespace chrome {
    namespace storage {
      interface StorageChange {
        oldValue?: unknown;
        newValue?: unknown;
      }

      interface OnChangedEvent {
        addListener(
          listener: (changes: Record<string, StorageChange>, areaName: "sync" | "local" | "managed") => void
        ): void;
      }

      const onChanged: OnChangedEvent;
    }
  }
}
