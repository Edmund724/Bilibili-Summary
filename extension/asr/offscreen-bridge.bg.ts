// ASR offscreen 通道的 background 侧执行器：offscreen 文档创建（prepare 时
// 确保文档存在）、防盗链 dnr 规则生命周期（id 池簿记、SW 冷启动对账、
// prepare 前死标签页残留回收、安装/更新整池清理——工单 04）、prepare/cleanup
// 任务 handler，以及 offscreen 文档自关闭请求的代执行（工单 03：offscreen 无
// chrome.offscreen，自关经 "offscreen-request-close" 消息委托本模块，发送者
// 校验 + 明确回成功/失败）。仅在 background service worker 环境加载
// （entry/background.js 注册到 offload-task 消息路由），顶层不触碰
// worker-only API——chrome.declarativeNetRequest / chrome.offscreen 只在
// handler 函数体内访问（保持既有习惯）。协议常量与契约注释唯一地址见
// asr/protocol.js。
// chrome.declarativeNetRequest / chrome.offscreen.createDocument 的最小表面
// 声明见本目录 chrome-asr-types.d.ts（共享 chrome-types.d.ts 未覆盖）。

import { OFFSCREEN_URL, OFFSCREEN_CREATE_REASON } from "../shared/offscreen-constants.js";
import type { MessageSender, SendResponse } from "../shared/messaging-protocol.js";

// 防盗链规则的目标域与来源页（工单 04：域名唯一事实源，代码与文档注释、
// manifest host_permissions、测试三处共用同一取值）：
// - 目标 host：无字幕 ASR 的音轨请求全部落在 playurl（api.bilibili.com）返回
//   的 data.dash.audio[].baseUrl/backupUrl 上，仓库内真实样本均为
//   bilivideo.com 的子域（upx.bilivideo.com / upos-sz-mirror08.bilivideo.com，
//   见 tests/asr/audio-source.test.js 与 eval/ 音频夹具）。规则条件用
//   requestDomains 精确匹配该域及其子域（比 "||bilivideo.com" 的 urlFilter
//   收窄：不会误命中 "bilivideo.com.evil.com" 这类拼接域）。
// - 来源页：offscreen 文档（扩展自身 context）fetch 音轨；Referer/Origin 伪
//   装成 B 站视频页以过 CDN 防盗链。规则 resourceTypes 仅 xmlhttprequest。
// - 海外镜像域（如 upos-hz-mirrorakam.akamaized.net）在仓库代码链与夹具中
//   零证据，不声明权限、不写规则（最窄原则）；若未来 playurl 返回该域导致
//   403，属真实浏览器验收（工单 06）的观察项。
export const ASR_AUDIO_CDN_DOMAIN = "bilivideo.com" as const;
export const ASR_AUDIO_ORIGIN_PAGE = "https://www.bilibili.com" as const;

// 防盗链会话规则 id 池下界：id 按任务独立分配（一个任务一条规则，多任务
// 并发时规则并存、cleanup 只删自己的），自此单调递增；任务结束归还空闲池
// 复用，防止长会话 id 无限增长。上界之外的活跃任务按错误路径上报。
export const ASR_AUDIO_SESSION_RULE_ID_BASE: number = 32001;
const ASR_AUDIO_SESSION_RULE_ID_MAX: number = 32100;

// 防盗链规则 id 分配器（模块级，仅 background 执行器触碰）：prepare 分配、
// cleanup 归还。单调计数器 + 空闲池复用，防止长会话 id 无限增长；活跃集
// 记账保证重复/未知 id 的 cleanup 幂等忽略、不污染池状态。账本随 SW 实例
// 生灭而会话规则生命周期更长，冷启动后首次分配前按平台对账重建（见下）。
// Map 值 = 任务来源（taskOwnerKey，工单 03 的标签页归属簿记）：cleanup 只
// 接受同一来源的清理请求；对账收编的上一实例残留 id 值为 ""（来源未知），
// cleanup 保持幂等放行。
let nextSessionRuleId: number = ASR_AUDIO_SESSION_RULE_ID_BASE;
const activeSessionRuleIds = new Map<number, string>();
const freeSessionRuleIds: number[] = [];

