// extension/asr/adapters/dashscope-filetrans.js
// 阿里百炼（DashScope）异步转写适配器：整段音频一次提交，免切片。
//
// 流程（接口形状以百炼官方文档为准，2026-08 核实）：
//   1. getPolicy 授权  GET {base}/api/v1/uploads?action=getPolicy&model={model}
//      返回 data.policy / signature / upload_dir / upload_host / oss_access_key_id /
//      x_oss_object_acl / x_oss_forbid_overwrite（凭证 300 秒有效，每次上传前重新取）。
//      文档：https://help.aliyun.com/zh/model-studio/get-temporary-file-url
//   2. 上传 WAV    POST {data.upload_host}，multipart/form-data：
//      OSSAccessKeyId / policy / Signature / key(=upload_dir + "/" + 文件名) /
//      x-oss-object-acl / x-oss-forbid-overwrite / success_action_status=200 / file
//      （file 必须是最后一个表单域）。
//      文档：同上（"步骤2：上传文件至临时存储空间"）
//   3. 拼文件 URL：`oss://` + key（48 小时有效）。注意：这是 oss:// 内部协议
//      URL 而非公网 http URL——提交任务时必须带 X-DashScope-OssResourceResolve: enable
//      请求头让服务端解析（文档"步骤三：生成文件URL"）。
//   4. 提交任务   POST {base}/api/v1/services/audio/asr/transcription
//      Headers: Authorization: Bearer {apiKey}, X-DashScope-Async: enable,
//               X-DashScope-OssResourceResolve: enable, Content-Type: application/json
//      Body: { model, input: { file_urls: [fileUrl] } }
//      返回 output.task_id。
//      文档：https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api
//   5. 轮询       GET {base}/api/v1/tasks/{task_id}（Authorization: Bearer {apiKey}）
//      每 POLL_INTERVAL_MS 一次直到 output.task_status ∈ {SUCCEEDED, FAILED}；
//      成功从 output.results[].transcription_url 拉结果 JSON，
//      把 transcripts[].sentences[] 的 begin_time/end_time（毫秒）/text
//      映射为 { start, end, text }（毫秒转秒）。
//
// 错误处理：
//   - getPolicy 授权 401/403 → 明确提示「API Key 无效」（对照探针
//     asr-provider-store.js probeDashscopeFiletrans 的文案）；
//   - 其余非 2xx / 网络错误抛 Error，交给管线 retryAsync 指数退避重试；
//   - 任务 FAILED → 透出后台返回的 output.message / code 类错误信息。
//
// 已知取舍：signal.aborted 只退出本地轮询，云端任务不取消——百炼任务
// 状态机不可撤销（仅 PENDING 可取消但取消后拿不到结果），abort 后任务在
// 云端跑完即丢弃，下次重试走缓存或新任务，属可接受取舍（spec 6.5）。

export const ADAPTER_TYPE = "dashscope-filetrans";

// 上传到百炼临时存储的固定文件名（与 key 拼接）
const FILE_NAME = "audio.wav";

// 轮询间隔。抽成模块常量便于测试 override 为 0 秒（mock fetch 全链路断言）。
export const POLL_INTERVAL_MS = 3000;

// 测试钩子：设置后取代 POLL_INTERVAL_MS（vitest 里置 0 免 fake timers）。
// 生产代码不触碰。
export function __setPollIntervalForTest(ms) {
  activePollInterval = ms;
}

let activePollInterval = null;

// 每跳轮询前检查 signal：已中止立即抛 AbortError，不再发起新一轮轮询请求。
function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error("已停止生成");
    err.name = "AbortError";
    throw err;
  }
}

