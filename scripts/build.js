// 多入口构建 + dist/ 组装（候选5）。
//
// 职责与产物形态：
//   1. content 部分沿用 build-content.js（bootstrap IIFE + ESM 主包 + 动态
//      chunk），产物先落在 extension/entry/（dev load unpacked 直接用），
//      本脚本再把它们按源相对路径拷进 dist/。
//   2. 其余入口（SW）bundle 成单文件 + minify，无 code splitting：SW 不做
//      运行时惰性（ADR-0003），全静态图。offscreen 例外（见
//      buildOffscreenEntry）：AI / ASR 两族任务链动态 import 后开
//      splitting，常驻接线与动态 chunk 分文件落盘。
//      （digest-only-ui：options/popup 页面已随「侧边栏成为唯一界面」删除，
//      不再有扩展页面入口。）
//   3. CSS minify 到 dist 同相对路径。
//   4. 静态资源（manifest.json / html / icons）原样拷入；产物路径与源路径
//      完全一致，因此 html 与 manifest 零改写。
//   5. 校验：dist/manifest.json 合法 JSON 且引用路径全部存在；html 本地
//      引用存在；JS 产物按 ESM 语法自检。
//   6. 报表：content 常驻/按需沿用 build-content.js 口径（子进程直接打印）；
//      新增入口打印 raw（模块图源文件字节合计）-> minified 产物字节对比；
//      offscreen 额外按「常驻 wiring / 动态 chunk」两行口径输出拆分字节。
//
// 产物清单（dist/，整体 gitignore；只服务发布，日常开发不变）：
//   entry/background.js              SW 单文件 bundle
//   entry/offscreen.js               offscreen 常驻接线（splitting 主入口）
//   entry/offscreen-chunks/*.js      offscreen 动态 chunk（AI / ASR 两族按需）
//   entry/styles/reader.css           阅读表（运行时挂载，随阅读模式）
//   entry/styles/reader-gate.css      阅读表门控段（同上）
//   entry/styles/player-ai.css        播放器 AI 表（随 ai/player-ai.js chunk）
//   entry/content-bootstrap.iife.js  拷贝自 build-content.js 产物
//   entry/content-main.mjs           拷贝自 build-content.js 产物
//   entry/chunks/*.mjs               拷贝自 build-content.js 产物
//   entry/offscreen.html             原样拷贝
//   icons/*.png                      原样拷贝
//   manifest.json                    原样拷贝（零改写）
//   各 JS/CSS 产物伴随同名 .map        linked sourcemap（devtools 调试用；
//                                    release zip 由 build_release.py 剔除）

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { build, context } = require("esbuild");

// --watch（npm run dev）：首轮走与发布完全一致的全量构建 + 自检 + 报表，之后
// esbuild context 监听三个构建任务原地重建 dist/，content 部分拉起
// build-content.js --watch 子进程（产物落 extension/entry/，由下方 fs.watch
// 侦测后重拷进 dist/），静态资源（manifest/html/icons）变化同样重拷。watch
// 只做重建与拷贝，manifest/html 校验留给首轮全量构建。
const watchMode = process.argv.includes("--watch");

const root = path.join(__dirname, "..");
// 固定 cwd：metafile.inputs 的 key 是相对 esbuild 进程 cwd 的路径，固定后
// 报表与校验才能稳定解析。
process.chdir(root);

const extensionRoot = path.join(root, "extension");
const distDir = path.join(root, "dist");

// JS 入口：bundle + minify，单文件（无 splitting），产物路径 = 源相对路径。
// offscreen 入口不在此列——它开 splitting 拆动态 chunk（见 buildOffscreenEntry）。
const jsEntries = [
  "entry/background.ts",
];

// CSS minify 入口。S3 分层：content 样式全部按需挂载（reader/player-ai 各自
// 运行时 link 挂载，见 shared/style-injector），仍走 minify 保证 dist 无未压缩
// CSS。（digest-only-ui：常驻表 panel.css 已随经典侧栏面板删除。）
const cssEntries = [
  "entry/styles/reader.css",
  "entry/styles/reader-gate.css",
  "entry/styles/player-ai.css",
];

// 原样拷贝的文件（产物路径与源路径一致 → html/manifest 零改写）。
const copyFiles = [
  "manifest.json",
  "entry/offscreen.html",
  // content 构建产物（build-content.js 跑完后的最新产物；.map 为 linked
  // sourcemap，devtools 调试用，release zip 由 build_release.py 剔除）。
  "entry/content-bootstrap.iife.js",
  "entry/content-bootstrap.iife.js.map",
  "entry/content-main.mjs",
  "entry/content-main.mjs.map",
];

