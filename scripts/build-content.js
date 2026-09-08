// Content script 构建脚本（两轮构建，常驻图合拢为单文件主包）。
//
// 产物形态：极小 classic bootstrap + 单文件 ESM 主包 + 轮 B 懒加载 chunk 区。
// 为什么不能继续单文件 IIFE：classic content script 里动态 import()
// 的相对路径按页面 origin 解析（Chromium 既定行为），分包后必须由 bootstrap
// 用 chrome.runtime.getURL 的绝对路径拉起 ESM 主包，主包模块图内相对路径的
// 动态 import 才会按扩展自身 URL 解析（WXT 同款方案）。
//
// 两轮构建（arch-review-2026-09/06）：单轮 splitting 会把「常驻可达 + 动态
// 子树也可达」的共享模块逐个提升成静态 chunk，常驻图碎成
// bootstrap + main + 一串静态 chunk（17+ 次串行模块请求）。合拢为 2 请求：
//   轮 B（懒加载区）：动态 import 站点指向的全部目标模块作 entryPoints，
//     splitting:true 出动态 chunk（共享代码在轮内自动提升去重）。
//   轮 A（常驻区）：entry/content.ts 单独一轮 splitting:false，onResolve
//     插件把懒加载目标 resolve 成轮 B 产物路径并 external——常驻图整体
//     内联进一个 content-main.mjs，动态边保持真 import()。
// 代价（已接受）：常驻底座在轮 B 懒 chunk 区重复一份——本地资源按需读取，
// 无网络成本。
//
// 产物清单（均 gitignore）：
//   entry/content-bootstrap.iife.js  经典 IIFE，manifest.content_scripts 指向它
//   entry/content-main.mjs           ESM 主包（轮 A：常驻图单文件）
//   entry/chunks/<lazy>.mjs          轮 B 懒加载目标产物（按需）
//   entry/chunks/chunk-<hash>.mjs    轮 B 共享 chunk（按需）
//   各产物同名 .map                  linked sourcemap（devtools 调试用；release
//                                    zip 由 build_release.py 剔除）
//
// web_accessible_resources 必须覆盖 content-main.mjs 与 chunks/*（见
// extension/manifest.json），否则页面上下文里的 bootstrap 无权拉取模块。

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { build, context } = require("esbuild");

// --watch：esbuild context 常驻监听，供 build.js --watch（npm run dev）以子进程
// 方式拉起；首轮仍跑全量自检与报表，之后每次重建只打一行日志。
const watchMode = process.argv.includes("--watch");

const extensionRoot = path.join(__dirname, "..", "extension");
const entry = path.join(extensionRoot, "entry", "content.ts");
const bootstrapEntry = path.join(extensionRoot, "entry", "content-bootstrap.ts");
const outDir = path.join(extensionRoot, "entry");
const mainOutfile = path.join(outDir, "content-main.mjs");
const bootstrapOutfile = path.join(outDir, "content-bootstrap.iife.js");
const chunksDir = path.join(outDir, "chunks");
// 分包前的单文件产物（已废弃）：构建前清掉，避免它混进 release zip。
const legacyOutfile = path.join(outDir, "content-classic.js");

// 懒加载目标清单：extension/ 内全部动态 import() 站点指向的模块（lazy-*
// 包装器、settings-panel、lifecycle、explain-card、subtitle/fetcher、
// message-handler、overview 的 import() 落点）。name 同时决定轮 B 产物文件名
// （chunks/<name>.mjs），轮 A 的 external 路径必须与之逐字一致。
const lazyTargets = [
  { name: "player-ai", source: "ai/player-ai.ts" },
  { name: "digest-button", source: "ui/digest-button.ts" },
  { name: "ui-renderer", source: "ui/ui-renderer.ts" },
  { name: "reader", source: "reader/index.ts" },
  { name: "chat-tab", source: "reader/chat-tab.ts" },
  { name: "presentation", source: "reader/presentation.ts" },
  { name: "shell", source: "reader/shell.ts" },
  { name: "fetcher", source: "subtitle/fetcher.ts" },
  { name: "ui", source: "subtitle/ui.ts" },
  { name: "gateway", source: "bilibili/gateway.ts" },
  { name: "video-probe", source: "bilibili/video-probe.ts" },
  { name: "settings-panel", source: "ui/settings-panel.ts" },
  { name: "provider-editor", source: "ui/provider-editor.ts" },
  { name: "explain", source: "ai/explain.ts" },
  { name: "pipeline", source: "asr/pipeline.ts" },
  { name: "fallback", source: "asr/fallback.ts" },
  { name: "analysis", source: "ai/analysis.ts" },
];
// 轮 A 的 external 路径表：源文件绝对路径 → 轮 B 产物相对 content-main.mjs
// 的路径（主包在 entry/、轮 B 产物在 entry/chunks/）。
const lazyTargetExternals = new Map(
  lazyTargets.map(({ name, source }) => [
    path.join(extensionRoot, source),
    `./chunks/${name}.mjs`,
  ])
);

