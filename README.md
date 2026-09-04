# Bilibili-Summary｜一键总结 B 站视频

> 本项目基于 [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper) 二次修改，沿用原仓库的 MIT License。UI 设计参考了 [YouTube Digest](https://github.com/zarazhangrui/youtube-digest)。

一个开源的浏览器扩展，在 B 站视频页侧边栏提供字幕阅读、AI 总结、内容讲解和时间戳笔记，不用离开视频页面。

API Key 需要自己准备，但不用花钱：下文推荐的硅基流动和 ModelScope 都提供免费额度，日常使用基本够用。项目本身不送 Key，也不经手中转你的请求。

## 功能

### 字幕与时间戳跳转

- 自动抓取 B 站视频字幕（识别当前分 P），支持 Markdown 复制和 `srt/txt` 下载
- 字幕逐句带时间戳，点击跳转到对应播放位置；支持句内搜索和跟随播放滚动
- 视频没有字幕时，自动改用语音识别转写（硅基流动或本地 Whisper）

### 章节概览与金句收集

- 「概览」标签页自动生成视频章节和重点引用，打开就能看到
- 章节按视频结构分段，点击跳播对应位置
- 支持保存和导出带时间戳的笔记

### AI 对话栏

- 围绕字幕内容多轮对话，追问细节或拓展知识点
- 内置预设提示词、模型切换、深度思考开关和历史对话
- 播放器内 AI 快捷按钮可一键生成视频摘要
- 选中字幕后弹出「解释」卡片，可一键发到对话栏继续追问
- AI 回答中的时间戳同样可点击跳转

## 功能图片演示

![Bilibili-Summary 字幕标签页：逐句时间戳，点击跳转播放位置](docs/images/demo-subtitle.png)

![Bilibili-Summary 概览标签页：AI 生成的章节分段](docs/images/demo-overview.png)

![Bilibili-Summary AI 对话标签页：围绕视频内容多轮追问](docs/images/demo-ai-chat.png)

## 安装方式

> 仅支持 Chrome / Edge 等 Chromium 浏览器，不支持 Firefox。核心功能依赖 offscreen 等 Chrome 专属 API。

### 方式一：下载打包版本（推荐）

1. 解压下载的 zip 包到任意长期保留的文件夹

2. 打开扩展管理页：
   
   - Chrome：`chrome://extensions/`
   
   - Edge：`edge://extensions/`

3. 开启"开发者模式"

4. 点击"加载已解压的扩展程序"，选择解压后的文件夹

### 方式二：从源码构建

```bash
git clone https://github.com/Edmund724/Bilibili-Summary.git
cd Bilibili-Summary
npm install
npm run build          # 生成 dist/（content 分包 + 各入口 bundle，含 sourcemap）
npm run dev            # watch 模式：首轮全量构建到 dist/ 后持续重建，改代码即生效
npm run build:release  # 生成 Chrome 打包到 release/（zip 不含 sourcemap）
```

日常开发跑 `npm run dev`，在扩展管理页「加载已解压的扩展程序」选择 `dist/`，重建后点扩展的刷新按钮即可。

### 方式三：让编程 Agent 帮你安装

无需编程基础，也不用命令行操作。把下面这段话发送给你的编程 Agent：

> 请把这个项目下载或克隆到我选择的长期保留文件夹，告诉我准确的完整路径，并让 Chrome"加载已解压的扩展程序"使用同一个文件夹。如果我在第一次安装时需要位置建议，可以推荐 macOS 或 Linux 上的 `~/Documents/bilibili-summary`，或 Windows 上的 `%USERPROFILE%\Documents\bilibili-summary`，但不要假设我一定使用这些路径。请用简单易懂的语言一步一步指导我完成安装和配置。https://github.com/Edmund724/Bilibili-Summary

你的 Agent 应该帮你：

1. 先确认你想把项目放在哪里，再下载到该位置，并告诉你完整路径。
2. 打开下方硅基流动和 ModelScope 官方页面，指导你创建自己的账号。
3. 指导你在 Chrome 中通过"加载已解压的扩展程序"选择项目文件夹。
4. 告诉你在扩展的"设置"页面哪个位置填写 API Key。
5. 打开一个有字幕的 B 站视频，确认字幕、阅读视图和 AI 对话功能可用。

安装后请让这个文件夹留在原位。移动或删除它，Chrome 中加载的本地扩展就会失效，需要从新的位置重新加载。

不要把 API Key 发给编程 Agent。它只需要告诉你填写位置，Key 由你自己在设置页面粘贴。

## 设置 API Key

Bilibili-Summary 需要两个 Key：

1. **硅基流动 API Key**，用于无字幕视频的语音转写。
2. **ModelScope API Key**，用于 AI 总结和对话。

### 获取硅基流动 API Key

1. 打开硅基流动官方[注册页面](https://siliconflow.cn/)。
2. 创建账号并登录。
3. 在控制台的 API Key 管理页创建一个新 Key。
4. 复制 Key，粘贴到 Bilibili Summary 设置中的 **硅基流动 API Key**。
5. 点模型名右侧的箭头拉取该平台全部可选模型，从列表中选择一个。常用转写模型的区别：
   
   - `XingChenAGI/XingChenASR-V3.2`：免费，返回句级时间戳，字幕可逐句点击跳播。**实测速度最快，首选推荐**。
   - `XingChenAGI/XingChenASR-Diarize-V3.0`：免费，返回句级时间戳，速度次之，额外带说话人区分（转写文本按说话人分段）。
   - `XingChenAGI/XingChenASR-V3.2-Ultra`：免费，返回句级时间戳，但实测耗时约为 V3.2 的 2.5 倍。
   
   - `FunAudioLLM/SenseVoiceSmall`：免费，但不返回时间戳，字幕只能按音频分片粗略定位。
   
   - `Qwen/Qwen3-ASR-1.7B`：收费模型，需要付费额度。

如果页面流程有变化，请查看 [硅基流动官方文档](https://docs.siliconflow.cn/)。

速度排名来自本仓库 `eval/` 速度评测的实测结果（2026-09-04，走扩展真实转写路径、生产同款配置：10 并发、5 分钟/片；同一段 60 分钟音频，每模型 3 次取平均）：V3.2 墙钟约 68 秒（RTF 0.019）最快；Diarize-V3.0 约 108 秒（RTF 0.030）次之；GSR-V1.0 约 136 秒（RTF 0.038）；V3.2-Ultra 约 169 秒（RTF 0.047）最慢。想复现或测其他模型，运行 `npm run eval:run`（详见 `eval/README.md`，报告见 `eval/out/`）。

### 获取 ModelScope API Key

1. 打开 ModelScope 官方[注册/登录页面](https://modelscope.cn/)。
2. 创建账号或登录。
3. 在用户页或 API 管理页创建 SDK Token（通常是 `ms-` 开头）。
4. 复制 Token，粘贴到 Bilibili Summary 设置中的 **ModelScope API Key**。

ModelScope 提供每日签到免费积分，注册后每天登录官网即可领取，积分可直接用于 AI 总结和对话，详见下方「免费额度与成本」。账号和接口的最新说明请查看 [ModelScope 官方 API 文档](https://modelscope.cn/docs/intro/model-service)。

在阅读面板（Digest）右上角点齿轮按钮打开 **设置** 抽屉，Key 只能粘贴到这里的设置输入框中。不要把 Key 发到 AI 对话、项目文件、截图或公开消息中。

添加平台时选择 ModelScope 预设，Base URL 会自动填充。粘贴 Token 后，点模型名称旁的箭头即可拉取可用模型列表，从中选择一个，无需手动填写。想换模型或改用其他平台，随时在设置的「AI 模型平台」中修改。

API Key 保存在本机的 Chrome 扩展本地存储中，非敏感设置经 Chrome 账号同步。发布包不包含也不读取 `config.js`。

## 使用方式

1. 打开一个带字幕的 B 站视频页面。
2. 点击视频下方的 Digest 按钮，打开侧边栏。
3. 阅读带时间戳的字幕。
4. 切换到 **AI 标签页**，查看 AI 生成的视频摘要，或围绕字幕内容多轮对话。
5. 选中字幕，获取 AI 内容讲解或保存带时间戳的笔记。
6. 保存的笔记之后可以在侧边栏中查看。

## 当前支持范围

- Chrome 116 或更高版本。
- B 站视频页（`bilibili.com/video`）以及稍后再看等列表播放页。
- B 站原生字幕，优先请求中文字幕，也可能显示其他可用的原生语言。
- AI 总结、选中文本讲解、翻译和自动润色笔记。
- 本地笔记，以及最近字幕、概览和翻译的本地缓存。
- 无字幕视频的语音识别回退（硅基流动 / 本地 Whisper）。

Firefox、Safari、移动浏览器和其他 Chromium 浏览器没有测试过。

## 免费额度与成本

### 硅基流动

硅基流动提供免费语音转写额度，用免费模型（如`XingChenAGI/XingChenASR-V3.2`）转写无字幕视频通常不收费。`Qwen/Qwen3-ASR-1.7B` 是收费模型，按量计费。使用前请查看 [硅基流动定价页面](https://siliconflow.cn/pricing) 确认最新规则。

### ModelScope

ModelScope 提供每日签到免费积分，注册账号后每天登录官网即可领取，积分可用于 AI 总结和对话。如果提示积分不足，先完成当日签到，再检查账号额度与限速。ModelScope 与硅基流动的额度分开计算。

Bilibili Summary 不收款，也不转售 API 服务。建议为账号设置消费上限并定期查看用量。

## AI 配置与平台支持

首次使用 AI 功能前，需要配置 AI 模型平台。设置入口在阅读面板（Digest）右上角的齿轮按钮，点击打开「设置」抽屉即可看到全部设置项（原独立设置页已并入侧边栏）：

1. 打开阅读面板，点击右上角齿轮（设置）
2. 在「AI 模型平台」区域点击「+ 添加平台」
3. 选择平台预设（自动填充 API Base URL），或选择「自定义」手动填写
4. 填写 API Key 和模型名称（点击模型名称旁的箭头可自动拉取可用模型列表）
5. 点击「测试」验证连接，测试成功后配置自动保存

设置抽屉中还可按需调整：

- AI 按钮：播放器内 AI 快捷按钮和自定义提示词
- AI 对话 - 系统提示词：AI 的全局行为偏好
- AI 对话 - 初始问题：新视频的快捷提问入口（最多 4 条）
- 导出 / 笔记属性：下载格式、Frontmatter 字段、自定义属性与正文附加段落

### 已支持的平台预设

本扩展支持 OpenAI 兼容协议的 AI 服务，内置以下平台预设：

| 平台           | 预设名称        |
| ------------ | ----------- |
| OpenAI       | OpenAI 兼容   |
| DeepSeek     | DeepSeek    |
| 阿里通义千问       | Qwen        |
| 智谱 GLM       | GLM         |
| 月之暗面 Kimi    | Kimi        |
| MiniMax      | MiniMax     |
| Mimo         | Mimo        |
| Opencode Go  | Opencode Go |
| OpenRouter   | OpenRouter  |
| 阶跃星辰         | Stepfun     |
| ModelScope   | ModelScope  |
| Ollama（本地部署） | Ollama (本地) |

没有你要用的平台时，选择「自定义」预设，手动填写该平台的 API Base URL（需兼容 OpenAI 协议）。

## 隐私和数据流向

Bilibili Summary 直接从扩展向服务商发送请求：

1. 从 B 站获取原生字幕数据。
2. 使用 AI 功能时，把字幕和相关视频信息发送给 ModelScope 或你自行配置的 AI 平台。
3. 翻译或讲解等功能只发送当前需要的内容，比如选中的文本和上下文。
4. 开启「无字幕视频语音识别回退」后，无字幕视频的音频会发送到你选用的语音识别平台（如硅基流动）转写。「本地 Whisper」预设连接本机自部署的转写服务，音频不出本机。不开启回退时，本工具不抓取也不上传任何音频。
5. API Key、笔记、对话与最近缓存仅存本地（`chrome.storage.local`，不随账号同步）；非敏感设置（系统提示词、下载格式、Frontmatter 字段等）经 `chrome.storage.sync` 随 Chrome 账号在登录设备间同步。

Bilibili Summary 没有账号系统、广告、分析统计或行为追踪。硅基流动和 ModelScope 会按各自的条款和隐私政策处理数据。详见 [PRIVACY.md](PRIVACY.md)。

## 常见问题

### 为什么有些视频没有字幕？

如果播放器里没有「字幕」选项，说明该视频没有字幕轨（作者未上传外挂字幕，平台也未生成 AI 字幕）。此时如果你已配置语音识别平台并开启「无字幕自动语音识别」，本工具会自动抓取视频音频转写成字幕；未配置平台时保持原有的无字幕提示。已有字幕轨的视频不会触发语音识别，也不会请求任何音频数据。

### 模型下拉列表为空或拉取失败是什么原因？

下拉列表从配置的 API Base URL 拉取 `/v1/models` 接口。如果列表为空或报错，请检查：

- API Base URL 是否正确且可访问
- API Key 是否有效（部分平台需要 Key 才能查看模型列表）
- 该平台是否兼容 OpenAI `/v1/models` 接口规范

平台不支持模型列表接口时，直接在模型名称输入框中手动填写。

### 测试按钮报错怎么办？

「测试」会发送一次最小化的 AI 请求验证连接。报错时先确认 API Base URL、API Key 和模型名称填写正确，再检查网络能否访问对应平台。

### 为什么只支持 Chrome / Edge，不支持 Firefox？

音频解码和转写等核心功能依赖 offscreen 等 Chrome 专属 API，Firefox 下无法工作，因此只发布 Chrome 变体（Chrome / Edge 等 Chromium 浏览器均可使用）。

### ModelScope 提示积分不足怎么办？

在 ModelScope 官网完成当日签到领取免费积分。已签到仍提示不足时，检查账号的额度与限速状态，或稍后再试。

### 硅基流动转写失败怎么办？

检查硅基流动 API Key 是否有效，以及网络能否访问 `api.siliconflow.cn`。仍失败时，可以切换为其他语音识别平台，或在设置中关闭「无字幕自动语音识别」。

### 语音转写的并发是多少？能调大吗？

扩展内置的转写并发是 **10**（音频切成 5 分钟/片后，最多 10 片同时请求转写接口）。这个值是用本仓库 `eval/` 的并发扫描工具对硅基流动实测得出的最优解：并发 10 相对更低档位提速约 26% 且单请求耗时基本不变；并发再高（12 以上）服务端开始排队，单请求耗时被拉长，20 并发时整体速度反而比 9 并发还慢。想自己验证或换平台重测，运行 `npm run eval:sweep`（见 `eval/README.md`）。

## 项目结构

```
extension/
├── manifest.json          # 扩展清单
├── entry/                 # 入口（background、content、offscreen）
├── ai/                    # AI 客户端、SSE 流式解析、播放器 AI 按钮
├── asr/                   # 语音识别（音频分片、转写、WAV 编码）
├── bilibili/              # B 站 API 网关与视频 ID 解析
├── chat/                  # 对话运行时与会话存储
├── core/                  # 核心状态、运行时、消息处理
├── notes/                 # 笔记/导出渲染（Markdown、SRT、TXT）
├── subtitle/              # 字幕抓取、缓存与处理
├── reader/                # 阅读视图（生命周期/同步/布局）
├── ui/                    # UI 渲染（面板、Markdown、时间戳导航）
├── shared/                # 跨模块工具（DOM、日志、字符串处理等）
└── icons/                 # 扩展图标
```

> `extension/entry/content-bootstrap.iife.js`、`entry/content-main.mjs` 与 `entry/chunks/` 是构建产物，由 `npm run build` 生成（content 部分由 scripts/build-content.js 产出），已加入 `.gitignore`，请勿手动编辑。

## 二次开发与个性化

项目完全开源，你可以下载源码后，用 AI 编程工具按个人工作流修改功能：

1. 用 `git clone` 下载源码到本地
2. 用 Codex、Kimi Code、ZCode、DeepSeek Harness 等 AI 编程工具打开项目文件夹
3. 描述你想调整的功能（见下方的常见方向）
4. 修改后跑 `npm run build`（或开发时用 `npm run dev` 持续重建），在扩展管理页选择 `dist/` 加载
5. 打开 B 站视频页，测试字幕抓取、AI 对话和视频总结是否正常

常见修改方向：

- 调整 AI 总结的提示词和输出格式
- 新增自定义总结命令或快捷方式
- 修改视频总结的触发方式（自动总结 / 播放器按钮 / 侧边栏手动触发）
- 增加更多翻译语言或自定义总结模板
- 增加生词本功能，保存单词、原句、解释和视频时间戳
- 把笔记和生词导出到 Markdown、CSV、Anki 或其他学习工具
- 增加主题筛选，只展示与你目标相关的章节
- 增加本地模型选项，获得不同的隐私和成本方案
- 改善键盘操作、字体大小和高对比度等无障碍体验

建议先本地测试确认正常，再替换日常使用的版本；修改前备份原始代码以便回退。请保持用户自行填写 API Key 的方式，不要把密钥硬编码到源码中。

如需切换到其他 AI 平台或模型，让编程 Agent 打开你在 Chrome 中加载的同一个项目文件夹，描述想用的平台和模型即可。Agent 改完代码后，Key 仍由你自己在设置项中填写。

## 给编程 Agent 的检查命令

修改项目后，让你的编程 Agent 运行：

```bash
npm test
npm run typecheck
npm run build
```

Agent 还应该在 Chrome 中重新加载扩展，并测试多个真实 B 站视频。自动检查通过，不代表真实服务请求和 B 站交互一定正常。

## 开源许可

MIT，详见 [LICENSE](LICENSE)。

## 免责声明

> ▎ **用户自负责任条款**：本工具仅在用户已登录 B 站、且有访问权限的前提下获取数据。所有数据通过用户自己的浏览器和 cookie 获取，不经过任何第三方服务器。本工具不存储、不分发任何 B 站内容。使用本工具产生的所有后果由用户自行承担。请遵守 B 站用户协议与相关法律法规。