// 原样拷贝的目录（icons 资源；chunks/ 文件名带内容 hash，整目录拷）。
const copyDirs = ["icons", "entry/chunks"];

// background.js 体积守卫：防止 context-resolver / gateway / subtitle 等链重新
// 内联回 SW 包。阈值 = 落地后实测 minified 字节 ×1.1 向上取整到 KB。
const BACKGROUND_JS_MAX_KB = 35;

// 版本一致性守卫（与 build-content.js 同源逻辑提前到这里没必要——
// build-content.js 子进程内已做 manifest vs core/version.js 的守卫并会
// fail fast；这里不重复）。

// Guard: every resolved local (`./`/`../`) import must stay inside extension/.
// 与 build-content.js 的 localImportGuard 同一份逻辑（脚本未导出，故复制）；
// 只校验不改写路径。
const EXTENSION_ROOT_ABS = path.resolve(extensionRoot) + path.sep;
const localImportGuard = {
  name: "extension-local-import-guard",
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      if (resolved.startsWith(EXTENSION_ROOT_ABS)) return undefined;
      const relFromExtension = path.relative(extensionRoot, resolved);
      return {
        errors: [
          {
            text: `Import "${args.path}" in "${args.importer}" resolves to "${resolved}", ` +
              `which is outside extension/ (${relFromExtension || resolved}).`,
          },
        ],
      };
    });
  },
};

function cleanDist() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
}

// watch 重建日志（与 build-content.js 同款）：首轮 rebuild 由全量报表覆盖，
// 只在后续增量重建时各任务打一行；构建错误由 esbuild 自身输出。
const watchRebuildLog = {
  name: "watch-rebuild-log",
  setup(buildApi) {
    let first = true;
    buildApi.onEnd((result) => {
      if (first) {
        first = false;
        return;
      }
      if (result.errors.length > 0) return;
      console.log(`[watch] dist rebuilt at ${new Date().toLocaleTimeString()}`);
    });
  },
};

// 先跑 content 构建（bootstrap + ESM 主包 + chunks），保证拷进 dist 的是
// 最新产物；其字节报表由子进程直接打印，保持现有口径不变。
function runContentBuild() {
  execFileSync(process.execPath, [path.join(root, "scripts", "build-content.js")], {
    stdio: "inherit",
  });
}