// Version-consistency guard: fail fast before invoking esbuild if the
// BOC_VERSION literal in extension/core/defaults.js drifts from
// manifest.json's "version". This guards the runtime probe that compares
// __BOC_CONTENT_SCRIPT_LOADED__ (bootstrap 写入) against
// chrome.runtime.getManifest().version.
const manifestPath = path.join(__dirname, "..", "extension", "manifest.json");
// 版本实体在 core/version.ts（bootstrap 专用拆分，defaults.ts re-export）；
// defaults.ts 若丢了 re-export，主包构建会因 content.ts 的 import 失败而报错，
// 天然兜底。
const versionTsPath = path.join(__dirname, "..", "extension", "core", "version.ts");

const manifestVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
const versionTsText = fs.readFileSync(versionTsPath, "utf8");
const versionTsMatch = /export const BOC_VERSION = "([^"]+)"/.exec(versionTsText);
const versionTsVersion = versionTsMatch ? versionTsMatch[1] : null;

if (!versionTsVersion || versionTsVersion !== manifestVersion) {
  console.error(
    `Version mismatch: ${manifestPath} has "version": ${manifestVersion}, ` +
      `but ${versionTsPath} declares BOC_VERSION = ${versionTsVersion ?? "(unparseable)"}`
  );
  process.exit(1);
}

const REQUIRED_MARKER = "__BOC_CONTENT_SCRIPT_LOADED__";
const MAIN_MODULE_BASENAME = "content-main.mjs";

// Guard: every resolved local (`./`/`../`) import must stay inside extension/.
// Absolute and external (package) imports are left untouched. The guard lives
// on the build object via esbuild's onResolve so it never rewrites paths, only
// validates them as esbuild resolves them.
const EXTENSION_ROOT = path.resolve(extensionRoot) + path.sep;
const localImportGuard = {
  name: "extension-local-import-guard",
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      if (resolved.startsWith(EXTENSION_ROOT)) return undefined;
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

// 轮 A 专用插件：把指向懒加载目标的 import resolve 成轮 B 产物的 external
// 路径。esbuild 对 external 不跟随打包——主包里的懒加载边保持真 import()，
// 轮 A 的 splitting:false 才能把常驻图整体内联进单文件而不吞掉动态边界。
// 其余相对导入不受影响（返回 undefined 交回 esbuild 默认解析）。
const lazyTargetExternal = {
  name: "lazy-target-external",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^\.\.?\// }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      // 源码里的相对导入一律带 .js 后缀（TS ESM 约定），esbuild 的 onResolve
      // 在 TS 解析之前拿到的是字面 .js 路径——这里先行做 .js → .ts 归一，
      // 再查 lazyTargets 的源文件表。
      const candidates = [resolved];
      if (resolved.endsWith(".js")) {
        candidates.push(resolved.slice(0, -3) + ".ts");
      }
      for (const candidate of candidates) {
        const externalPath = lazyTargetExternals.get(candidate);
        if (externalPath) return { path: externalPath, external: true };
      }
      return undefined;
    });
  },
};

// 清理旧产物后再构建：chunk 文件名带内容 hash，上一轮的 chunk 若不清掉会被
// release 打包（copytree 整目录）一并带进 zip 成为死文件。
function cleanPreviousOutput() {
  for (const stale of [legacyOutfile, mainOutfile, bootstrapOutfile]) {
    fs.rmSync(stale, { force: true });
  }
  fs.rmSync(chunksDir, { recursive: true, force: true });
}

// 语法自检：bootstrap 是 classic script，主包与 chunk 是 ESM（.mjs），
// node --check 按扩展名选择解析模式，两者都能查。
function syntaxCheck(file) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

function sizeInBytes(file) {
  return fs.statSync(file).size;
}

