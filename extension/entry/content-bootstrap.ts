// 内容脚本引导器（候选4 分包）。
//
// 为什么需要 bootstrap：MV3 经典（classic）content script 里的动态 import()
// 相对路径会按「页面」origin 解析（Chromium 对 classic script 的既定行为，
// 页面上下文里解析不到 chrome-extension:// 的 chunk 文件），因此 manifest 只
// 注入这个极小的经典脚本，由它用 chrome.runtime.getURL 拼出「绝对路径」拉起
// 真正的 ESM 主包 entry/content-main.mjs。主包进入 ESM 模块图之后，模块内部
// 后续相对路径的动态 import() 都按扩展自身 URL 解析，合法且共享同一模块实例
//（不存在 split-brain 状态）——这是 WXT 同款的成熟方案。
//
// 本文件以 ESM 源码形态入库，由 scripts/build-content.js 打包成
// entry/content-bootstrap.iife.js（classic IIFE，产物已 gitignore）。
// 导出的工厂仅供单测注入依赖；IIFE 产物中未使用的导出会被 esbuild 剪掉，
// 不影响产物体积。

// 只 import 版本常量：defaults.js 的全部默认设置常量不必进 bootstrap
//（主包自带），见 core/version.js 头注。
import { BOC_VERSION } from "../core/version.js";

// 主包固定路径：与 scripts/build-content.js 的产出约定一致，改动需两处同步。
// 放在模块级常量而非内联字面量传给 import()，同时避免打包器把动态导入目标
// 误识别为可静态分析的字符串字面量而尝试内联打包。
export const CONTENT_MAIN_MODULE_PATH = "entry/content-main.mjs";

interface BootstrapOptions {
  getExtensionUrl?: (modulePath: string) => string;
  importModule?: (url: string) => Promise<unknown>;
}

interface BootstrapResult {
  loadContentMain(): Promise<unknown>;
}

// 注入点：getExtensionUrl / importModule 仅测试使用，生产走真实实现。
export function startContentBootstrap(options: BootstrapOptions = {}): BootstrapResult | null {
  // 防重复注入：B 站是 SPA，扩展更新/重载时浏览器可能对同一文档再次执行
  // classic content script。主包 init 自带幂等守卫，这里挡的是重复的模块
  // 加载请求与重复的哨兵写入。
  //
  // 与 classic 重注入哨兵的对应关系：分包前的旧版 content.js 顶层声明了
  // `const DEFAULT_SETTINGS`，同一文档被重复 classic 注入时该 SyntaxError
  // 由浏览器抛出（非本扩展代码主动 throw）；background 的注入编排按
  // shared/content-error-sentinels.js 的 DUPLICATE_CLASSIC_INJECTION_SENTINEL
  // 将其视为「已注入」吞掉（本 bootstrap 为 IIFE、无顶层绑定，不触发该哨兵）。
  if (globalThis.__BOC_CONTENT_BOOTSTRAP_STARTED__) {
    return null;
  }
  globalThis.__BOC_CONTENT_BOOTSTRAP_STARTED__ = true;

  // 运行时版本探针的哨兵（background 与 chrome.runtime.getManifest().version
  // 比对），语义与分包前的单文件 bundle 保持一致。
  globalThis.__BOC_CONTENT_SCRIPT_LOADED__ = BOC_VERSION;

  const resolveMainModuleUrl =
    options.getExtensionUrl ?? ((modulePath) => chrome.runtime.getURL(modulePath));
  const importMainModule = options.importModule ?? ((url) => import(url));

  // 缓存加载 promise：同一文档内任何后续触发（重复注入、调试调用）共享同一
  // 次模块加载，避免主包顶层副作用被执行两次。
  let mainPromise: Promise<unknown> | null = null;

  function loadContentMain(): Promise<unknown> {
    if (!mainPromise) {
      // 外面包一层 Promise.resolve().then：getExtensionUrl 的同步异常（如
      // 扩展上下文已失效）也统一进入 catch，维持「失败即清空」的可重试语义。
      mainPromise = Promise.resolve()
        .then(() => importMainModule(resolveMainModuleUrl(CONTENT_MAIN_MODULE_PATH)))
        .catch((error) => {
          // 失败清缓存：允许后续触发重试（例如扩展刚更新导致旧 chunk 404，
          // 重新触发加载即可恢复，不必刷新页面）。
          mainPromise = null;
          // 现场定位信息：扩展名（版本）+ 主包路径。chunk 加载失败时浏览器
          // 原始报错只给页面 URL 下的相对路径，不指明来源，必须在这里补齐
          // 上下文才能定位是 WAR 配置缺失还是产物没打进包。
          console.error(
            `[BOC] 内容脚本主包加载失败：${CONTENT_MAIN_MODULE_PATH} ` +
              `(extension v${BOC_VERSION})。请确认扩展包内存在该文件，且 ` +
              `manifest.json 的 web_accessible_resources 覆盖 ` +
              `"entry/content-main.mjs" 与 "entry/chunks/*"。`,
            error
          );
          throw error;
        });
    }
    return mainPromise;
  }

  return { loadContentMain };
}

// 顶层自动启动。守卫条件在生产环境恒真（content script 环境必有
// chrome.runtime.getURL）；单测环境（vitest 注入 process.env.VITEST）显式
// 跳过——S3 分层后 setup.js 的通用 chrome stub 提供 getURL（样式挂载用），
// 守卫若只看 getURL 会在测试导入本模块时真的发起主包加载（vite 模块运行器
// 对不存在的 chrome-extension:// URL 报错并上报 unhandled rejection）。
declare const process: { env?: Record<string, string | undefined> } | undefined;
const isTestEnv = typeof process !== "undefined" && Boolean(process.env?.VITEST);
if (!isTestEnv && typeof chrome?.runtime?.getURL === "function") {
  startContentBootstrap()?.loadContentMain();
}
