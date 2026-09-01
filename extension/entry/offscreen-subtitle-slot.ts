// offscreen-subtitle-slot.ts — offscreen 聊天字幕体的「单槽缓存」纯逻辑
//（候选5：追问不重传字幕体）。
//
// 为什么存在：SP 侧每条追问消息原本都经 port 全量重发 context（含整份
// subtitleBody，长视频可达数 MB/条）。瘦身后 SP 只在 lastAckedContextKey
// 变化时携带字幕体，offscreen 用单槽缓存补齐后续消息；槽随文档生灭——
// 文档被回收后槽为空，SP 会先收到 port 断连重置 lastAcked；槽 key 与消息
// contextKey 不匹配时（文档重启后 SP 未断连的时序缝隙）回「字幕体缺失」
// 错误让 SP 重发全文，不做跨 key 猜测式兜底——宁可一次显式失败，不把上一个
// 视频的字幕体接进当前追问。
//
// 纯逻辑放独立模块：entry/offscreen.ts 顶层挂满 chrome 事件监听，不可在
// Node 测试环境导入（与 offscreen-lifecycle.ts 同一套拆分手法，可测）。

export interface SubtitleBodyItem {
  from: number;
  to: number;
  content: string;
}

export type SubtitleBody = SubtitleBodyItem[];

export interface ChatMessage {
  context?: Record<string, unknown>;
  contextKey?: string;
  [key: string]: unknown;
}

export interface SettleOk {
  ok: true;
  contextKey: string;
}

export interface SettleError {
  ok: false;
  error: string;
  code: string;
}

export type SettleResult = SettleOk | SettleError;

// 槽缺失/不匹配时回给 SP 的错误文案与类型化 code：SP 侧据 code 重置
// lastAckedContextKey（下一条消息重发全文），文案仅用于展示。
export const SUBTITLE_BODY_MISSING_MESSAGE = "字幕体缺失，请重发一次";
export const SUBTITLE_BODY_MISSING_CODE = "subtitle-body-missing";

interface Slot {
  contextKey: string;
  subtitleBody: SubtitleBody;
}

/**
 * 创建单槽缓存。槽结构 { contextKey, subtitleBody }，同一文档只保留最近一份。
 * settle(msg) 处理一条 chat 消息的字幕体，返回：
 *   - { ok: true, contextKey }：字幕体已就绪（消息自带 → 顺带覆盖槽；
 *     消息未带 → 已从槽补写进 msg.context.subtitleBody）。
 *   - { ok: false, error, code }：槽缺失或 key 不匹配，调用方应原样回错误。
 */
export function createSubtitleBodySlot(): { settle(msg: ChatMessage): SettleResult } {
  let slot: Slot | null = null;

  function settle(msg: ChatMessage): SettleResult {
    const context = msg?.context && typeof msg.context === "object" ? msg.context : null;
    if (!context) {
      return { ok: false, error: SUBTITLE_BODY_MISSING_MESSAGE, code: SUBTITLE_BODY_MISSING_CODE };
    }
    const contextKey = String(msg.contextKey || "");

    // 消息自带字幕体（SP 侧 lastAcked 未命中时的全量路径）→ 覆盖槽。
    // 用 !== undefined 判"是否携带"而非 Array.isArray：空数组也是有效携带，
    // 非视频上下文的 subtitleBody: [] 同样需要走一遍槽登记。
    if (context.subtitleBody !== undefined) {
      slot = { contextKey, subtitleBody: context.subtitleBody as SubtitleBody };
      return { ok: true, contextKey };
    }

    // 未携带 → 从槽补齐。key 必须精确匹配且槽体是数组：不匹配说明 SP 侧的
    // lastAcked 指向的槽已不存在（文档重启）或已被其他上下文覆盖，一律报缺失。
    if (
      slot &&
      slot.contextKey === contextKey &&
      Array.isArray(slot.subtitleBody)
    ) {
      context.subtitleBody = slot.subtitleBody;
      return { ok: true, contextKey };
    }
    return { ok: false, error: SUBTITLE_BODY_MISSING_MESSAGE, code: SUBTITLE_BODY_MISSING_CODE };
  }

  return { settle };
}
