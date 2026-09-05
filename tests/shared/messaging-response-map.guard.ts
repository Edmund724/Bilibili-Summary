// 消息协议响应映射穷尽守卫（arch-slim-2/02，typecheck-only）：
// 文件名不含 .test.，vitest 不收集；tsc --noEmit 门禁执行本文件。
// 每条 ContentScriptMessage / BackgroundMessage 都必须经 ResponseOf 映射到
// 具体响应类型（shared/messaging-protocol.ts 的条件链）。新增消息漏配响应
// 条目时 UnmappedResponseMessages 非空，ExpectNever 处即报编译错误——
// 消息协议从「漏配静默退化为 unknown」变成 typecheck 门禁拦截。
import type {
  BackgroundMessage,
  ContentScriptMessage,
  ResponseOf
} from "../../extension/shared/messaging-protocol.js";

type ExpectNever<T extends never> = T;

// M 为裸类型参数：对消息 union 逐成员分发；未映射成员的 ResponseOf 解析为
// never，此时该成员原样浮出，否则吞为 never。
type UnmappedResponse<M> = M extends BackgroundMessage | ContentScriptMessage
  ? ResponseOf<M> extends never
    ? M
    : never
  : never;

type UnmappedResponseMessages = UnmappedResponse<BackgroundMessage | ContentScriptMessage>;

// 全部已映射时为 never（合法）；任一消息漏配响应类型，本行报
// 「Type '<消息名>' does not satisfy the constraint 'never'」。
export type EveryMessageHasResponseType = ExpectNever<UnmappedResponseMessages>;
