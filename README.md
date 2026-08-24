# Bilibili-Summary｜一键总结B站视频

> **本仓库说明**：本仓库（Bilibili-Summary）是在上游源仓库 [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper) 的基础上由本人进行二次修改（fork）的版本，保留了上游的 MIT License 与版权归属。

在 B 站视频页抓取字幕，支持预览、复制 Markdown、下载字幕文件，并可一键总结视频；内置 AI 侧边栏可直接围绕字幕内容进行多轮对话，也可在任意网页中作为通用 AI 对话侧边栏使用。

> 注意：仅支持获取"有字幕轨"的 B 站视频字幕（播放器里有「字幕」选项，通常表示作者上传了外挂字幕或平台提供了 AI 字幕）；没有字幕轨的视频无法获取字幕。

## 变更日志

### 2025-08-24

- **content script 架构重构（T10）**：`extension/content.js` 从 458 行缩减到 96 行，变为纯粹的初始化编排器，仅保留 `init()` 调用链、`isSupportedUrl()` 判断以及对各模块的聚合 import。
- 新增 `extension/messages.js`，迁出 `chrome.runtime.onMessage` 监听器；并修复其中 `fetchHotComments`、`getCurrentAid`、`buildMarkdown` 缺失 import 导致的运行时 `ReferenceError`。
- `extension/panel.js` 迁入并导出 `ensureUiReady()`；`extension/reader.js` 迁入 `clearReaderModePageState()`、`shouldForceNormalPageState()`、`enforceNormalPageStateIfNeeded()`、`bindNormalPageStateGuard()`。
- 打破 `router.js -> content.js -> router.js` 的循环依赖：`router.js` 改为直接从 `panel.js` 和 `reader.js` 导入所需函数。
- 视频页、稍后再看页、阅读视图、播放器 AI 按钮四条路径保持原有调用链，仅模块边界被重新组织。

## 功能

### AI 侧边栏

- 围绕当前视频字幕进行轻量多轮对话，也支持在任意网页中作为通用 AI 对话侧边栏使用
- 内置历史对话、预设提示词、模型切换等能力，适合快速总结、整理与提炼视频内容
- 支持自定义系统提示词和初始问题，可按工作流精细调整 AI 响应风格
- 模型名称输入框旁带有下拉箭头，点击后可一键拉取平台提供的模型列表，无需手动输入模型名称

### 播放器 AI 快捷按钮 / 一键总结

在视频播放器内显示 AI 按钮，可自定义提示词，点击后即可一键触发 AI 对话并生成视频摘要；稍后再看页面同样支持。

### 字幕抓取

- B 站视频字幕抓取（自动识别当前分 P）
- 字幕预览、复制 Markdown
- 下载字幕文件（`srt/txt`）

### 阅读视图

沉浸式布局，支持排版调整、主题切换、字幕同步等。

> 稍后再看页面的阅读视图体验尚不完善，推荐在普通视频页使用。

## 功能图片演示

![Bilibili-Summary 功能演示](docs/images/feature-demo-v2.png)

![Bilibili-Summary AI 侧边栏演示](docs/images/33.png)

## AI 配置与平台支持

首次使用 AI 功能前，需要在扩展设置页中配置 AI 模型平台：

1. 右键点击扩展图标 → 选择「选项」，进入设置页
2. 在「AI 模型平台」区域点击「+ 添加平台」
3. 选择平台预设（会自动填充 API Base URL），或选择「自定义」手动填写
4. 填写 API Key 和模型名称（点击模型名称旁的箭头可自动拉取可用模型列表）
5. 点击「测试」按钮验证连接；测试成功后配置自动保存

设置页中还可按需调整：

- **AI 按钮**：开启播放器内 AI 快捷按钮，自定义提示词
- **AI 对话 - 系统提示词**：设定 AI 的全局行为偏好
- **AI 对话 - 初始问题**：设置新视频的快捷提问入口（最多 4 条）

### 已支持的平台预设

本扩展支持 OpenAI 兼容协议的 AI 服务，内置以下平台预设：

| 平台 | 预设名称 |
|------|----------|
| OpenAI | OpenAI 兼容 |
| DeepSeek | DeepSeek |
| 阿里通义千问 | Qwen |
| 智谱 GLM | GLM |
| 月之暗面 Kimi | Kimi |
| MiniMax | MiniMax |
| Mimo | Mimo |
| Opencode Go | Opencode Go |
| OpenRouter | OpenRouter |
| 阶跃星辰 | Stepfun |
| ModelScope | ModelScope |
| Ollama（本地部署） | Ollama (本地) |

如果没有您使用的平台，可选择「自定义」预设，手动填写该平台的 API Base URL（需兼容 OpenAI 协议）即可。

## 安装方式

### Chrome / Edge

1. 使用 `git clone` 下载源码（例如 `git clone https://github.com/Edmund724/Bilibili-Summary.git`）
2. 进入克隆后的源码目录 `Bilibili-Summary`
3. 打开扩展管理页：
   - Chrome：`chrome://extensions/`
   - Edge：`edge://extensions/`
4. 开启"开发者模式"
5. 点击"加载已解压的扩展程序"
6. 选择克隆后的扩展目录

### Firefox

1. 使用 `git clone` 下载源码（例如 `git clone https://github.com/Edmund724/Bilibili-Summary.git`）
2. 进入克隆后的源码目录 `Bilibili-Summary`
3. 打开 Firefox 附加组件管理页：`about:addons`
4. 点击右上角齿轮图标 → "调试附加组件"
5. 点击"临时加载附加组件..."
6. 选择克隆后文件夹中的 `manifest.json` 文件

## 项目结构

