// 「原始字幕段按需检索」模块：追问命中时间戳 / 章节名 / 关键词时，从原始字幕段
// （04 缓存、与 03 plan.segments 同构的 { index, from, to, items:[{from,to,content}] }）
// 中按需挑出命中的段原样返回，供集成步骤把 items 渲染成注入文本；全部未命中返回 []，
// 维持压缩摘要上下文，不额外取段（对齐 ADR-0001 的追问注入策略）。
// 纯函数、无 side effect、不碰 chrome/DOM、不发请求；加载原始段是集成步骤的职责，
// 本模块只做「给定原始段后的匹配」，故不依赖 segment-cache.js。

// 停用词：中文功能词 / 口语提问高频词，关键词命中时过滤并兼作伪分词切分点，避免泛词误命中。
const STOP_WORDS = [
  "的", "了", "吗", "呢", "啊", "吧", "是", "在", "和", "与", "及", "或",
  "这", "那", "哪", "你", "我", "他", "她", "它", "们", "个", "就", "都",
  "而", "之", "其", "于", "也", "很", "不", "没", "啥", "么", "哦", "嗯",
  "哈", "请", "问", "讲", "说", "看", "想", "要", "会", "能",
  "什么", "怎么", "为什么", "如何", "怎样", "请问", "一下", "介绍", "解释",
  "讲解", "意思", "内容", "知道", "了解", "谢谢", "回答", "讲讲", "说说",
  "还有", "然后", "其实", "因为", "所以", "如果", "但是", "就是", "可以",
  "需要", "应该", "这个", "那个", "哪些", "哪个"
];
const STOP_WORDS_SET = new Set(STOP_WORDS);
// 伪分词切分正则：长词优先（如「讲解」先于「讲」），用捕获组保留停用词以便过滤。
const STOP_SPLIT_RE = new RegExp(
  `(${[...STOP_WORDS].sort((a, b) => b.length - a.length).join("|")})`,
  "g"
);

// 匹配用规整：小写 + 去空白 + 去标点/符号（中日文标点、ASCII 标点、符号均去除）。
function normalizeForMatch(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}

/**
 * 把用户文本里出现的 `MM:SS` / `HH:MM:SS` / `H:MM:SS` 解析成秒。
 * 格式对齐 formatCompactTimestamp（<1h 用 MM:SS，≥1h 用 HH:MM:SS）；
 * 拒绝明显非时间：MM/SS < 60、HH < 24（比分「2:0」因秒段必须两位也不匹配）。
 * 返回升序去重的 number[]；无命中 → []。永不抛错。
 */