// 构建配置提取为共享对象：一次性构建走 build()，--watch 走 context()。
// sourcemap 恒开（linked external map，非 inline/eval——扩展 CSP 禁 eval）：
// content 脚本的 .map 需经 manifest WAR（"entry/*.map"、"entry/chunks/*"）暴露
// 给 devtools；发布 zip 由 build_release.py 剔除全部 .map。
//
// 轮 B（懒加载区）：目标模块作 entryPoints + splitting:true，共享代码在轮内
// 自动提升为 chunk-[hash] 去重。entry 产物名取 lazyTargets 的 key、无 hash
// （轮 A 的 external 路径才能写死）；产物全部落在 chunks/ 子目录，manifest
// 的 WAR 用 "entry/chunks/*" 一条通配即可覆盖未来新增的所有动态 chunk。
const lazyChunkOptions = {
  entryPoints: Object.fromEntries(
    lazyTargets.map(({ name, source }) => [name, path.join(extensionRoot, source)])
  ),
  outdir: chunksDir,
  entryNames: "[name]",
  chunkNames: "[name]-[hash]",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  minify: true,
  sourcemap: true,
  metafile: true,
  target: "chrome120",
  plugins: [localImportGuard],
};

// 轮 A（常驻区）：entry/content.ts 单独一轮 splitting:false——常驻图整体
// 内联进单文件 content-main.mjs（不再有静态 chunk），懒加载目标由
// lazyTargetExternal external 成轮 B 产物路径。
const mainPackageOptions = {
  // 对象形式 entryPoints：key 直接决定输出文件名（相对 outdir、不含扩展名），
  // 源 entry/content.ts 保持模块形态不动。
  entryPoints: { "content-main": entry },
  outdir: outDir,
  entryNames: "[name]",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "browser",
  minify: true,
  sourcemap: true,
  target: "chrome120",
  plugins: [localImportGuard, lazyTargetExternal],
};

const bootstrapOptions = {
  entryPoints: [bootstrapEntry],
  outfile: bootstrapOutfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  minify: true,
  sourcemap: true,
  target: "chrome120",
  plugins: [localImportGuard],
};

// watch 重建日志：首轮（rebuild()）由下方自检/报表覆盖，只在后续增量重建时
// 打一行；构建错误由 esbuild 自身输出，这里不重复。
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
      console.log(`[watch] content rebuilt at ${new Date().toLocaleTimeString()}`);
    });
  },
};

async function main() {
  cleanPreviousOutput();
  if (!watchMode) {
    // 先跑轮 B（懒加载区），再跑轮 A（常驻区 external 指向轮 B 产物路径——
    // 路径由 lazyTargets 的 key 决定、无 hash，两轮互不依赖对方的产物存在）。
    const lazyResult = await build(lazyChunkOptions);
    await build(mainPackageOptions);
    await build(bootstrapOptions);
    if (!selfCheck()) {
      return;
    }
    report(lazyResult.metafile);
    return;
  }
  const lazyCtx = await context({
    ...lazyChunkOptions,
    plugins: [...lazyChunkOptions.plugins, watchRebuildLog],
  });
  const mainCtx = await context({
    ...mainPackageOptions,
    plugins: [...mainPackageOptions.plugins, watchRebuildLog],
  });
  const bootstrapCtx = await context({
    ...bootstrapOptions,
    plugins: [...bootstrapOptions.plugins, watchRebuildLog],
  });
  const lazyRebuild = await lazyCtx.rebuild();
  await mainCtx.rebuild();
  await bootstrapCtx.rebuild();
  if (!selfCheck()) {
    process.exit(1);
  }
  report(lazyRebuild.metafile);
  await Promise.all([lazyCtx.watch(), mainCtx.watch(), bootstrapCtx.watch()]);
  console.log("[watch] build-content watching for changes...");
}

