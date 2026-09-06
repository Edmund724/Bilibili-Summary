export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


export function escapeYaml(value: unknown): string {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}


export function formatTimestamp(seconds: number | string, forSrt = false): string {
  const safe = Number(seconds) || 0;
  const msTotal = Math.max(0, Math.floor(safe * 1000));
  const hour = Math.floor(msTotal / 3600000);
  const minute = Math.floor((msTotal % 3600000) / 60000);
  const second = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  if (!forSrt) {
    return `${hh}:${mm}:${ss}.${String(ms).padStart(3, "0")}`;
  }

  return `${hh}:${mm}:${ss},${String(ms).padStart(3, "0")}`;
}


export function pushOptionalLines(targetLines: string[], extraLines: unknown): void {
  if (!Array.isArray(extraLines) || !extraLines.length) {
    return;
  }
  targetLines.push(...(extraLines as string[]));
}


export function resolveFrontmatterTemplateValue(
  value: unknown,
  templateContext: Record<string, unknown> = {}
): string {
  return String(value || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, rawKey: string) => {
    const key = String(rawKey || "").trim().toLowerCase();
    if (!key) {
      return "";
    }
    const resolved = templateContext[key];
    return resolved == null ? "" : String(resolved);
  });
}


export function parseFrontmatterArrayItems(value: unknown): string[] {
  return String(value || "")
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}


export function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
}
