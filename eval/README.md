# ASR 模型速度评测工具

对比硅基流动托管的各语音转写模型转写**同一段音频**的速度。评测走扩展**真实**的转写适配器（`extension/asr/adapters/openai-transcriptions.ts`）与调度引擎（`extension/asr/engine.ts`），结果代表生产行为：

- 每个模型重复跑 N 次（默认 3 次），取均值，避免单次网络波动误导；
- 记录每次 API 请求的往返耗时（段均）、整次转写的墙钟耗时、实时率 RTF（转 1 分钟音频需要多少秒）；
- 报告每个模型返回的文本是否带时间戳（响应有无 `segments` 结构 + 文本是否内嵌 `[mm:ss]` / `{数字}` 等标记）；
- 结果导出 `report.json`（结构化，含每次请求明细）与 `report.md`（可读 Markdown），控制台同时打印摘要表格。

评测在 Node 进程内运行，不改扩展生产代码，也不需要 B 站登录。

## 准备什么

1. **Node 18+**（依赖其自带的 fetch / FormData / Blob，无需额外安装依赖，仓库 `npm install` 后即可）。
2. **一份标准 PCM WAV 音频**，放到 `eval/audio/` 下（该目录已进 `.gitignore`）：
   - 任何工具导出都行，或用 ffmpeg 从 B 站视频音频导出：`ffmpeg -i video.mp4 -ac 1 -ar 16000 out.wav`；
   - 16k 单声道（mono）最佳，但任何标准 PCM WAV 都可以——脚本会按 WAV 头解析并内部统一转 16k mono 再切片上传；
   - 硅基流动单文件限制约 1 小时 / 50MB，脚本按配置的段长（默认 120 秒）切片后不受此限制。
3. **API key**：`export SILICONFLOW_API_KEY=sk-...`（key 只走环境变量，不会写进代码或 git）。
4. **配置**：`cp eval/config.example.json eval/config.json`，然后按需修改：
   - `models`：要评测的模型名单；
   - `runsPerModel`：每模型重复次数（默认 3）；
   - `chunkSeconds`：每片秒数（默认 120）；
   - `audioPath`：音频路径（默认 `eval/audio/demo.wav`）;
   - `outDir`：报告输出目录（默认 `eval/out`）；
   - `baseUrl`：API 根路径（默认硅基流动）；
   - `inlineTimestampPatterns`：判定"文本内嵌时间戳"的正则（JSON 里反斜杠写成 `\\`）。

## 如何操作

一条命令：

```bash
npm run eval:run
```

它等价于先用 esbuild 把 `eval/run.ts` 打包成 `eval/run.mjs`，再用 node 运行（Node 无法直接加载 TS）：

```bash
node_modules/.bin/esbuild eval/run.ts --bundle --platform=node --format=esm --outfile=eval/run.mjs
node eval/run.mjs            # 默认读 eval/config.json
node eval/run.mjs my.json    # 也可传自定义配置路径
```

运行流程：读配置和 key → 读音频切片 → 安装计时 fetch → 用 `/models` 过滤不在线的模型 → 逐模型跑 N 次（每片经真实适配器上传，含 verbose_json→json 降级二次请求，全部计入计时）→ 时间戳判定 → 写报告 → 还原全局 fetch。评测中途某模型若端点返回确定性 4xx（400/401/404）或 0 片成功，会标记跳过并继续测后面的模型。

## 输出说明

`report.json` 与 `report.md` 按模型组织，主要字段：

- **段均均值ms（segmentMeanMean）**：该模型各次成功 run 中，每次 API 请求往返耗时（仅 2xx）的均值的再平均。反映模型本身的处理速度，与并发调度无关。
- **墙钟均值ms（wallMean）**：从建引擎 push 全部片到 close 结算的整次耗时均值，含并发调度与重试，代表真实使用体感。
- **RTF（rtfMean）**：墙钟 ÷ 音频总时长，越小于 1 表示比实时快，可跨不同长度音频比较。
- **时间戳**：判定口径是双通道——① 响应结构：适配器返回里有 `segments`（句级时间戳）即"是"；② 文本内嵌：文本命中配置的正则（如 `[mm:ss]`、`{数字}`）也判"是"。注意硅基流动多数模型只回 `{ text }`，时间戳多半是文本内嵌的。
- **成功次数**：成功 run 数 / 总 run 数。某次 run 若 0 片完成或没有任何 2xx 请求，记为 FAIL，不计入均值。
- **样例文本（sampleText）**：最后一次成功 run 的第一个成功片结果（截断约 300 字符），供肉眼核对输出形态。
- **跳过（skipped/skipReason）**：模型首片实测即返回确定性 4xx（400/401/404，如端点不支持该模型、key 无权限）或 0 片成功时，跳过该模型后续 run，报告中标注原因。GSR-V1.0 等未确认端点的模型靠此兜底。

控制台摘要表格列：模型 | 段均均值ms | 墙钟均值ms | RTF | 时间戳 | 成功次数 | 备注。

## 常见问题

- **报"未设置环境变量 SILICONFLOW_API_KEY"**：先 `export SILICONFLOW_API_KEY=sk-...` 再运行。
- **报"无法读取音频文件"或切片为空**：检查 `audioPath` 是否正确、文件是否为标准 PCM WAV（非 mp3/m4a/压缩格式；可用 ffmpeg 转换）。
- **所有模型都被跳过**：可能是 key 无效/欠费（401）、`baseUrl` 配错、或这些模型端点确实不支持 `/audio/transcriptions`——看报告中各模型的 skipReason 与 report.json 里的请求状态码定位。
- **某个模型不在平台在线名单**：启动时 `/models` 过滤会提示并跳过；确认模型名拼写与平台控制台一致。
- **重复运行评测**：脚本结束时还原全局 fetch，可反复运行；报告目录每次覆盖写入。
