// extension/asr/audio-source.js
// 音频源获取：向 playurl 接口请求 DASH 音轨列表，选 bandwidth 最小的一条。
// 请求走页面同域能力（B 站页面调 api.bilibili.com 无跨域问题），复用
// gateway.js 的 contentFetchJson 传输通道（带登录 cookie 与 B 站请求头）。
// 本模块是纯被动能力：只在外部显式调用 getSourceAudioUrl 时发起请求。

import { contentFetchJson } from "../bilibili/gateway.js";

const NO_AUDIO_MESSAGE = "该视频没有可用音轨，无法语音识别";

// 从 playurl 返回的 data 里选 bandwidth 最小的一条音轨。
// 纯函数便于单测。返回 { url, backupUrls }，无音轨则抛指定文案错误。
export function selectAudioTrack(dashData) {
  const audio = dashData?.audio;
  if (!Array.isArray(audio) || audio.length === 0) {
    throw new Error(NO_AUDIO_MESSAGE);
  }
  let selected = audio[0];
  for (const track of audio) {
    const bandwidth = Number(track?.bandwidth) || 0;
    if (bandwidth < (Number(selected?.bandwidth) || 0)) {
      selected = track;
    }
  }
  return {
    url: selected?.baseUrl,
    backupUrls: Array.isArray(selected?.backupUrl) ? selected.backupUrl : []
  };
}

// 组装 playurl 请求地址。导出便于单测校验 URL 参数。
export function buildPlayurlUrl(bvid, cid) {
  return (
    "https://api.bilibili.com/x/player/playurl" +
    `?bvid=${encodeURIComponent(bvid)}` +
    `&cid=${encodeURIComponent(cid)}` +
    "&fnval=16" +
    "&platform=html5" +
    "&high_quality=1"
  );
}

// 获取视频 DASH 音轨地址：请求 playurl → 解析 data.dash.audio。
// transport 可注入（默认 contentFetchJson）便于测试；返回 { url, backupUrls }。
export async function getSourceAudioUrl({ bvid, cid }, transport = contentFetchJson) {
  const payload = await transport(buildPlayurlUrl(bvid, cid));
  if (payload?.code !== 0) {
    throw new Error(payload?.message || "无法获取音频流地址");
  }
  return selectAudioTrack(payload?.data?.dash);
}
