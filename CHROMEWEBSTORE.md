# Chrome Web Store Listing — Bilibili-Summary｜一键总结B站视频

> Last Updated: 2026-09-09
>
> Status: Draft. Do not submit until tickets #01 through #06 are complete, the real Chrome checks pass, and the 2.1.0 release archive is rebuilt.

## Store Listing

**Extension Name**: Bilibili-Summary｜一键总结B站视频

**Short Description**: 在 B 站视频页读取带时间戳字幕，生成摘要、对话内容和可跳转笔记。

**Detailed Description**:

Bilibili-Summary 在 B 站视频页右侧打开 Digest 阅读面板，让你一边看视频，一边读取逐句字幕、章节和 AI 摘要。点击视频播放器下方的 Digest 即可开始阅读。

你可以按时间跳转字幕，搜索当前句，复制或下载 Markdown、SRT 和 TXT；也可以保存带时间戳的笔记。概览会整理章节、重点引用和完整笔记。AI 对话能围绕当前视频追问，并使用你配置的模型；选中字幕后，可以继续请求讲解、翻译或润色。

视频没有字幕轨时，语音识别回退可以把音频转成带时间戳的字幕。只有开启无字幕回退且当前视频确实没有字幕时，扩展才会抓取音频。

API Key 由你自己配置。扩展直接连接你选择的 AI 和语音识别服务，不经过本项目开发者。

需要帮助或报告问题，请访问 https://github.com/Edmund724/Bilibili-Summary/issues。

**Category**: Productivity

**Single Purpose**: 在 B 站视频页内整理可跳转字幕、摘要和笔记。

**Primary Language**: 简体中文

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|---|---|---|---|
| Store Icon | 128x128 PNG | Ready | `extension/icons/icon128.png` |
| Screenshot 1 | 1280x800 or 640x400 | Needs update | `docs/images/demo-subtitle.png` |
| Screenshot 2 | 1280x800 or 640x400 | Needs update | `docs/images/demo-overview.png` |
| Screenshot 3 | 1280x800 or 640x400 | Needs update | `docs/images/demo-ai-chat.png` |
| Screenshot 4 | 1280x800 or 640x400 | Not created | |
| Screenshot 5 | 1280x800 or 640x400 | Not created | |
| Small Promo Tile | 440x280 | Not created | |
| Marquee Promo Tile | 1400x560 | Not created | |

### Screenshot Notes

Refresh the screenshots after the toolbar entry and compatibility fixes are complete. The first screenshot should show the timestamped subtitle list next to an active video. The second should show the overview with chapter navigation, and the third should show a real AI answer without exposing an API Key or private conversation.

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `storage` | permissions | Save API keys, notes, conversations, subtitles, summaries, settings, and cache entries. |
| `unlimitedStorage` | permissions | Keep the user-specified local subtitle and summary cache from failing when Chrome evicts data under the normal storage quota. |
| `scripting` | permissions | Run the reading interface and player controls on supported Bilibili video pages. |
| `tabs` | permissions | Identify the active Bilibili tab, keep the reading interface attached to the correct video, synchronize playback state, and pass that tab to the audio pipeline. |
| `offscreen` | permissions | Decode audio and process AI or ASR streams in a background document while the user continues browsing the video page. |
| `declarativeNetRequest` | permissions | Add short-lived request headers for Bilibili audio during an active speech-recognition task, then remove those rules when the task finishes. |
| `https://www.bilibili.com/*` | host_permissions | Read supported video and watch-later pages so the extension can add the Digest button and reading interface. |
| `https://api.bilibili.com/*` | host_permissions | Fetch video metadata and subtitle data while the user is reading or summarizing a Bilibili video. |
| `https://*.hdslb.com/*` | host_permissions | Fetch subtitle assets and Bilibili-hosted audio for the speech-recognition fallback. |
| `http://*/*`, `https://*/*` | optional_host_permissions | Connect to an AI or speech-recognition endpoint that the user explicitly adds, including a local Whisper service. Chrome may request this access when the user saves a matching provider. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?**: Yes. Data is processed to provide the video reading, note, AI, and speech-recognition features. The project developer does not operate an account system or receive this data.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|---|---|---|---|---|
| Personally identifiable info | No | No | Not required. | No |
| Health info | No | No | Not required. | No |
| Financial info | No | No | Not required. | No |
| Authentication info | Yes, user-provided API keys | Yes, to the provider selected by the user | Authenticate the user's chosen AI or speech-recognition provider. | Only with that selected provider |
| Personal communications | Yes, AI conversation text when the user uses chat | Yes, to the selected AI provider | Answer questions about the current video. | Only with that selected provider |
| Location | No | No | Not required. | No |
| Web history | No | No | The extension reads only the active supported Bilibili video and the watch-later page. | No |
| User activity | Yes | Yes, when a user requests AI analysis or speech recognition | Store notes and settings, and provide requested analysis or speech recognition. | Only with the selected AI or speech-recognition provider |
| Website content | Yes, current video metadata, subtitles, selected text, comments used for analysis, and audio only when speech-recognition fallback is enabled | Yes, based on the user's requested feature and provider settings | Create summaries, explanations, translations, notes, conversations, and timestamped speech-to-text results. | Bilibili requests go directly between the user's browser and Bilibili; feature content is sent only to the selected provider |

### Data Use Certification

- [x] Data is not sold to third parties.
- [x] Data is not used for creditworthiness or lending purposes.
- [x] Data is not used for advertising, analytics, behavior tracking, or any purpose unrelated to the core features.

## Privacy Policy

**Privacy Policy URL**: https://github.com/Edmund724/Bilibili-Summary/blob/main/PRIVACY.md

The policy and the store disclosure must be checked together before submission. `chrome.storage.sync` sends non-sensitive settings through the user's Chrome account. API keys, notes, conversations, and caches remain in `chrome.storage.local`.

## Distribution

**Visibility**: Public

**Regions**: All regions

## Developer Info

**Publisher Name**: [Required before submission and must match the Google Play publisher account]

**Contact Email**: [Required before submission; use a monitored public support address]

**Support URL / Email**: https://github.com/Edmund724/Bilibili-Summary/issues

**Homepage URL**: https://github.com/Edmund724/Bilibili-Summary#readme

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 2.1.0 | 2026-09-09 | Chrome 120 baseline, one Digest entry behavior from both the page button and toolbar icon, restricted Offscreen message flow, bounded ASR audio permissions, and updated compatibility and data-use notes. | Draft |

## Review Notes

### Known Issues / Limitations

Before submission:

- Complete and verify tickets #01 through #04. The current source is not ready for store submission.
- Update the support screenshots after the toolbar entry is implemented.
- Confirm that the extension name and Bilibili references comply with the Chrome Web Store trademark policy.
- Fill in the publisher name and a monitored contact email.
- Verify that the GitHub-hosted privacy policy URL is public and matches the completed code.
- Rebuild the 2.1.0 archive from the verified final source; do not submit `release/bilibili-summary-v2.1.0-chrome.zip` as it stands before this task's implementation tickets are complete.

### Rejection History

None recorded.
