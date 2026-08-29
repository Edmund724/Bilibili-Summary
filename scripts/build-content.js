// Content script 构建脚本（候选4 分包）。
//
// 产物形态：极小 classic bootstrap + 纯 ESM 主包（+ splitting 切出的动态
// chunk）。为什么不能继续单文件 IIFE：classic content script 里动态 import()
// 的相对路径按页面 origin 解析（Chromium 既定行为），分包后必须由 bootstrap
// 用 chrome.runtime.getURL 的绝对路径拉起 ESM 主包，主包模块图内相对路径的
// 动态 import 才会按扩展自身 URL 解析（WXT 同款方案）。
//
// 产物清单（均 gitignore）：
//   entry/content-bootstrap.iife.js  经典 IIFE，manifest.content_scripts 指向它
//   entry/content-main.mjs           ESM 主包（entry/content.js 的模块图）
//   entry/chunks/chunk-<hash>.mjs    splitting 为动态 import 边切出的 chunk
//
// web_accessible_resources 必须覆盖 content-main.mjs 与 chunks/*（见
// extension/manifest.json），否则页面上下文里的 bootstrap 无权拉取模块。

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { build } = require("esbuild");

const extensionRoot = path.join(__dirname, "..", "extension");
const entry = path.join(extensionRoot, "entry", "content.js");
const bootstrapEntry = path.join(extensionRoot, "entry", "content-bootstrap.js");
const outDir = path.join(extensionRoot, "entry");
const mainOutfile = path.join(outDir, "content-main.mjs");
const bootstrapOutfile = path.join(outDir, "content-bootstrap.iife.js");
const chunksDir = path.join(outDir, "chunks");
// 分包前的单文件产物（已废弃）：构建前清掉，避免它混进 release zip。
const legacyOutfile = path.join(outDir, "content-classic.js");

// Version-consistency guard: fail fast before invoking esbuild if the
// BOC_VERSION literal in extension/core/defaults.js drifts from
// manifest.json's "version". This guards the runtime probe that compares
// __BOC_CONTENT_SCRIPT_LOADED__ (bootstrap 写入) against
// chrome.runtime.getManifest().version.
const manifestPath = path.join(__dirname, "..", "extension", "manifest.json");
// 版本实体在 core/version.js（bootstrap 专用拆分，defaults.js re-export）；
// defaults.js 若丢了 re-export，主包构建会因 content.js 的 import 失败而报错，
// 天然兜底。
const versionJsPath = path.join(__dirname, "..", "extension", "core", "version.js");

const manifestVersion = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
const versionJsText = fs.readFileSync(versionJsPath, "utf8");
const versionJsMatch = /export const BOC_VERSION = "([^"]+)"/.exec(versionJsText);
const versionJsVersion = versionJsMatch ? versionJsMatch[1] : null;

if (!versionJsVersion || versionJsVersion !== manifestVersion) {
  console.error(
    `Version mismatch: ${manifestPath} has "version": ${manifestVersion}, ` +
      `but ${versionJsPath} declares BOC_VERSION = ${versionJsVersion ?? "(unparseable)"}`
  );
  process.exit(1);
}

const minify = process.env.BOC_MINIFY !== "0";
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

async function buildMainPackage() {
  await build({
    // 对象形式 entryPoints：key 直接决定输出文件名（相对 outdir、不含扩展名），
    // 源 entry/content.js 保持模块形态不动。
    entryPoints: { "content-main": entry },
    outdir: outDir,
    entryNames: "[name]",
    // chunk 统一进 chunks/ 子目录：manifest 的 WAR 用 "entry/chunks/*" 一条
    // 通配即可覆盖未来新增的所有动态 chunk。
    chunkNames: "chunks/[name]-[hash]",
    outExtension: { ".js": ".mjs" },
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    minify,
    plugins: [localImportGuard],
  });
}

async function buildBootstrap() {
  await build({
    entryPoints: [bootstrapEntry],
    outfile: bootstrapOutfile,
    bundle: true,
    format: "iife",
    platform: "browser",
    minify,
    plugins: [localImportGuard],
  });
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
  return true;
}

function report() {
  const bootstrapSize = sizeInBytes(bootstrapOutfile);
  const mainSize = sizeInBytes(mainOutfile);
  const chunkFiles = fs.existsSync(chunksDir)
    ? fs.readdirSync(chunksDir).filter((f) => f.endsWith(".mjs")).sort()
    : [];
  const chunkTotal = chunkFiles.reduce(
    (sum, f) => sum + sizeInBytes(path.join(chunksDir, f)),
    0
  );

  console.log(`Wrote ${bootstrapOutfile} (classic IIFE bootstrap, minified: ${minify}, ${bootstrapSize} bytes)`);
  console.log(`Wrote ${mainOutfile} (ESM main package, minified: ${minify}, ${mainSize} bytes)`);
  if (chunkFiles.length === 0) {
    console.log("No dynamic chunks produced (0 dynamic import boundaries in the module graph).");
  } else {
    for (const chunkFile of chunkFiles) {
      console.log(
        `Wrote ${path.join(chunksDir, chunkFile)} (dynamic chunk, ${sizeInBytes(path.join(chunksDir, chunkFile))} bytes)`
      );
    }
    console.log(`Dynamic chunks total: ${chunkTotal} bytes across ${chunkFiles.length} file(s)`);
  }
  // 常驻口径：bootstrap（content_scripts 注入）+ 主包（首次加载必然整体拉起）
  // + 静态 chunk。动态 chunk 只在对应边界被触发时才下载，不计入常驻。
  const residentTotal = bootstrapSize + mainSize;
  console.log(`Resident total (bootstrap + main): ${residentTotal} bytes`);
}

cleanPreviousOutput();

Promise.all([buildMainPackage(), buildBootstrap()])
  .then(() => {
    if (!selfCheck()) {
      return;
    }
    report();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
