// ASR offscreen 通道的 background 侧执行器：offscreen 文档创建（prepare 时
// 确保文档存在）、防盗链 dnr 规则 id 池簿记、prepare/cleanup 任务 handler。
// 仅在 background service worker 环境加载（entry/background.js 注册到
// offload-task 消息路由），顶层不触碰 worker-only API——chrome.declarativeNetRequest /
// chrome.offscreen 只在 handler 函数体内访问（保持既有习惯）。协议常量与
// 契约注释唯一地址见 asr/protocol.js。

import { OFFSCREEN_URL, OFFSCREEN_CREATE_REASON } from "../shared/offscreen-constants.js";

// 防盗链会话规则 id 池下界：id 按任务独立分配（一个任务一条规则，多任务
// 并发时规则并存、cleanup 只删自己的），自此单调递增；任务结束归还空闲池
// 复用，防止长会话 id 无限增长。上界之外的活跃任务按错误路径上报。
export const ASR_AUDIO_SESSION_RULE_ID_BASE = 32001;
const ASR_AUDIO_SESSION_RULE_ID_MAX = 32100;

// 防盗链规则 id 分配器（模块级，仅 background 执行器触碰）：prepare 分配、
// cleanup 归还。单调计数器 + 空闲池复用，防止长会话 id 无限增长；活跃集
// 记账保证重复/未知 id 的 cleanup 幂等忽略、不污染池状态。账本随 SW 实例
// 生灭而会话规则生命周期更长，冷启动后首次分配前按平台对账重建（见下）。
let nextSessionRuleId = ASR_AUDIO_SESSION_RULE_ID_BASE;
const activeSessionRuleIds = new Set();
const freeSessionRuleIds = [];

function allocateSessionRuleId() {
  let ruleId = freeSessionRuleIds.pop();
  if (ruleId === undefined) {
    if (nextSessionRuleId > ASR_AUDIO_SESSION_RULE_ID_MAX) {
      throw new Error("防盗链规则 id 已耗尽（活跃转写任务过多），请稍后重试");
    }
    ruleId = nextSessionRuleId++;
  }
  activeSessionRuleIds.add(ruleId);
  return ruleId;
}

function releaseSessionRuleId(ruleId) {
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
let sessionRuleIdsReconcilePromise = null;

function ensureSessionRuleIdsReconciled() {
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

async function reconcileSessionRuleIds() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  let maxSessionRuleId = ASR_AUDIO_SESSION_RULE_ID_BASE - 1;
  for (const rule of rules) {
    const id = Number(rule?.id) || 0;
    // 只收本池区间内的 id，区间外规则不误入账本
    if (id >= ASR_AUDIO_SESSION_RULE_ID_BASE && id <= ASR_AUDIO_SESSION_RULE_ID_MAX) {
      activeSessionRuleIds.add(id);
      if (id > maxSessionRuleId) {
        maxSessionRuleId = id;
      }
    }
  }
  nextSessionRuleId = Math.max(ASR_AUDIO_SESSION_RULE_ID_BASE, maxSessionRuleId + 1);
  freeSessionRuleIds.length = 0;
}

// 任务准备：创建（或复用）offscreen 文档 + 分配一个独立 id 并按它加防盗链
// 下载规则。页面侧连 "asr-decode" 端口前调用，保证文档与规则就绪；ruleId
// 随响应带回，页面侧 cleanup 时原样带回，只删自己这条。
export async function handleAsrDecodePrepare(message, sender, sendResponse) {
  let ruleId = 0;
  try {
    // 首次分配前对账一次（实例内幂等缓存），避免与上一 SW 实例残留的会话
    // 规则撞 id；对账失败照下方 catch 的既有错误路径上报。
    await ensureSessionRuleIdsReconciled();
    ruleId = allocateSessionRuleId();
    await ensureAsrOffscreenDocument();
    await addDownloadRules(ruleId);
    sendResponse({ ok: true, ruleId });
  } catch (error) {
    // updateSessionRules 失败照既有错误路径上报不吞；该 id 未成功占用
    // （updateSessionRules 原子生效），归还空闲池避免失败一次泄漏一个 id。
    if (ruleId) {
      releaseSessionRuleId(ruleId);
    }
    sendResponse({ ok: false, error: String(error?.message || error) });
  }
}

// 任务收尾：删掉本次解码任务自己的防盗链规则（成功失败都要调，页面侧用
// try/finally 或 .finally 兜底）。只删消息携带的 ruleId，不影响并发任务
// 的规则；删除不存在的 id 由 Chrome 忽略，重复/未知 id 的 cleanup 幂等不抛。
// 会话规则随浏览器重启自动清空，无需持久化。
export async function handleAsrDecodeCleanup(message, sender, sendResponse) {
  try {
    const ruleId = Number(message?.ruleId) || 0;
    if (ruleId > 0) {
      await removeDownloadRules(ruleId);
      releaseSessionRuleId(ruleId);
    }
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: String(error?.message || error) });
  }
}

// 有活跃文档就复用，没有则创建一个（offscreen 文档常驻 sidepanel 创建的
// "offscreen-chat" 实例，新端口与之并存互不干扰）。
async function ensureAsrOffscreenDocument() {
  try {
    // 注意：SW 标准全局是 self.clients（ServiceWorkerGlobalScope.clients），
    // 没有 chrome.clients 这个命名空间。曾误用 chrome.clients 导致 TypeError
    // 被外层 catch 吞掉、无文档时从不创建 offscreen 文档，页面侧 asr-decode
    // 端口因找不到接收端 ~2ms 断连（「音频解码中断：后台连接已断开」）。
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    const hasDoc = clients.some((client) => client.url?.includes(OFFSCREEN_URL));
    if (!hasDoc) {
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
    }
  } catch {
    // 已有文档或创建失败：直接尝试连接，由连接结果兜底
  }
  return true;
}

// ===== 防盗链下载规则（dnr 为 MV3 专属 API，仅 background 可用） =====

// 为单个解码任务添加 Referer/Origin 会话规则（offscreen 文档 fetch 音轨时
// 绕防盗链；规则内容与旧固定 id 版本一致，仅 id 按任务独立）。保留先删后加
// 的幂等：同 id 已有规则时覆盖写为新内容，而非因 id 已存在而报错。
export async function addDownloadRules(ruleId) {
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
            { header: "Referer", operation: "set", value: "https://www.bilibili.com" },
            { header: "Origin", operation: "set", value: "https://www.bilibili.com" }
          ]
        },
        condition: {
          urlFilter: "||bilivideo.com",
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ]
  });
}

// 清掉指定任务 id 的规则（updateSessionRules 同时支持移除与添加）
export async function removeDownloadRules(ruleId) {
  const id = Number(ruleId) || 0;
  if (id <= 0) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id]
  });
}
