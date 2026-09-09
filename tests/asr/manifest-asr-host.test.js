// 工单 04：无字幕 ASR 流程的最窄 host 权限声明。
//
// 真实音频请求链（代码唯一事实源）：runAsrPipeline → getSourceAudioUrl
// （playurl，api.bilibili.com，已有权限）→ data.dash.audio[].baseUrl/backupUrl
// → offscreen 文档 fetch 音轨。仓库内全部真实样本 URL 均为 bilivideo.com 的
// 子域（upx.bilivideo.com / upos-sz-mirror08.bilivideo.com，见
// tests/asr/audio-source.test.js 与 eval/ 音频夹具），故 manifest 只为此流程
// 增补 https://*.bilivideo.com/*；不声明宽泛 <all_urls>。DNR 防盗链规则
// （asr/offscreen-bridge.bg.ts addDownloadRules）的 requestDomains 与本断言
// 的域保持同源（ASR_AUDIO_CDN_DOMAIN = "bilivideo.com"）。
//
// 海外镜像域（如 upos-hz-mirrorakam.akamaized.net）在仓库代码链与夹具中零
// 证据：不声明权限、不写规则；真实浏览器验收（工单 06）观察项。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// vitest 固定从仓库根启动（package.json scripts），manifest 以仓库根相对路径读取
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));

describe("manifest：ASR 音频 CDN 的最窄 host 权限（工单 04）", () => {
  it("host_permissions 包含音频 CDN 域 https://*.bilivideo.com/*", () => {
    expect(manifest.host_permissions).toContain("https://*.bilivideo.com/*");
  });

  it("不以宽泛 <all_urls> 作为常驻 host 权限", () => {
    expect(manifest.host_permissions).not.toContain("<all_urls>");
  });

  it("DNR 会话规则所需权限 declarativeNetRequest 已声明", () => {
    expect(manifest.permissions).toContain("declarativeNetRequest");
  });

  it("B 站站内域不在本次改动中放宽（保持既有最窄集合）", () => {
    expect(manifest.host_permissions).toEqual([
      "https://www.bilibili.com/*",
      "https://api.bilibili.com/*",
      "https://*.hdslb.com/*",
      "https://*.bilivideo.com/*"
    ]);
  });
});
