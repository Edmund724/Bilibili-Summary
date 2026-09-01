// extension/asr/chrome-asr-types.d.ts
// asr/ 迁移模块触达、共享 chrome-types.d.ts 未覆盖的 chrome API 表面：局部
// ambient 补充，经 namespace 声明合并生效（不修改共享声明文件）。保持最窄
// 契约，只声明本目录实际使用的成员。

declare namespace chrome {
  namespace runtime {
    // 页面直连 offscreen 文档的 asr-decode 端口（asr/offscreen-bridge.page.js）
    function connect(connectInfo: { name: string }): Port;
  }

  namespace offscreen {
    interface CreateDocumentOptions {
      url: string;
      reasons: string[];
      justification: string;
    }

    function createDocument(options: CreateDocumentOptions): Promise<void>;
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
