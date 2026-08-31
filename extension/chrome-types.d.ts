// extension/chrome-types.d.ts
// 最小 Chrome 扩展 API 类型声明：本仓库未安装 @types/chrome，声明覆盖迁移模块
// 实际使用的 runtime / tabs / storage / permissions / scripting / sidePanel /
// offscreen 表面。保持最窄契约，不扩展未使用的方法/事件。

declare namespace chrome {
  namespace runtime {
    interface LastError {
      message?: string;
    }

    interface Manifest {
      version: string;
    }

    interface MessageSender {
      tab?: { id?: number; url?: string };
      origin?: string;
      id?: string;
    }

    type SendMessageCallback = (response?: unknown) => void;

    const lastError: LastError | undefined;

    function getManifest(): Manifest;
    function getURL(path: string): string;
    function sendMessage(message: unknown): Promise<unknown>;
    function sendMessage(message: unknown, responseCallback?: SendMessageCallback): void;

    interface Port {
      name: string;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: {
        addListener(listener: (message: unknown) => void): void;
        removeListener(listener: (message: unknown) => void): void;
      };
      onDisconnect: {
        addListener(listener: () => void): void;
        removeListener(listener: () => void): void;
      };
    }

    interface OnConnect {
      addListener(listener: (port: Port) => void): void;
    }

    interface OnMessage {
      addListener(
        listener: (message: unknown, sender: MessageSender, sendResponse: SendMessageCallback) => boolean | void
      ): void;
      removeListener(
        listener: (message: unknown, sender: MessageSender, sendResponse: SendMessageCallback) => boolean | void
      ): void;
    }

    interface OnInstalled {
      addListener(listener: (details: { reason: string }) => void): void;
    }

    const onConnect: OnConnect;
    const onMessage: OnMessage;
    const onInstalled: OnInstalled;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      status?: string;
      url?: string;
    }

    interface CreateProperties {
      url?: string;
    }

    interface UpdateProperties {
      url?: string;
    }

    interface OnUpdatedEvent {
      addListener(
        listener: (tabId: number, changeInfo: { status?: string }, tab: Tab) => void
      ): void;
    }

    function get(tabId: number): Promise<Tab>;
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function create(createProperties: CreateProperties): Promise<Tab>;
    function update(tabId: number, updateProperties: UpdateProperties): Promise<Tab>;
    function reload(tabId: number): Promise<void>;
    function sendMessage(tabId: number, message: unknown, responseCallback?: (response: unknown) => void): void;

    const onUpdated: OnUpdatedEvent;
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }

    const sync: StorageArea;
    const local: StorageArea;
  }

  namespace permissions {
    function contains(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    function request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    function remove(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number;
    }

    interface InjectionResult {
      result?: unknown;
    }

    function executeScript(injection: { target: InjectionTarget; files: string[] }): Promise<InjectionResult[]>;
    function executeScript(injection: { target: InjectionTarget; func: () => unknown }): Promise<InjectionResult[]>;
    function insertCSS(injection: { target: InjectionTarget; files: string[] }): Promise<void>;
  }

  namespace sidePanel {
    interface OpenOptions {
      tabId?: number;
    }

    const open: ((options: OpenOptions) => Promise<void>) | undefined;
  }

  namespace offscreen {
    function closeDocument(): Promise<void>;
  }
}