function allocateSessionRuleId(owner: string): number {
  let ruleId = freeSessionRuleIds.pop();
  if (ruleId === undefined) {
    if (nextSessionRuleId > ASR_AUDIO_SESSION_RULE_ID_MAX) {
      throw new Error("防盗链规则 id 已耗尽（活跃转写任务过多），请稍后重试");
    }
    ruleId = nextSessionRuleId++;
  }
  activeSessionRuleIds.set(ruleId, owner);
  return ruleId;
}

function releaseSessionRuleId(ruleId: number): void {
  const id = Number(ruleId) || 0;
  // 活跃集守卫：未分配/已归还的 id（重复 cleanup、陈旧 id）不动池状态
  if (!activeSessionRuleIds.delete(id)) {
    return;
  }
  freeSessionRuleIds.push(id);
}

// SW 冷启动对账：账本随 SW 实例生灭，而会话规则生命周期是整个浏览器会话。
// SW 被杀重启后计数器归零，平台上却可能还留着上一实例的规则——此时同一 id
// 会被再次分配：新任务 addDownloadRules 先删后加把旧规则覆写成新内容，旧
// 任务（offscreen 文档可跨 SW 存活）跑完的 cleanup 再把新任务正依赖的规则
// 删掉，音轨请求丢 Referer/Origin 被 bilivideo CDN 403（「音频转写失败」）。
// 故首次分配前以平台为事实源对账一次：区间内已有规则一律收进活跃集（无法
// 区分是否上一实例崩溃遗留的死规则，宁可让 id 缓慢向耗尽漂移也不复用可能
// 正被依赖的 id）、计数器越过平台最大 id、空闲池清空（池只服务本实例内
// 借还，跨实例回收由对账按平台事实源完成）。
let sessionRuleIdsReconcilePromise: Promise<void> | null = null;

function ensureSessionRuleIdsReconciled(): Promise<void> {
  if (!sessionRuleIdsReconcilePromise) {
    sessionRuleIdsReconcilePromise = reconcileSessionRuleIds().catch((error) => {
      // 失败不缓存且账本分文未动（赋值在查询成功后一次完成）：下次 prepare
      // 重试对账；错误原样抛出，沿 prepare 既有错误路径上报，不吞错也不
      // 静默降级为带撞车风险的裸分配。
      sessionRuleIdsReconcilePromise = null;
      throw error;
    });
  }
  return sessionRuleIdsReconcilePromise;
}

// offscreen 文档列表项的最小形状（self.clients 在 ServiceWorkerGlobalScope
// 上，DOM lib 的 self 未覆盖，访问处按此断言）
type ServiceWorkerScopeLike = {
  clients: {
    matchAll(options: { includeUncontrolled: boolean }): Promise<Array<{ url?: string }>>;
  };
};

async function reconcileSessionRuleIds(): Promise<void> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  let maxSessionRuleId = ASR_AUDIO_SESSION_RULE_ID_BASE - 1;
  for (const rule of rules) {
    const id = Number(rule?.id) || 0;
    // 只收本池区间内的 id，区间外规则不误入账本；来源未知（""）→ cleanup 放行
    if (id >= ASR_AUDIO_SESSION_RULE_ID_BASE && id <= ASR_AUDIO_SESSION_RULE_ID_MAX) {
      activeSessionRuleIds.set(id, "");
      if (id > maxSessionRuleId) {
        maxSessionRuleId = id;
      }
    }
  }
  nextSessionRuleId = Math.max(ASR_AUDIO_SESSION_RULE_ID_BASE, maxSessionRuleId + 1);
  freeSessionRuleIds.length = 0;
}

// ===== 泄漏回收（工单 04：异常取消 / 后台终止路径的规则回收） =====

