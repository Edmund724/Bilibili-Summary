// extension/pages/pages-chrome-types.d.ts
// pages/ 迁移模块触达、共享 chrome-types.d.ts（及其他目录局部声明）未覆盖的
// chrome API 表面：局部 ambient 补充，经 namespace 声明合并生效（不修改共享
// 声明文件）。保持最窄契约，只声明本目录实际使用的成员。

declare namespace chrome {
  namespace runtime {
    // sidepanel init / popup 设置入口打开选项页
    function openOptionsPage(): void;

    // Chrome 116+：查询 offscreen 文档是否存在（chat/offscreen-ensure 的
    // 存在性判定；Chrome <116 或查询失败时调用方降级为直接 createDocument）
    function getContexts(query: {
      contextTypes?: string[];
      documentUrls?: string[];
    }): Promise<unknown[]>;
  }

  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }

    interface OnChangedEvent {
      addListener(
        listener: (changes: Record<string, StorageChange>, areaName: string) => void
      ): void;

      // PR5：对话 tab 组合根的会话收尾要摘除 providers 刷新监听（bind/unbind
      // 对称；监听常驻挂载时用不到，声明合并对各 context 同时生效）。
      removeListener(
        listener: (changes: Record<string, StorageChange>, areaName: string) => void
      ): void;
    }

    const onChanged: OnChangedEvent;
  }

  namespace tabs {
    interface Tab {
      // tabs.onUpdated / query 结果的活动标志（sidepanel 只对 active 标签同步）
      active?: boolean;
    }

    interface OnActivatedEvent {
      addListener(listener: (activeInfo: { tabId?: number }) => void): void;
    }

    const onActivated: OnActivatedEvent;
  }
}

// popup 探针注入 content script 顶层的加载哨兵（entry/content-bootstrap 写入，
// popup 经 chrome.scripting.executeScript 的 func 读取）
declare var __BOC_CONTENT_SCRIPT_LOADED__: string | undefined;