function copyStaticAssets() {
  for (const rel of copyFiles) {
    const src = path.join(extensionRoot, rel);
    if (!fs.existsSync(src)) {
      console.error(`build.js: missing expected file: extension/${rel}`);
      process.exit(1);
    }
    const dest = path.join(distDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  for (const dir of copyDirs) {
    const src = path.join(extensionRoot, dir);
    if (!fs.existsSync(src)) {
      console.error(`build.js: missing expected directory: extension/${dir}`);
      process.exit(1);
    }
    copyDirRecursive(src, path.join(distDir, dir));
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// JS 入口统一 bundle：format esm（源即 ESM，manifest background.type=module、
// 页面 script type=module，产物路径与源一致 → 零改写）；不 splitting，动态
// import 的本地模块会被内联进同一文件（SW 全静态图，ADR-0003 的预期形态）。
// sourcemap 恒开（linked external，非 inline/eval——扩展 CSP 禁 eval）。
function restJsOptions() {
  return {
    entryPoints: jsEntries.map((rel) => path.join(extensionRoot, rel)),
    outbase: extensionRoot,
    outdir: distDir,
    bundle: true,
    splitting: false,
    format: "esm",
    platform: "browser",
    minify: true,
    sourcemap: true,
    target: "chrome120",
    metafile: true,
    logLevel: "warning",
    plugins: [localImportGuard],
  };
}

// offscreen 入口：开 splitting（format esm）。源里 AI 族（../ai/ladder.js）
// 与 ASR 族（./offscreen-asr.js）两条任务链是动态 import()，esbuild 把它们
// 拆成独立 chunk，dist/entry/offscreen.js 只剩常驻接线，首次用到某族时才
// 加载对应 chunk（offscreen 是页面环境，动态 import 合法；ADR-0003 只约束
// SW，background 仍走上方无 splitting 构建）。chunkNames 用
// entry/offscreen-chunks/ 与 content 产物的 entry/chunks/ 区分（两者同在
// dist/entry/ 下，避免混淆）；chunk 由 esbuild 直接写进 dist，无需拷贝。
function offscreenOptions() {
  return {
    entryPoints: [path.join(extensionRoot, "entry/offscreen.ts")],
    outbase: extensionRoot,
    outdir: distDir,
    bundle: true,
    splitting: true,
    format: "esm",
    chunkNames: "entry/offscreen-chunks/[name]-[hash]",
    platform: "browser",
    minify: true,
    sourcemap: true,
    target: "chrome120",
    metafile: true,
    logLevel: "warning",
    plugins: [localImportGuard],
  };
}

// CSS minify：@import 会内联，产物落 dist 同相对路径。
function cssOptions() {
  return {
    entryPoints: cssEntries.map((rel) => path.join(extensionRoot, rel)),
    outbase: extensionRoot,
    outdir: distDir,
    bundle: true,
    minify: true,
    sourcemap: true,
    metafile: true,
    logLevel: "warning",
    plugins: [localImportGuard],
  };
}

// 语法自检：dist 产物按 ESM 解析（node --check 对 .js 文件会按最近
// package.json 的 type 决定解析模式，dist/ 下无 package.json 会误按 CJS，
// 因此用 --input-type=module 从 stdin 读）。
function syntaxCheckEsm(file) {
  execFileSync(process.execPath, ["--input-type=module", "--check"], {
    input: fs.readFileSync(file),
    stdio: ["pipe", "ignore", "inherit"],
  });
}

// dist/manifest.json 校验：合法 JSON（readFileSync + JSON.parse 本身即断言）
// 且引用的每个路径在 dist/ 下存在；WAR 的 "entry/chunks/*" 通配按
// 「dist 内至少一个文件匹配」校验。
function assertManifestReferences() {
  const manifestPath = path.join(distDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`build.js: dist/manifest.json is not valid JSON: ${error.message}`);
    process.exit(1);
  }

  const distFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else distFiles.push(path.relative(distDir, full).split(path.sep).join("/"));
    }
  })(distDir);

  const refs = [];
  if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);

  // S2 收紧 host_permissions：通配符只允许出现在 optional_host_permissions
  // （常驻权限只剩 B 站三条；AI/ASR 平台域名按需申请，见
  // core/host-permissions.js）。用 http://*/* 或 https://*/* 兜底会导致
  // Chrome Web Store 审核挑战项复现，在此 fail fast。
  const wildcardHostPatterns = ["http://*/*", "https://*/*"];
  const residentWildcards = (manifest.host_permissions || []).filter((p) => wildcardHostPatterns.includes(p));
  if (residentWildcards.length > 0) {
    console.error(
      `build.js: manifest host_permissions 含通配符 ${residentWildcards.join(", ")}，` +
        `必须移入 optional_host_permissions（按需申请）`
    );
    process.exit(1);
  }

  for (const p of Object.values(manifest.icons ?? {})) refs.push(p);
  if (manifest.action?.default_popup) refs.push(manifest.action.default_popup);
  for (const p of Object.values(manifest.action?.default_icon ?? {})) refs.push(p);
  if (manifest.options_page) refs.push(manifest.options_page);
  for (const cs of manifest.content_scripts ?? []) {
    refs.push(...(cs.js ?? []), ...(cs.css ?? []));
  }
  for (const war of manifest.web_accessible_resources ?? []) {
    refs.push(...(war.resources ?? []));
  }

  const missing = [];
  for (const ref of refs) {
    if (ref.includes("*")) {
      const re = new RegExp("^" + ref.split("*").map(escapeRegExp).join(".*") + "$");
      if (!distFiles.some((f) => re.test(f))) missing.push(ref);
    } else if (!distFiles.includes(ref)) {
      missing.push(ref);
    }
  }
  if (missing.length > 0) {
    console.error(
      `build.js: dist/manifest.json references missing files:\n` +
        missing.map((m) => `  - ${m}`).join("\n")
    );
    process.exit(1);
  }
  return refs;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// background.js 体积守卫：minified 产物字节数超过上限时 fail fast，防止
// context-resolver / gateway / subtitle 等链意外重新内联回 SW 包。
function assertBackgroundBundleSize() {
  const backgroundPath = path.join(distDir, "entry", "background.js");
  const bytes = fs.statSync(backgroundPath).size;
  const maxBytes = BACKGROUND_JS_MAX_KB * 1024;
  if (bytes > maxBytes) {
    console.error(
      `build.js: dist/entry/background.js 体积为 ${bytes} B (${(bytes / 1024).toFixed(1)} KB)，` +
        `超过上限 ${BACKGROUND_JS_MAX_KB} KB（${maxBytes} B）`
    );
    process.exit(1);
  }
}