export function parseTimestampSeconds(text) {
  try {
    const s = String(text == null ? "" : text);
    const out = [];
    const seen = new Set();
    for (const match of s.matchAll(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g)) {
      const parts = match[0].split(":").map(Number);
      const three = parts.length === 3;
      const hh = three ? parts[0] : 0;
      const mm = three ? parts[1] : parts[0];
      const ss = three ? parts[2] : parts[1];
      if (hh >= 24 || mm >= 60 || ss >= 60) continue;
      const seconds = hh * 3600 + mm * 60 + ss;
      if (!seen.has(seconds)) {
        seen.add(seconds);
        out.push(seconds);
      }
    }
    return out.sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * 章节名命中：prompt 规整后包含某章节 title（忽略大小写、去空白、去标点）即命中。
 * 返回命中的 chapters 项数组（原样引用输入元素）；空/无效输入 → []。永不抛错。
 */
export function matchChapterByTitle(prompt, chapters) {
  try {
    const needle = normalizeForMatch(prompt);
    if (!needle || !Array.isArray(chapters)) return [];
    const hits = [];
    for (const chapter of chapters) {
      if (!chapter || typeof chapter !== "object") continue;
      const title = normalizeForMatch(chapter.title);
      if (!title) continue;
      if (needle.includes(title)) hits.push(chapter);
    }
    return hits;
  } catch {
    return [];
  }
}

// 从规整后的 prompt 里抽检索词：拉丁/数字词（≥2 字符，避免单字母噪声）+
// CJK 连续段按停用词伪分词出的内容块；全被过滤且 prompt 很短时回退用 prompt 整体。
function extractKeywordNeedles(normalizedText) {
  const needles = [];
  const latin = normalizedText.match(/[a-z0-9]{2,}/g);
  if (latin) needles.push(...latin);

  const cjkOnly = normalizedText.replace(/[a-z0-9]+/g, "");
  for (const piece of cjkOnly.split(STOP_SPLIT_RE)) {
    if (piece && !STOP_WORDS_SET.has(piece)) needles.push(piece);
  }

  const unique = [...new Set(needles)];
  if (unique.length > 0) return unique;
  // prompt 很短（无有效内容词）→ 把 prompt 整体作为检索词。
  if (normalizedText.length >= 2 && normalizedText.length <= 16) return [normalizedText];
  return [];
}

/**
 * 关键词命中：prompt 去标点/伪分词后，某段 items 的 content 拼接文本包含任一非停用词
 * （或 prompt 很短时包含 prompt 整体）即命中该段。返回命中的段数组（原样引用）。
 * 空/无效输入 → []。永不抛错。
 */
export function matchByKeyword(prompt, rawSegments) {
  try {
    if (!Array.isArray(rawSegments) || rawSegments.length === 0) return [];
    const normalized = normalizeForMatch(prompt);
    if (!normalized) return [];
    const needles = extractKeywordNeedles(normalized);
    if (needles.length === 0) return [];
    const hits = [];
    for (const seg of rawSegments) {
      if (!seg || typeof seg !== "object") continue;
      const items = Array.isArray(seg.items) ? seg.items : [];
      const segText = normalizeForMatch(
        items.map((item) => (item && item.content != null ? item.content : "")).join(" ")
      );
      if (!segText) continue;
      if (needles.some((needle) => needle && segText.includes(needle))) hits.push(seg);
    }
    return hits;
  } catch {
    return [];
  }
}

// 命中段去重（按输入数组下标升序返回，保持原样引用）。
function dedupeByIndex(segs, indices) {
  return [...new Set(indices)].sort((a, b) => a - b).map((i) => segs[i]);
}

/**
 * 按需检索入口：按优先级 时间戳 → 章节名 → 关键词 返回命中的原始字幕段
 * （原样引用输入数组元素）；全部未命中 → []（维持压缩上下文，不额外取段）。
 * 段结构 { index, from, to, items }，from/to 为秒；匹配规则：
 *   1. 时间戳命中：任一命中秒 t 满足 from <= t < to 的段都取。
 *   2. 章节名命中：落在命中章节 [from,to) 内的段（按段 from 区间找回）。
 *   3. 关键词命中：段 items 的 content 拼接文本包含任一非停用词。
 * 永不抛错（含空 prompt / 空段 / 空章节 / 非数组输入）。
 */
export function retrieveRawSegments({ prompt = "", chapters = [], rawSegments = [] } = {}) {
  try {
    const text = String(prompt == null ? "" : prompt);
    const segs = Array.isArray(rawSegments) ? rawSegments : [];
    const chs = Array.isArray(chapters) ? chapters : [];
    if (!text.trim() || segs.length === 0) return [];

    // 1. 时间戳命中。
    const stamps = parseTimestampSeconds(text);
    if (stamps.length > 0) {
      const indices = [];
      for (const t of stamps) {
        for (let i = 0; i < segs.length; i++) {
          const from = Number(segs[i]?.from);
          const to = Number(segs[i]?.to);
          if (Number.isFinite(from) && Number.isFinite(to) && from <= t && t < to) indices.push(i);
        }
      }
      if (indices.length > 0) return dedupeByIndex(segs, indices);
    }

    // 2. 章节名命中。
    const matchedChapters = matchChapterByTitle(text, chs);
    if (matchedChapters.length > 0) {
      const indices = [];
      for (const chapter of matchedChapters) {
        const cf = Number(chapter?.from);
        const ct = Number(chapter?.to);
        if (!Number.isFinite(cf) || !Number.isFinite(ct)) continue;
        for (let i = 0; i < segs.length; i++) {
          const from = Number(segs[i]?.from);
          if (Number.isFinite(from) && from >= cf && from < ct) indices.push(i);
        }
      }
      if (indices.length > 0) return dedupeByIndex(segs, indices);
    }

    // 3. 关键词命中。
    return matchByKeyword(text, segs);
  } catch {
    return [];
  }
}