function selfCheck() {
  // Bootstrap 断言：必须是 classic 语法（node --check 过 IIFE），且携带
  // 哨兵与主包路径——前者是运行时版本探针的依据，后者防「路径改了产物
  // 没跟上」的静默失配。
  syntaxCheck(bootstrapOutfile);
  const bootstrapText = fs.readFileSync(bootstrapOutfile, "utf8");
  if (!bootstrapText.includes(REQUIRED_MARKER)) {
    console.error(
      `Self-check failed: ${bootstrapOutfile} is missing required marker ${REQUIRED_MARKER}`
    );
    process.exitCode = 1;
    return false;
  }
  if (!bootstrapText.includes(MAIN_MODULE_BASENAME)) {
    console.error(
      `Self-check failed: ${bootstrapOutfile} does not reference ${MAIN_MODULE_BASENAME}`
    );
    process.exitCode = 1;
    return false;
  }

  // 主包与 chunk 逐个过语法检查。
  syntaxCheck(mainOutfile);
  if (fs.existsSync(chunksDir)) {
    for (const chunkFile of fs.readdirSync(chunksDir)) {
      if (chunkFile.endsWith(".mjs")) {
        syntaxCheck(path.join(chunksDir, chunkFile));
      }
    }
  }

  // 主包守卫（仿 build.js 的 offscreen splitting 守卫）：content-main.mjs
  // 必须仍含动态 import( ——懒加载边界被内联回主包（lazyTargetExternal 失效
  // 或被绕过）时在此失败。
  const mainText = fs.readFileSync(mainOutfile, "utf8");
  if (!mainText.includes("import(")) {
    console.error(
      `Self-check failed: ${mainOutfile} 不含动态 import(，懒加载边界被内联`
    );
    process.exitCode = 1;
    return false;
  }
  // 主包守卫（06 合拢）：主包不得静态引用 chunks/——轮 A splitting:false 下
  // 任何静态 chunk 引用都意味着常驻图重新碎裂（常驻口径 = bootstrap + main
  // 共 2 个请求）。动态 import 调用先剔除，再查 "./chunks/ 字面量。
  const mainTextWithoutDynamicImports = mainText.replace(
    /import\s*\(\s*"[^"]*"\s*\)/g,
    ""
  );
  if (/"\.\/chunks\//.test(mainTextWithoutDynamicImports)) {
    console.error(
      `Self-check failed: ${mainOutfile} 静态引用 chunks/——常驻图必须保持` +
        `单文件（2 请求），懒加载目标只能经动态 import() 按需装载`
    );
    process.exitCode = 1;
    return false;
  }
  return assertSharedSlotsInBothRegions();
}

// 跨实例共享槽守卫（2026-09 双实例收口）：content 是两轮构建——常驻包（轮 A，
// content-main.mjs）与懒加载区（轮 B，chunks/*）把共享底座各装一份实例，因此
// 「跨实例共享的可变状态」必须挂 globalThis 槽，两侧才对齐到同一份
//（先例 shared/messaging.ts 的页内分发槽；槽表/logging 门/state 单例/
// style-injector 挂载记录依次见 reader/reader-bus.ts、shared/logging.ts、
// core/state.ts、shared/style-injector.ts）。
//
// 本守卫按命名约定扫源码（`*_SLOT_KEY = "__BOC_...__"`），断言每个槽键在常驻包
// 与至少一个懒加载区 chunk 里都出现——槽被树摇掉、或模块掉出某一轮构建时在此
// 失败。新增跨实例状态照约定声明槽键即可自动纳入本守卫，不必改这里。
const SLOT_KEY_DECLARATION = /\b[A-Z_]*SLOT_KEY\s*=\s*"(__BOC_[A-Z_]+__)"/g;

function collectSlotKeys() {
  const keys = new Map(); // key → 声明它的源文件（相对 extension/）
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // 只扫源码：构建产物是 .mjs/.js，天然被排除；.d.ts 无运行时声明。
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) {
        continue;
      }
      const text = fs.readFileSync(full, "utf8");
      for (const match of text.matchAll(SLOT_KEY_DECLARATION)) {
        keys.set(match[1], path.relative(extensionRoot, full));
      }
    }
  };
  walk(extensionRoot);
  return keys;
}

function assertSharedSlotsInBothRegions() {
  const slotKeys = collectSlotKeys();
  if (slotKeys.size === 0) {
    console.error(
      'Self-check failed: 未发现任何跨实例共享槽声明（*_SLOT_KEY = "__BOC_...__"）' +
        "——约定见本函数头注，槽全没了意味着跨实例状态没挂共享槽"
    );
    process.exitCode = 1;
    return false;
  }
  const mainText = fs.readFileSync(mainOutfile, "utf8");
  const chunkTexts = fs.existsSync(chunksDir)
    ? fs
        .readdirSync(chunksDir)
        .filter((file) => file.endsWith(".mjs"))
        .map((file) => fs.readFileSync(path.join(chunksDir, file), "utf8"))
    : [];
  const missing = [];
  for (const [key, source] of slotKeys) {
    if (!mainText.includes(key)) {
      missing.push(`${key}（${source}）不在常驻包 ${MAIN_MODULE_BASENAME}`);
    } else if (!chunkTexts.some((text) => text.includes(key))) {
      missing.push(`${key}（${source}）不在任何懒加载区 chunk`);
    }
  }
  if (missing.length > 0) {
    console.error(
      "Self-check failed: 跨实例共享槽未两侧落位——两轮构建下共享底座在常驻包与" +
        "懒加载区各一份实例，槽必须两侧都挂（shared/messaging.ts 先例）：\n  " +
        missing.join("\n  ")
    );
    process.exitCode = 1;
    return false;
  }
  return true;
}