// cleanup 消息依赖页面侧活着（port 断连后 finish 才发 cleanup）；页面标签页
// 直接关闭 / 崩溃时 cleanup 永远不会到达，规则会泄漏到浏览器会话结束。兜底：
// 每次 prepare 前把「归属标签页已不存在」的活跃规则回收掉（owner 键为
// "t<tabId>" 的才可核验；offscreen / 对账收编的来源无法核验，保守保留）。
// SW 被杀重启后残留规则已被对账收编进活跃集，同样受益于本回收。
async function reapOrphanedSessionRules(): Promise<void> {
  if (activeSessionRuleIds.size === 0) {
    return;
  }
  const deadIds: number[] = [];
  for (const [id, owner] of activeSessionRuleIds) {
    if (!owner.startsWith("t")) {
      continue;
    }
    if (!(await isTabAlive(Number(owner.slice(1)) || 0))) {
      deadIds.push(id);
    }
  }
  for (const id of deadIds) {
    await removeDownloadRules(id);
    releaseSessionRuleId(id);
  }
}

// 标签页是否仍存活：只把 Chrome 对已关闭标签页的确定性错误
//（"No tab with id: N."）判为死亡；API 缺失（测试 stub / 非扩展环境）或其他
// 异常一律按存活处理——回收是防泄漏兜底，宁可漏收也不可误收正被依赖的规则。
async function isTabAlive(tabId: number): Promise<boolean> {
  if (!(tabId > 0)) {
    return false;
  }
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (error) {
    const message = String((error as { message?: string } | null)?.message || error);
    return !/no tab with id/i.test(message);
  }
}

// 安装 / 更新路径的整池清理（entry/background.ts 的 onInstalled 接线，逻辑
// 实现收在本模块）：把池区间内平台上现存的全部会话规则清掉，并重置账本——
// 之后首次 prepare 经 ensureSessionRuleIdsReconciled 以平台事实源重建。
// 会话规则跨浏览器重启与扩展更新由平台自动清空，本函数是防御性兜底（行为
// 随 Chrome 版本有差异的路径不依赖平台语义）；删除不存在的 id 由 Chrome 忽略。
export async function reapAllSessionRules(): Promise<void> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = rules
    .map((rule) => Number(rule?.id) || 0)
    .filter((id) => id >= ASR_AUDIO_SESSION_RULE_ID_BASE && id <= ASR_AUDIO_SESSION_RULE_ID_MAX);
  if (removeRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
  }
  // 账本整体重置（对账缓存一并作废，下次 prepare 重新按平台对账）
  nextSessionRuleId = ASR_AUDIO_SESSION_RULE_ID_BASE;
  activeSessionRuleIds.clear();
  freeSessionRuleIds.length = 0;
  sessionRuleIdsReconcilePromise = null;
}

// 任务准备：创建（或复用）offscreen 文档 + 分配一个独立 id 并按它加防盗链
// 下载规则。页面侧连 "asr-decode" 端口前调用，保证文档与规则就绪；ruleId
// 随响应带回，页面侧 cleanup 时原样带回，只删自己这条。
export async function handleAsrDecodePrepare(message: unknown, sender: MessageSender, sendResponse: SendResponse): Promise<void> {
  let ruleId = 0;
  try {
    // 首次分配前对账一次（实例内幂等缓存），避免与上一 SW 实例残留的会话
    // 规则撞 id；对账失败照下方 catch 的既有错误路径上报。
    await ensureSessionRuleIdsReconciled();
    // 泄漏兜底：回收归属标签页已关闭的残留规则（cleanup 消息随页面死亡
    // 丢失的异常取消 / 后台终止路径，见 reapOrphanedSessionRules 注释）。
    await reapOrphanedSessionRules();
    ruleId = allocateSessionRuleId(taskOwnerKey(sender));
    await ensureAsrOffscreenDocument();
    await addDownloadRules(ruleId);
    sendResponse({ ok: true, ruleId });
  } catch (error) {
    // updateSessionRules 失败照既有错误路径上报不吞；该 id 未成功占用
    // （updateSessionRules 原子生效），归还空闲池避免失败一次泄漏一个 id。
    if (ruleId) {
      releaseSessionRuleId(ruleId);
    }
    sendResponse({ ok: false, error: String((error as { message?: string })?.message || error) });
  }
}

