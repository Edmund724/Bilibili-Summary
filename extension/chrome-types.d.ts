// extension/chrome-types.d.ts
// 最小 Chrome 扩展 API 类型声明：本仓库未安装 @types/chrome，声明覆盖迁移模块
// 实际使用的 runtime / tabs / storage / permissions / scripting / offscreen /
// declarativeNetRequest 表面。保持最窄契约，不扩展未使用的方法/事件。
// 域目录的局部 ambient 补充（asr/chrome-asr-types.d.ts、entry/entry-globals.d.ts）
// 已归并于此，不再维护分散声明。

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
    // 页面直连 offscreen 文档的具名端口（asr-decode 端口，asr/offscreen-bridge.page）。
    function connect(connectInfo: { name: string }): Port;
    function sendMessage(message: unknown): Promise<unknown>;
    function sendMessage(message: unknown, responseCallback?: SendMessageCallback): void;
    // Chrome 116+：查询 offscreen 文档是否存在（chat/offscreen-ensure 的
    // 存在性判定；Chrome <116 或查询失败时调用方降级为直接 createDocument）。
    //（声明自删掉的 pages/pages-chrome-types.d.ts 归并于此。）
    function getContexts(query: {
      contextTypes?: string[];
      documentUrls?: string[];
    }): Promise<unknown[]>;

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

  namespace action {
    // 工具栏 action（manifest.action，无 default_popup）：点击事件在
    // entry/background.ts 顶层同步注册（MV3：SW 重启后监听器须在首个事件前
    // 就位）。本仓库只用 onClicked，不扩展未使用的表面。
    interface OnClickedEvent {
      addListener(listener: (tab: tabs.Tab) => void): void;
    }

    const onClicked: OnClickedEvent;
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

    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }

    interface OnChangedEvent {
      addListener(
        listener: (changes: Record<string, StorageChange>, areaName: string) => void
      ): void;
      // 对话组合根的会话收尾摘除 providers 刷新监听（bind/unbind 对称；
      // 声明自删掉的 pages/pages-chrome-types.d.ts 归并于此）。
      removeListener(
        listener: (changes: Record<string, StorageChange>, areaName: string) => void
      ): void;
    }

    const sync: StorageArea;
    const local: StorageArea;
    const onChanged: OnChangedEvent;
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

  namespace offscreen {
    interface CreateDocumentOptions {
      url: string;
      reasons: string[];
      justification: string;
    }

    function createDocument(options: CreateDocumentOptions): Promise<void>;
    function closeDocument(): Promise<void>;
  }

  namespace declarativeNetRequest {
    interface SessionRule {
      id: number;
    }

    interface ModifyHeaderInfo {
      header: string;
      operation: string;
      value?: string;
    }

    interface RuleAction {
      type: string;
      requestHeaders?: ModifyHeaderInfo[];
    }

    interface RuleCondition {
      urlFilter?: string;
      // 域名匹配（Chrome 101+，最低支持版本 120 已覆盖）：与 urlFilter 的
      // "||domain" 不同，requestDomains 只精确匹配域名本身及其子域，不会
      // 误命中 "bilivideo.com.evil.com" 这类拼接域——防盗链规则的目标 host
      // 收窄用（asr/offscreen-bridge.bg.ts addDownloadRules）。
      requestDomains?: string[];
      resourceTypes: string[];
    }

    interface Rule {
      id: number;
      priority?: number;
      action: RuleAction;
      condition: RuleCondition;
    }

    function getSessionRules(): Promise<SessionRule[]>;

    function updateSessionRules(options: {
      removeRuleIds?: number[];
      addRules?: Rule[];
    }): Promise<void>;
  }
}

// content 入口的全局哨兵（原 entry/entry-globals.d.ts 归并于此）：全局脚本
// 作用域直接与 lib.dom 的 Window 合并；var 声明供 globalThis.xxx 访问。
interface Window {
  __BOC_CONTENT_SCRIPT_LOADED__?: string;
  __BOC_CONTENT_BOOTSTRAP_STARTED__?: boolean;
}

var __BOC_CONTENT_SCRIPT_LOADED__: string | undefined;
var __BOC_CONTENT_BOOTSTRAP_STARTED__: boolean | undefined;