// html 本地引用校验（src/href，排除外链与锚点），保证 dist 内页面资源闭合。
function assertHtmlReferences() {
  const htmlFiles = copyFiles.filter((f) => f.endsWith(".html"));
  const missing = [];
  for (const rel of htmlFiles) {
    const text = fs.readFileSync(path.join(distDir, rel), "utf8");
    const baseDir = path.dirname(path.join(distDir, rel));
    for (const match of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = match[1];
      if (/^(https?:)?\/\//.test(ref) || ref.startsWith("#") || ref.startsWith("data:")) {
        continue;
      }
      const resolved = path.relative(distDir, path.resolve(baseDir, ref)).split(path.sep).join("/");
      if (!fs.existsSync(path.join(distDir, resolved))) {
        missing.push(`${rel} -> ${ref}`);
      }
    }
  }
  if (missing.length > 0) {
    console.error(
      `build.js: dist html files reference missing files:\n` +
        missing.map((m) => `  - ${m}`).join("\n")
    );
    process.exit(1);
  }
}

// 字节报表：raw = 模块图源文件磁盘字节合计（metafile.inputs 列表逐个 stat），
// min = minified 产物字节。这是后续验收口径，输出保持固定列与固定顺序。
function formatBytes(n) {
  return `${String(n).padStart(7)} B`;
}

// 单个 output 的 raw：其模块图 inputs 的源文件字节合计。
function sumRawBytes(meta) {
  return Object.keys(meta.inputs).reduce(
    (sum, input) => sum + fs.statSync(path.resolve(root, input)).size,
    0
  );
}

function printEntryReport(result, label) {
  const outputs = Object.entries(result.metafile.outputs)
    .filter(([file]) => !file.endsWith(".map"));
  console.log(`== ${label} ==`);
  let totalRaw = 0;
  let totalMin = 0;
  for (const [outfile, meta] of outputs) {
    const raw = sumRawBytes(meta);
    const min = meta.bytes;
    const ratio = raw > 0 ? `-${((1 - min / raw) * 100).toFixed(1)}%` : "n/a";
    const relOut = path.relative(root, path.resolve(root, outfile));
    console.log(
      `${relOut.padEnd(34)} raw ${formatBytes(raw).padEnd(12)} -> min ${formatBytes(min).padEnd(12)} (${ratio})`
    );
    totalRaw += raw;
    totalMin += min;
  }
  const ratio = totalRaw > 0 ? `-${((1 - totalMin / totalRaw) * 100).toFixed(1)}%` : "n/a";
  console.log(
    `${"subtotal".padEnd(34)} raw ${formatBytes(totalRaw).padEnd(12)} -> min ${formatBytes(totalMin).padEnd(12)} (${ratio})`
  );
  return { totalRaw, totalMin };
}