// 任务收尾：删掉本次解码任务自己的防盗链规则（成功失败都要调，页面侧用
// try/finally 或 .finally 兜底）。只删消息携带的 ruleId，不影响并发任务
// 的规则；删除不存在的 id 由 Chrome 忽略，重复/未知 id 的 cleanup 幂等不抛。
// 持久化决策（工单 04）：规则配置不写入 storage——会话规则的平台副本
// （getSessionRules）就是可恢复事实源，SW 重启后 prepare 首次分配前按其对账
// 重建账本（ensureSessionRuleIdsReconciled），storage 副本只会引入与平台的
// 一致性负担；页面侧 cleanup 丢失（标签页关闭/崩溃）的泄漏由 prepare 前的
// 死标签页回收兜底（reapOrphanedSessionRules）。
// 标签页归属校验（工单 03）：ruleId 在本实例簿记中有主时，只接受同一来源的
// cleanup——跨标签页/跨上下文的删除请求回 { ok:false } 且不删规则。簿记不在
// （SW 冷启动后上一实例的 ruleId：账本对账只收活跃集、无法区分原属）时保持
// 幂等放行，与冷启动对账语义一致。
export async function handleAsrDecodeCleanup(message: unknown, sender: MessageSender, sendResponse: SendResponse): Promise<void> {
  try {
    const ruleId = Number((message as { ruleId?: number } | null)?.ruleId) || 0;
    if (ruleId > 0) {
      // 标签页归属（工单 03）：ruleId 在本实例簿记中有主时只接受同一来源的
      // cleanup——跨标签页/跨上下文的删除请求回 { ok:false } 且不删规则。
      // 簿记为 ""（SW 冷启动对账收编的上一实例残留 id）时幂等放行。
      const owner = activeSessionRuleIds.get(ruleId);
      if (owner && owner !== taskOwnerKey(sender)) {
        sendResponse({ ok: false, error: "防盗链规则不属于当前来源" });
        return;
      }
      await removeDownloadRules(ruleId);
      releaseSessionRuleId(ruleId);
    }
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: String((error as { message?: string })?.message || error) });
  }
}

// ===== offscreen 文档自关闭的 SW 代执行（工单 03） =====

// offscreen 文档没有 chrome.offscreen（平台只开放 chrome.runtime），任务终态
// 后的自关闭经 "offscreen-request-close" 消息委托本执行器：校验发送者确为
// offscreen 文档（sender.url 精确等于文档 URL 且无 sender.tab），执行
// chrome.offscreen.closeDocument 并明确回成功/失败。
export async function handleOffscreenRequestClose(_message: unknown, sender: MessageSender, sendResponse: SendResponse): Promise<void> {
  if (!isOffscreenDocumentSender(sender)) {
    sendResponse({ ok: false, error: "仅接受 offscreen 文档发送" });
    return;
  }
  try {
    await chrome.offscreen.closeDocument();
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: String((error as { message?: string })?.message || error) });
  }
}

// 发送者是否为 offscreen 文档本身（入口守卫与关闭执行器共用同一判定）。
export function isOffscreenDocumentSender(sender: MessageSender): boolean {
  return !sender?.tab && sender?.url === chrome.runtime.getURL(OFFSCREEN_URL);
}

// 任务来源键：有 sender.tab 的来源（content script）按标签页记账（"t<id>"），
// 无 tab（offscreen 文档 / 未知上下文）统一记 "o"。
function taskOwnerKey(sender: MessageSender): string {
  const tabId = sender?.tab?.id;
  return tabId != null ? "t" + String(tabId) : "o";
}

