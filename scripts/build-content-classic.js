const fs = require("fs");
const path = require("path");

const root = path.resolve(path.dirname(__filename), "..");
const extDir = path.join(root, "extension");

const entries = [
  path.join(extDir, "shared-defaults.js"),
  path.join(extDir, "content.js"),
];

const outputPath = path.join(extDir, "content-classic.js");

function getImports(filePath) {
  const code = fs.readFileSync(filePath, "utf8");
  const regex = /import\s+[\s\S]*?from\s+['"]([^'"]+)['"];?/g;
  const imports = [];
  let m;
  while ((m = regex.exec(code))) {
    const spec = m[1];
    if (!spec.startsWith("./")) continue;
    const resolved = path.resolve(path.dirname(filePath), spec);
    if (fs.existsSync(resolved)) imports.push(resolved);
  }
  return imports;
}

const seen = new Set();
const ordered = [];

function walk(filePath) {
  if (seen.has(filePath)) return;
  seen.add(filePath);
  for (const imp of getImports(filePath)) {
    walk(imp);
  }
  ordered.push(filePath);
}

for (const entry of entries) {
  walk(entry);
}

const declared = new Set();

function stripExports(code) {
  return code.replace(/^export /gm, "");
}

function stripImports(code) {
  return code.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, "");
}

function isDeclarationLine(line) {
  return /^\s*(?:const|let|var|function|class)\s+[A-Za-z_$]/.test(line);
}

function scanBraceDepth(lines, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    let inStr = false, strCh = "";
    let inLineComment = false, inBlockComment = false;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
      if (inBlockComment) { if (ch === "*" && line[k + 1] === "/") { inBlockComment = false; k++; } continue; }
      if (inStr) { if (ch === "\\") k++; else if (ch === strCh) inStr = false; continue; }
      if (ch === "/" && line[k + 1] === "/") { inLineComment = true; k++; continue; }
      if (ch === "/" && line[k + 1] === "*") { inBlockComment = true; k++; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strCh = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth <= 0) break;
  }
  return depth;
}

function extractTopLevelNames(source) {
  const names = new Set();
  const lines = source.split("\n");
  let braceDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (braceDepth === 0 && isDeclarationLine(line)) {
      const match = line.match(/^\s*(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (match) names.add(match[1]);
    }
    let inStr = false, strCh = "";
    let inLineComment = false, inBlockComment = false;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
      if (inBlockComment) { if (ch === "*" && line[k + 1] === "/") { inBlockComment = false; k++; } continue; }
      if (inStr) { if (ch === "\\") k++; else if (ch === strCh) inStr = false; continue; }
      if (ch === "/" && line[k + 1] === "/") { inLineComment = true; k++; continue; }
      if (ch === "/" && line[k + 1] === "*") { inBlockComment = true; k++; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strCh = ch; continue; }
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
    }
  }
  return names;
}

function skipBlock(lines, startIdx, startDepth) {
  let depth = startDepth;
  let foundBrace = false;
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    let inStr = false, strCh = "";
    let inLineComment = false, inBlockComment = false;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
      if (inBlockComment) { if (ch === "*" && line[k + 1] === "/") { inBlockComment = false; k++; } continue; }
      if (inStr) { if (ch === "\\") k++; else if (ch === strCh) inStr = false; continue; }
      if (ch === "/" && line[k + 1] === "/") { inLineComment = true; k++; continue; }
      if (ch === "/" && line[k + 1] === "*") { inBlockComment = true; k++; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strCh = ch; continue; }
      if (ch === "{") { depth++; foundBrace = true; }
      else if (ch === "}") {
        depth--;
        if (depth < startDepth) {
          return i + 1;
        }
      }
    }
    i++;
  }
  return i;
}

function skipConstBlock(lines, startIdx, startDepth) {
  let depth = startDepth;
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    let inStr = false, strCh = "";
    let inLineComment = false, inBlockComment = false;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
      if (inBlockComment) { if (ch === "*" && line[k + 1] === "/") { inBlockComment = false; k++; } continue; }
      if (inStr) { if (ch === "\\") k++; else if (ch === strCh) inStr = false; continue; }
      if (ch === "/" && line[k + 1] === "/") { inLineComment = true; k++; continue; }
      if (ch === "/" && line[k + 1] === "*") { inBlockComment = true; k++; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strCh = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ";" && depth === startDepth) {
        return i + 1;
      }
    }
    i++;
  }
  return i;
}

function removeTopLevelBlocks(source, names) {
  if (!names.size) return source;
  const lines = source.split("\n");
  const result = [];
  let braceDepth = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (braceDepth === 0 && isDeclarationLine(line)) {
      const match = line.match(/^\s*(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (match && names.has(match[1])) {
        if (/^\s*(?:function|class)\b/.test(line)) {
          i = skipBlock(lines, i, braceDepth);
        } else {
          i = skipConstBlock(lines, i, braceDepth);
        }
        continue;
      }
    }
    result.push(line);
    let inStr = false, strCh = "";
    let inLineComment = false, inBlockComment = false;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
      if (inBlockComment) { if (ch === "*" && line[k + 1] === "/") { inBlockComment = false; k++; } continue; }
      if (inStr) { if (ch === "\\") k++; else if (ch === strCh) inStr = false; continue; }
      if (ch === "/" && line[k + 1] === "/") { inLineComment = true; k++; continue; }
      if (ch === "/" && line[k + 1] === "*") { inBlockComment = true; k++; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strCh = ch; continue; }
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
    }
    i++;
  }
  return result.join("\n");
}

function processSource(source) {
  let processed = stripExports(stripImports(source));
  const topLevelNames = extractTopLevelNames(processed);
  const duplicates = new Set([...topLevelNames].filter((n) => declared.has(n)));
  if (duplicates.size) {
    processed = removeTopLevelBlocks(processed, duplicates);
  }
  const newNames = extractTopLevelNames(processed);
  for (const name of newNames) {
    declared.add(name);
  }
  return processed;
}

const banner = [
  "// === GENERATED FILE ===",
  "// Source: extension/shared-defaults.js + extension/content.js",
  "// Build:   node scripts/build-content-classic.js",
  "// Do not edit this file directly; edit the source files instead.",
  "// =======================",
  ""
].join("\n");

const parts = ordered.map((file) => {
  const source = fs.readFileSync(file, "utf8");
  const processed = processSource(source);
  const rel = path.relative(extDir, file).replace(/\\/g, "/");
  return `// === ${rel} ===\n${processed.trim()}`;
});

fs.writeFileSync(outputPath, `${banner}${parts.join("\n\n")}\n`, "utf8");
console.log(`Wrote ${outputPath}`);