// 归一化句级结果：sentences[]（begin_time/end_time 为毫秒）→ { start, end, text }
// （秒）。text 空白 / 时间戳非法（负值）的句子丢弃，与 openai 适配器的
// normalizeSegments 语义对齐。
export function normalizeSentences(sentences) {
  if (!Array.isArray(sentences)) {
    return [];
  }
  const out = [];
  for (const s of sentences) {
    const begin = Number(s?.begin_time);
    const end = Number(s?.end_time);
    const text = String(s?.text || "").trim();
    if (!Number.isFinite(begin) || !Number.isFinite(end) || begin < 0 || end < begin || !text) {
      continue;
    }
    out.push({ start: begin / 1000, end: end / 1000, text });
  }
  return out;
}

// 从转写任务结果 URL 拉结果 JSON，取 transcripts[].sentences[] 归一化。
// 仅关注 sentence_id=1 的说话人通道（0 号），与提交时默认 channel_id [0] 一致。
async function fetchTranscriptionResult(transcriptionUrl, signal) {
  throwIfAborted(signal);
  const response = await fetch(transcriptionUrl, { signal });
  if (!response.ok) {
    const err = new Error(`拉取转写结果失败（HTTP ${response.status}）`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  const sentences = [];
  for (const transcript of data?.transcripts || []) {
    if (Number(transcript?.channel_id) !== 0) {
      continue;
    }
    for (const s of transcript?.sentences || []) {
      sentences.push(s);
    }
  }
  return normalizeSentences(sentences);
}

// 步骤 1：GET 上传凭证（getPolicy）。非 2xx 抛错，401/403 带「API Key 无效」指引。
async function requestUploadPolicy({ baseUrl, model, apiKey, signal }) {
  const url = `${baseUrl}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    },
    signal
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    if (response.status === 401 || response.status === 403) {
      const err = new Error(`API Key 无效或无权限（HTTP ${response.status}）${detail}`);
      err.status = response.status;
      throw err;
    }
    const err = new Error(`获取上传凭证失败（HTTP ${response.status}）${detail}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  return data?.data || null;
}

// 步骤 2：POST multipart 到 OSS upload_host（阿里云 OSS PostObject 表单）。
// 浏览器自动生成 boundary，绝不手动设 Content-Type。file 必须是最后一个表单域。
async function uploadWavToOss(policy, wavBlob, signal) {
  const key = `${policy.upload_dir}/${FILE_NAME}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", policy.oss_access_key_id || "");
  form.append("policy", policy.policy || "");
  form.append("Signature", policy.signature || "");
  form.append("key", key);
  form.append("x-oss-object-acl", policy.x_oss_object_acl || "");
  form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite || "");
  form.append("success_action_status", "200");
  form.append("file", wavBlob, FILE_NAME);

  const response = await fetch(policy.upload_host, {
    method: "POST",
    body: form,
    signal
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    const err = new Error(`上传音频到百炼临时存储失败（HTTP ${response.status}）${detail}`);
    err.status = response.status;
    throw err;
  }
  return `oss://${key}`;
}

// 步骤 4：提交异步转写任务。Body 为 { model, input: { file_urls: [fileUrl] } }，
// 必须带 X-DashScope-Async: enable 与 X-DashScope-OssResourceResolve: enable。
async function submitTranscription({ baseUrl, model, apiKey, fileUrl, signal }) {
  const response = await fetch(`${baseUrl}/api/v1/services/audio/asr/transcription`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
      "X-DashScope-OssResourceResolve": "enable"
    },
    body: JSON.stringify({ model, input: { file_urls: [fileUrl] } }),
    signal
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    const err = new Error(`提交转写任务失败（HTTP ${response.status}）${detail}`);
    err.status = response.status;
    throw err;
  }
  const data = await response.json();
  return data?.output?.task_id || "";
}

// 步骤 5：每 POLL_INTERVAL_MS 轮询任务状态。
// 轮询跳之间检查 signal：aborted 立即抛出中止错误，且不再发起新轮询请求
// （云端任务不取消，见文件头注释的取舍说明）。
// 返回 { taskStatus, results }；FAILED 时抛错，message 透出后台返回信息。
async function pollTaskStatus({ baseUrl, apiKey, taskId, signal, onProgress }) {
  let waitedSec = 0;
  while (true) {
    throwIfAborted(signal);
    const response = await fetch(`${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      const err = new Error(`查询转写任务失败（HTTP ${response.status}）${detail}`);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    const taskStatus = String(data?.output?.task_status || "");
    const results = Array.isArray(data?.output?.results) ? data.output.results : [];

    if (taskStatus === "SUCCEEDED") {
      return { taskStatus, results };
    }
    if (taskStatus === "FAILED") {
      // 后台 message / code 透出：优先子任务（results[]）的，其次顶层
      const message = firstFailureMessage(data?.output);
      const err = new Error(message || "转写任务失败（无错误信息）");
      err.taskStatus = "FAILED";
      throw err;
    }

    // PENDING / RUNNING / 其它未知状态：继续轮询，进度秒数递增
    waitedSec += currentPollInterval() / 1000;
    onProgress?.(`百炼任务处理中，已等待 ${Math.round(waitedSec)}s…`);
    await sleep(currentPollInterval());
  }
}

// 提取 FAILED 任务的错误信息：子任务 code/message → 顶层 code/message。
function firstFailureMessage(output) {
  for (const r of output?.results || []) {
    if (r?.subtask_status === "FAILED") {
      const parts = [r.code, r.message].filter((v) => typeof v === "string" && v.trim());
      if (parts.length > 0) {
        return `转写任务失败：${parts.join(": ")}`;
      }
    }
  }
  const parts = [output?.code, output?.message].filter((v) => typeof v === "string" && v.trim());
  if (parts.length > 0) {
    return `转写任务失败：${parts.join(": ")}`;
  }
  return "";
}

async function readErrorDetail(response) {
  try {
    const text = (await response.text()).trim();
    return text ? `: ${text.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

function currentPollInterval() {
  return activePollInterval !== null ? activePollInterval : POLL_INTERVAL_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 统一入口（spec 6.1 签名）。整段一次调用：startSec 恒为 0，无切片合并语义。
// 返回 { text: "", segments: [{ start, end, text }] }（秒）。
export async function transcribe({ wavBlob, startSec, durationSec, provider, signal, onProgress }) {
  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(provider?.model || "").trim();
  const apiKey = String(provider?.apiKey || "").trim();
  if (!baseUrl) {
    throw new Error("平台 baseUrl 未配置");
  }
  if (!model) {
    throw new Error("平台模型未配置");
  }
  if (!apiKey) {
    throw new Error("请填写 API Key");
  }

  // 1. getPolicy 授权（每次上传前重新取，凭证 300 秒有效）
  const policy = await requestUploadPolicy({ baseUrl, model, apiKey, signal });
  if (!policy || !policy.upload_host || !policy.upload_dir) {
    throw new Error("获取上传凭证失败：返回缺少 upload_host / upload_dir");
  }

  // 2. 上传 WAV 到 OSS 临时存储，换取 oss:// 文件 URL
  const fileUrl = await uploadWavToOss(policy, wavBlob, signal);

  // 4. 提交异步任务，拿 task_id
  const taskId = await submitTranscription({ baseUrl, model, apiKey, fileUrl, signal });
  if (!taskId) {
    throw new Error("提交转写任务失败：返回缺少 task_id");
  }

  // 5. 轮询至 SUCCEEDED / FAILED，成功后拉结果
  const { results } = await pollTaskStatus({ baseUrl, apiKey, taskId, signal, onProgress });
  const transcriptionUrl = results[0]?.transcription_url;
  if (!transcriptionUrl) {
    throw new Error("转写任务成功但缺少结果 URL");
  }
  const segments = await fetchTranscriptionResult(transcriptionUrl, signal);
  const text = segments.map((s) => s.text).join("");
  return { text, segments };
}
