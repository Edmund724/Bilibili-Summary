// eval/lib/model-filter.ts
// 启动模型过滤：用 GET /v1/models 的响应筛掉不在线的模型。
// 响应形状为 OpenAI 兼容的 { data: [{ id }] }；data 缺失或非数组视为空。

export function filterAvailableModels(
  modelsApiResponse: unknown,
  wanted: string[]
): string[] {
  if (modelsApiResponse == null || typeof modelsApiResponse !== "object") return [];
  const data = (modelsApiResponse as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const availableIds = new Set(
    data
      .map((entry) => (entry != null && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string")
  );

  return wanted.filter((model) => availableIds.has(model));
}