- `README.md` / `LICENSE`：项目说明与许可证
- `extension/`：插件源码
  - `ai/`：AI 提供商预设与流式处理
  - `icons/`：扩展图标
  - `background.js` / `content.js` / `content.css`：核心逻辑与样式
  - `popup.html` / `popup.js` / `popup.css`：弹出面板
  - `sidepanel.html` / `sidepanel.js` / `sidepanel.css`：AI 侧边栏
  - `options.html` / `options.js` / `options.css`：设置页
  - `manifest.json`：扩展清单

### Content script 架构说明

`content.js` 现在是 ES module，并在 `manifest.json` 里以 `content_scripts` 静态加载。  
但 Chrome 的 `chrome.scripting.executeScript` 只能注入经典脚本，不能直接注入 ES module；扩展里的刷新/恢复流程又必须走这条动态注入路径。所以当前架构是：

- 静态加载：`manifest.json` -> `content.js`（module）
- 动态注入：`background.js` / `popup.js` -> `content-classic.js`（classic bundle）
- `content-classic.js` 是把 `shared-defaults.js` 和 `content.js` 合并后的经典脚本，专门用于 `executeScript` 注入

这个限制是 Chrome Extension API 层面的，不是暂时 bug。后续拆分模块时，content 主入口仍需保持一个经典脚本注入路径。

#### 构建 `content-classic.js`

修改 `extension/shared-defaults.js` 或 `extension/content.js` 后，需要重新生成 `extension/content-classic.js`：

```bash
node scripts/build-content-classic.js
```

或在 `package.json` 脚本里执行：

```bash
npm run build:content-classic
```

生成规则：
- 以 `extension/shared-defaults.js` 和 `extension/content.js` 为输入
- 自动内联依赖并移除 `import` / `export` 语法
- 输出为兼容 `chrome.scripting.executeScript` 的经典脚本

> `extension/content-classic.js` 是生成产物，已加入 `.gitignore`，请勿手动编辑。

`extension/content-classic.js` 是生成文件，不要手动编辑。

## 使用方式

1. 打开任意 B 站视频页并点击扩展图标
2. 面板会自动抓取并展示字幕
3. 按需使用：
   - **字幕模式**：复制 Markdown / 下载字幕文件
   - **AI 模式**：在侧边栏中针对字幕内容进行多轮对话，或通过播放器内的 AI 按钮一键生成视频摘要
   - **阅读视图**：在沉浸式布局中浏览字幕，支持排版调整与主题切换

## 用自己的 Agent 二次修改

这个项目是开源浏览器扩展，您可以下载源码，让自己的 AI 编程 Agent 按个人工作流修改功能。

推荐步骤：

1. 使用 `git clone` 下载源码到本地
2. 用 Cursor、Codex、Claude Code 等 AI 编程工具打开项目文件夹
3. 把想修改的功能描述清楚，例如：
   - "调整 AI 总结视频的提示词和预期输出格式"
   - "新增一个自定义的总结命令或快捷方式"
   - "修改视频总结的触发方式（例如自动总结、播放器内快捷按钮或侧边栏手动触发）"
4. 修改完成后，在浏览器扩展管理页选择 `extension/` 文件夹进行本地加载
5. 打开 B 站视频页测试字幕抓取、AI 对话和视频总结是否正常

建议先在本地测试确认无误，再替换日常使用的扩展版本。修改源码前也建议保留一份原始版本，方便出现问题时回退。

## 常见问题

### 为什么有些视频没有字幕？

本工具仅支持获取播放器中带有「字幕」选项的视频。如果播放器里没有字幕选项，说明该视频没有字幕轨（作者未上传外挂字幕，且平台未生成 AI 字幕），此时本工具无法获取字幕内容。

### 模型下拉列表为空或拉取失败是什么原因？

下拉列表会从配置的 API Base URL 拉取 `/v1/models` 接口返回的模型列表。如果列表为空或报错，请检查：
- API Base URL 是否正确且可访问
- API Key 是否有效（部分平台需要 Key 才能查看模型列表）
- 该平台是否兼容 OpenAI `/v1/models` 接口规范

如果平台不支持模型列表接口，可直接在模型名称输入框中手动填写模型名称。

### 测试按钮报错怎么办？

点击「测试」按钮会发送一次最小化的 AI 请求来验证连接。如果报错，请先确认 API Base URL、API Key 和模型名称均已正确填写；同时检查网络环境是否能访问对应平台的服务。

### Firefox 和 Chrome 的体验有差异吗？

Firefox 当前采用"临时加载附加组件"的方式安装，更适合开发调试；重新加载扩展后，本地设置和 AI 历史对话可能不会保留。Chrome / Edge 的体验相对更稳定。

### 稍后再看页面和普通视频页有什么区别？

普通视频页的字幕抓取、阅读视图、AI 侧边栏和播放器 AI 按钮均已适配；稍后再看页面的阅读视图体验尚不完善，但 AI 侧边栏和播放器快捷按钮已经支持。

## 视频教程

> 以下教程来自上游源仓库作者 [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper)。本仓库已对其功能与界面进行一定修改，教程内容仅供参考，部分操作可能与本仓库当前版本不一致。

- [B 站教程](https://www.bilibili.com/video/BV15qQwB4EZ9/?spm_id_from=333.1387.homepage.video_card.click&vd_source=040bc5ea7866b419558ec2682a2ccb59)

## 免责声明

> ▎ **用户自负责任条款**：本工具仅在用户已登录 B 站、且有访问权限的前提下获取数据。所有数据通过用户自己的浏览器和 cookie 获取，不经过任何第三方服务器。本工具不存储、不分发任何 B 站内容。使用本工具产生的所有后果由用户自行承担。请遵守 B 站用户协议与相关法律法规。