// 有活跃文档就复用，没有则创建一个（offscreen 文档常驻 sidepanel 创建的
// "offscreen-chat" 实例，新端口与之并存互不干扰）。创建失败不再吞掉（工单
// 03）：matchAll 探测失败降级为直接尝试创建；createDocument 的原始错误向上
// 抛，沿 prepare 的 catch 回 { ok:false, error } 进入页面侧可读错误处理——
// 只有「文档已存在」（探测降级路径下的并发创建竞态）视同成功。
async function ensureAsrOffscreenDocument(): Promise<void> {
  let hasDoc = false;
  try {
    // 注意：SW 标准全局是 self.clients（ServiceWorkerGlobalScope.clients），
    // 没有 chrome.clients 这个命名空间。
    const clients = await (self as unknown as ServiceWorkerScopeLike).clients.matchAll({ includeUncontrolled: true });
    hasDoc = clients.some((client) => client.url?.includes(OFFSCREEN_URL));
  } catch {
    // 探测失败不阻塞创建尝试：createDocument 的 already-exists 兜底
    hasDoc = false;
  }
  if (hasDoc) {
    return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_URL),
      // 不用 AUDIO_PLAYBACK：Chrome 对无真实播放的 AUDIO_PLAYBACK 文档
      // 30 秒强制关闭（长视频解码 >30s 会「音频解码中断」）；本文档实际
      // 是解码 + 转写（WAV Blob 仅在本 context 内经 FormData 上传），
      // BLOBS 不受该限制。取值统一收拢在 shared/offscreen-constants.js
      //（与 sidepanel 聊天自愈的创建方共用同一 reason）。
      reasons: [OFFSCREEN_CREATE_REASON],
      justification: "Download, decode, slice and transcribe video audio for ASR subtitles."
    });
  } catch (error) {
    if (OFFSCREEN_ALREADY_EXISTS_RE.test(String((error as { message?: string })?.message || error))) {
      return;
    }
    throw error;
  }
}

// Chrome createDocument 的「offscreen 文档已存在」错误判定（探测降级路径下
// 的并发创建竞态用）：真实文案是 "Only a single offscreen document may be
// created."（r1 审查核实，不含 "already exist"）；正则同时兼容 "already
// exist" 变体与 "single offscreen"，不放宽到任意错误。
const OFFSCREEN_ALREADY_EXISTS_RE = /already exist|single offscreen/i;

// ===== 防盗链下载规则（dnr 为 MV3 专属 API，仅 background 可用） =====

// 为单个解码任务添加 Referer/Origin 会话规则（offscreen 文档 fetch 音轨时
// 绕防盗链；规则内容与旧固定 id 版本一致，仅 id 按任务独立）。保留先删后加
// 的幂等：同 id 已有规则时覆盖写为新内容，而非因 id 已存在而报错。
// 作用范围（工单 04 收窄）：requestDomains 精确匹配 ASR 音频 CDN 域
// （ASR_AUDIO_CDN_DOMAIN 及其子域）+ 仅 xmlhttprequest——规则只改写 offscreen
// 文档对 playurl 返回音轨地址的 fetch 的 Referer/Origin，不触碰浏览器其他流量。
export async function addDownloadRules(ruleId: number): Promise<void> {
  const id = Number(ruleId) || 0;
  if (id <= 0) {
    throw new Error("缺少防盗链规则 id");
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: ASR_AUDIO_ORIGIN_PAGE },
            { header: "Origin", operation: "set", value: ASR_AUDIO_ORIGIN_PAGE }
          ]
        },
        condition: {
          requestDomains: [ASR_AUDIO_CDN_DOMAIN],
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ]
  });
}

// 清掉指定任务 id 的规则（updateSessionRules 同时支持移除与添加）
export async function removeDownloadRules(ruleId: number): Promise<void> {
  const id = Number(ruleId) || 0;
  if (id <= 0) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id]
  });
}
