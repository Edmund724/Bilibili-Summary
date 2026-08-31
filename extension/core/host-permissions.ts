// extension/core/host-permissions.ts
// 按需申请 host 权限的纯逻辑层（S2 收紧 host_permissions：通配符从常驻权限移入
// optional_host_permissions，AI/ASR 平台域名在保存时按 origin 申请）。与 DOM
// 解耦，chrome.permissions 一律经参数注入（默认值在调用时取全局实现），供
// options 页调用与单测驱动。
//
// 不变式：
// - baseUrl 必须是 http(s):// 开头的合法 URL（与 validators.ts 的
//   validateAiProviders 同型校验），origin 一律取 new URL(baseUrl).origin；
// - 交互式授权（chrome.permissions.request）必须落在用户手势的同步调用链上，
//   且一次手势只够一次弹窗：所有待申请 origin 合并成单次 request，request 之前
//   不得有先行 await，否则从第二个 origin 起会被 Chrome 以「缺少用户手势」拒绝；
// - 非法/空 baseUrl 不参与申请（格式问题由 validators 的输入校验负责报错）；
// - 探针/模型列表在发起 fetch 之前先 contains() 预检该 origin：未授权时跨域 fetch
//   只会以 CORS 失败（原样抛出是「Failed to fetch」这种看不出原因的文案），故直接
//   短路回可操作提示、不再发注定失败的请求；已授权时探针错误一律原样透传，权限
//   判定不得覆盖 HTTP 层错误（拿到 HTTP 状态说明请求已到达服务端）；
// - 删除 provider 时 origin 仍被任一存活 provider（AI 与 ASR 两组都要查）使用
//   则不回收；被删项自身按 id 剔除——钩子早于 DOM row.remove() 执行，不剔除就
//   永远判定「仍被占用」。

// 探针/权限缺失时的统一可操作文案（AI 探针、ASR 探针共享）
export const HOST_PERMISSION_HINT = "该平台域名未授权，请在保存时允许权限";

// 从 baseUrl 提取申请权限所需的 origin（https://host[:port]）。非法/边界
// 输入（空串、非 http(s) 协议、URL 解析失败）返回 null，由调用方跳过申请。
export function extractOriginFromBaseUrl(baseUrl: unknown): string | null {
  const text = String(baseUrl || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

// 一组 baseUrl → 去重后的 origin 列表（保持首次出现顺序，非法项丢弃）。
export function collectOrigins(baseUrls: unknown): string[] {
  const origins: string[] = [];
  for (const baseUrl of Array.isArray(baseUrls) ? baseUrls : []) {
    const origin = extractOriginFromBaseUrl(baseUrl);
    if (origin && !origins.includes(origin)) {
      origins.push(origin);
    }
  }
  return origins;
}

interface RequestResult {
  ok: boolean;
  origins: string[];
  error?: string;
}

// 单次批量申请一组 baseUrl 的 host 权限，返回 { ok, origins, error? }。
// requestPermissions 注入 chrome.permissions.request 本体（测试注入 mock）。
// 本函数在 await 之前不做任何异步等待，所以调用方（保存按钮的同步调用链）的
// 用户手势不会丢；待申请集合为空时连 request 都不发起，避免无谓弹窗。
export async function requestProviderOrigins(
  baseUrls: unknown,
  requestPermissions: typeof chrome.permissions.request | undefined = globalThis.chrome?.permissions?.request
): Promise<RequestResult> {
  const origins = collectOrigins(baseUrls);
  if (origins.length === 0) {
    return { ok: true, origins };
  }
  if (typeof requestPermissions !== "function") {
    return { ok: false, error: "当前环境不支持申请权限", origins };
  }
  let granted = false;
  try {
    granted = await requestPermissions({ origins });
  } catch (error) {
    return { ok: false, error: `申请域名权限失败：${(error as Error | undefined)?.message || error}`, origins };
  }
  if (!granted) {
    return {
      ok: false,
      error: `未授权 ${origins.join("、")}，保存已中止：请重新点击「保存设置」并在弹窗中选择允许`,
      origins
    };
  }
  return { ok: true, origins };
}

// 当前扩展是否已获该 URL（或 baseUrl）的 host 权限。拿不到 chrome.permissions
// 实现（单测、非扩展环境）或 URL 非法时按已授权处理，不阻塞既有请求路径。
export async function hasHostPermission(
  target: unknown,
  contains: typeof chrome.permissions.contains | undefined = globalThis.chrome?.permissions?.contains
): Promise<boolean> {
  const origin = extractOriginFromBaseUrl(target);
  if (!origin || typeof contains !== "function") {
    return true;
  }
  try {
    return Boolean(await contains({ origins: [origin] }));
  } catch {
    return true;
  }
}

interface ProviderLike {
  id?: string | number;
  baseUrl?: unknown;
}

// 删除平台时该 origin 是否已无主：origin 提取失败按无主处理（不回收），存活
// 列表（AI + ASR 两组拼接）中任何一项仍用同一 origin 就不回收。
// remainingProviders 必须是「不含被删项」的存活列表。
export function collectOrphanOrigins(deletedBaseUrl: unknown, remainingProviders: unknown): string[] {
  const origin = extractOriginFromBaseUrl(deletedBaseUrl);
  if (!origin) {
    return [];
  }
  const remaining = Array.isArray(remainingProviders) ? remainingProviders : [];
  const stillUsed = remaining.some((provider) => extractOriginFromBaseUrl((provider as ProviderLike)?.baseUrl) === origin);
  return stillUsed ? [] : [origin];
}

interface RevokeResult {
  origins: string[];
  revoked: boolean;
}

interface RevokeDependencies {
  contains?: typeof chrome.permissions.contains;
  remove?: typeof chrome.permissions.remove;
}

// 删除 provider 后回收其孤儿 origin。providers 是删除时刻从 DOM 收集的全量
// 平台列表（含尚未摘除的被删行），被删项在此按 id 剔除。
// 返回 { origins, revoked }：origins 非空且 revoked 为 false 即回收失败，由
// 调用方提示；权限本就不在（用户当初拒绝过）不算失败，返回空 origins。
export async function revokeOrphanOrigin(
  deleted: ProviderLike,
  providers: unknown,
  {
    contains = globalThis.chrome?.permissions?.contains,
    remove = globalThis.chrome?.permissions?.remove
  }: RevokeDependencies = {}
): Promise<RevokeResult> {
  const deletedId = String(deleted?.id || "");
  const survivors = (Array.isArray(providers) ? providers : []).filter(
    (provider) => String((provider as ProviderLike)?.id || "") !== deletedId
  );
  const origins = collectOrphanOrigins(deleted?.baseUrl, survivors);
  if (origins.length === 0) {
    return { origins, revoked: false };
  }
  if (typeof contains === "function") {
    try {
      if (!(await contains({ origins }))) {
        return { origins: [], revoked: false };
      }
    } catch {}
  }
  if (typeof remove !== "function") {
    return { origins, revoked: false };
  }
  try {
    return { origins, revoked: Boolean(await remove({ origins })) };
  } catch {
    return { origins, revoked: false };
  }
}

// 回收失败时的提示文案：删除已完成，只是权限残留，不影响使用
export const permissionRevokeErrorMessage = (origins: string[]): string =>
  `已删除平台，但回收域名权限失败（${origins.join("、")}），不影响使用，可到扩展详情页手动移除`;