// 体积守卫（评审 #1）：reader 域装载图（含 reader/lifecycle 的 chunk）不得含
// ai/analysis 概览管线——管线只能经 overview 的 startOverviewRun 动态 import
// 按需装载。防止未来有人把静态 import 加回去，把 reader chunk 的拆分悄悄焊回。
// 06 合拢后改跑轮 B metafile：reader/lifecycle 经 reader/index（轮 B entry）
// 的静态 re-export 进入轮 B 图，静态 import 回归会在 reader 的轮 B 产物里
// 现形；常驻侧的回归则由 selfCheck 的「主包不得静态引用 chunks/」守卫兜住
// （被 external 的目标一旦被静态 import 就会变成主包静态 chunk 引用）。
function assertAnalysisNotInReaderGraph(meta) {
  for (const [file, out] of Object.entries(meta.outputs)) {
    if (!file.endsWith(".mjs")) continue;
    const inputs = Object.keys(out.inputs);
    if (!inputs.some((input) => input.includes("reader/lifecycle.ts"))) continue;
    if (inputs.some((input) => input.includes("ai/analysis.ts"))) {
      console.error(
        `build-content.js: reader 装载图 ${file} 含 ai/analysis.ts——` +
          `概览管线必须经 startOverviewRun 动态 import 按需装载`
      );
      process.exit(1);
    }
  }
}

function report(lazyMeta) {
  assertAnalysisNotInReaderGraph(lazyMeta);
  const bootstrapSize = sizeInBytes(bootstrapOutfile);
  const mainSize = sizeInBytes(mainOutfile);
  const chunkFiles = fs.existsSync(chunksDir)
    ? fs.readdirSync(chunksDir).filter((f) => f.endsWith(".mjs")).sort()
    : [];
  // 轮 B 产物二分：懒加载目标 entry 产物（文件名 = lazyTargets 的 key）与其余
  // 共享 chunk（轮内提升去重的公共代码）。两类都只在对应懒边界被触发时才
  // 下载，全部按需，不计入常驻。
  const lazyNames = new Set(lazyTargets.map(({ name }) => name));
  const lazyChunkFiles = chunkFiles.filter((f) =>
    lazyNames.has(f.replace(/\.mjs$/, ""))
  );
  const sharedChunkFiles = chunkFiles.filter(
    (f) => !lazyNames.has(f.replace(/\.mjs$/, ""))
  );
  const lazyChunkTotal = lazyChunkFiles.reduce(
    (sum, f) => sum + sizeInBytes(path.join(chunksDir, f)),
    0
  );
  const sharedChunkTotal = sharedChunkFiles.reduce(
    (sum, f) => sum + sizeInBytes(path.join(chunksDir, f)),
    0
  );

  console.log(`Wrote ${bootstrapOutfile} (classic IIFE bootstrap, minified: true, ${bootstrapSize} bytes)`);
  console.log(`Wrote ${mainOutfile} (ESM main package, single-file resident graph, minified: true, ${mainSize} bytes)`);
  if (chunkFiles.length === 0) {
    console.log("No chunks produced (no import boundaries in the module graph).");
  } else {
    for (const chunkFile of lazyChunkFiles) {
      console.log(
        `Wrote ${path.join(chunksDir, chunkFile)} (lazy entry chunk, on-demand, ${sizeInBytes(path.join(chunksDir, chunkFile))} bytes)`
      );
    }
    for (const chunkFile of sharedChunkFiles) {
      console.log(
        `Wrote ${path.join(chunksDir, chunkFile)} (shared chunk, on-demand, ${sizeInBytes(path.join(chunksDir, chunkFile))} bytes)`
      );
    }
    console.log(
      `Lazy entry chunks (on-demand): ${lazyChunkTotal} bytes across ${lazyChunkFiles.length} file(s)`
    );
    console.log(
      `Shared chunks (on-demand): ${sharedChunkTotal} bytes across ${sharedChunkFiles.length} file(s)`
    );
  }
  // 常驻口径（06 合拢后）：bootstrap（content_scripts 注入）+ 主包（常驻图
  // 整体单文件，轮 A splitting:false 下不再有静态 chunk）。静态 chunk 归零、
  // 懒加载区全部按需；主包静态引用 chunks/ 由 selfCheck 守卫兜底。
  const residentTotal = bootstrapSize + mainSize;
  console.log(`Resident requests (bootstrap + main): 2`);
  console.log(
    `Resident total (bootstrap + main): ${residentTotal} bytes`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
