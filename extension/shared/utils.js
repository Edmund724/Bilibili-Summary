// extension/shared/utils.js
// Small generic utilities (timing, dates) shared across ui / reader /
// bilibili / popup code. No Chrome APIs, no DOM.

export function sleep(ms) {
  return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}

export function formatLocalDate(value) {
  if (value === undefined) value = Date.now();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}