// offscreen 拆分报表：产物分「常驻 wiring」（entry/offscreen.js）与「动态
// chunk」（entry/offscreen-chunks/*，AI / ASR 两族按需装载）两个口径各一行，
// 列格式与上方入口报表对齐。esbuild splitting 后每个 output 的 inputs 互不
// 重叠（共享模块归入共享 chunk），两行 raw 相加即 offscreen 全量源图字节。
function printOffscreenSplitReport(result) {
  const outputs = Object.entries(result.metafile.outputs)
    .filter(([file]) => !file.endsWith(".map"));
  let entryRaw = 0;
  let entryMin = 0;
  let chunkRaw = 0;
  let chunkMin = 0;
  let chunkCount = 0;
  for (const [outfile, meta] of outputs) {
    const raw = sumRawBytes(meta);
    const min = meta.bytes;
    if (path.basename(outfile) === "offscreen.js") {
      entryRaw = raw;
      entryMin = min;
    } else {
      chunkRaw += raw;
      chunkMin += min;
      chunkCount += 1;
    }
  }
  console.log("== offscreen 拆分（dist/entry，splitting） ==");
  console.log(
    `${"  entry/offscreen.js（常驻 wiring）".padEnd(38)} raw ${formatBytes(entryRaw).padEnd(12)} -> min ${formatBytes(entryMin).padEnd(12)}`
  );
  console.log(
    `${`  entry/offscreen-chunks/*（动态 x${chunkCount}）`.padEnd(38)} raw ${formatBytes(chunkRaw).padEnd(12)} -> min ${formatBytes(chunkMin).padEnd(12)}`
  );
  return { entryRaw, entryMin, chunkRaw, chunkMin, chunkCount };
}

function printDistSummary() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  })(distDir);
  const total = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  console.log(`== dist 总量 ==`);
  console.log(`files: ${files.length}, bytes: ${total} B (${(total / 1024).toFixed(1)} KB)`);
}

async function main() {
  cleanDist();
  runContentBuild();
  copyStaticAssets();

  const jobOptions = [restJsOptions(), offscreenOptions(), cssOptions()];
  let jsResult, offscreenResult, cssResult;
  let esbuildContexts = null;
  if (watchMode) {
    esbuildContexts = await Promise.all(
      jobOptions.map((opts) => context({ ...opts, plugins: [...opts.plugins, watchRebuildLog] }))
    );
    [jsResult, offscreenResult, cssResult] = await Promise.all(
      esbuildContexts.map((ctx) => ctx.rebuild())
    );
  } else {
    [jsResult, offscreenResult, cssResult] = await Promise.all(
      jobOptions.map((opts) => build(opts))
    );
  }

  // 自检：JS 产物按 ESM 语法过一遍（offscreen 动态 chunk 也是 ESM 产物，
  // 一并检查）；manifest 与 html 引用闭合。
  const outputs = [jsResult, offscreenResult]
    .flatMap((result) => Object.keys(result.metafile.outputs))
    .filter((f) => f.endsWith(".js") || f.endsWith(".ts"));
  for (const outfile of outputs) {
    syntaxCheckEsm(path.resolve(root, outfile));
  }
  assertManifestReferences();
  assertHtmlReferences();
  assertBackgroundBundleSize();

  // offscreen 拆分守卫：常驻文件必须仍含动态 import( 且至少产出一个动态
  // chunk——防止未来依赖变化把动态图又内联回单文件而无人察觉。
  const offscreenDist = fs.readFileSync(path.join(distDir, "entry", "offscreen.js"), "utf8");
  if (!offscreenDist.includes("import(")) {
    console.error("build.js: dist/entry/offscreen.js 不含动态 import(，offscreen splitting 失效");
    process.exit(1);
  }

  console.log("");
  printEntryReport(jsResult, "多入口 bundle（dist/，单文件、无 splitting）");
  console.log("");
  const offscreenSplit = printOffscreenSplitReport(offscreenResult);
  if (offscreenSplit.chunkCount === 0) {
    console.error("build.js: offscreen splitting 未产出任何动态 chunk");
    process.exit(1);
  }
  console.log("");
  printEntryReport(cssResult, "CSS minify（dist/）");
  console.log("");
  printDistSummary();
  console.log("");
  console.log(`dist/ assembled at ${distDir}`);

  if (watchMode) {
    await startWatch(esbuildContexts);
  }
}

// watch 模式收尾：esbuild context 监听三个构建任务；content 产物由
// build-content.js --watch 子进程重建（落 extension/entry/），连同静态资源
// 一起由 fs.watch 侦测后重拷进 dist/。重拷统一走 copyStaticAssets() 全量
// （幂等、文件少），150ms 去抖等 esbuild 同轮多个产物写入落盘。
async function startWatch(esbuildContexts) {
  const child = spawn(
    process.execPath,
    [path.join(root, "scripts", "build-content.js"), "--watch"],
    { stdio: "inherit" }
  );
  // SIGINT/SIGTERM 默认终止不触发 "exit" 事件，必须显式监听才能把
  // build-content 子进程一起带走，否则会残留孤儿 watch 进程。
  const shutdown = () => {
    child.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => child.kill());

  let recopyTimer = null;
  const scheduleRecopy = () => {
    if (recopyTimer) clearTimeout(recopyTimer);
    recopyTimer = setTimeout(() => {
      recopyTimer = null;
      copyStaticAssets();
      console.log(`[watch] static/content assets re-copied at ${new Date().toLocaleTimeString()}`);
    }, 150);
  };

  fs.watch(extensionRoot, (event, filename) => {
    if (filename === "manifest.json") scheduleRecopy();
  });
  for (const dir of copyDirs) {
    fs.watch(path.join(extensionRoot, dir), scheduleRecopy);
  }
  fs.watch(path.join(extensionRoot, "pages"), (event, filename) => {
    if (filename && copyFiles.includes(`pages/${filename}`)) scheduleRecopy();
  });
  fs.watch(path.join(extensionRoot, "entry"), (event, filename) => {
    if (filename && copyFiles.includes(`entry/${filename}`)) scheduleRecopy();
  });

  await Promise.all(esbuildContexts.map((ctx) => ctx.watch()));
  console.log("[watch] watching for changes... (load dist/ unpacked; reload the extension after rebuilds)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
