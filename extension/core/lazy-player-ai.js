// ai/player-ai.js 的按需加载器（候选4 分包）。
//
// 为什么惰性：player-ai 只在设置 enablePlayerAiQuickAction 开启时才有职责
// （挂 observer、layout 监听、播放器快捷按钮），而该设置默认关闭
// （core/defaults.js）。分包前它随单文件 bundle 常驻；分包后这里成为动态
// import 边，esbuild 会把它连同其专属依赖切进 entry/chunks/，只在首次
// start 需要时才下载。
//
// 为什么直接写相对路径：本模块身处 ESM 主包模块图内，动态 import() 的相对
// 路径按扩展自身 URL 解析（bootstrap 已用 chrome.runtime.getURL 的绝对路径
// 拉起主包），无需也不应再经 getURL 拼绝对路径。
//
// 失败语义：加载失败清空缓存 promise，允许下次触发重试（例如扩展刚更新、
// 旧 chunk 404 的过渡窗口内先失败、刷新设置开关后可恢复）。
//
// 「未加载」的语义约定（消费方依赖它做等价性判断）：模块未加载 ⇒ 快捷按钮
// 从未挂上 ⇒ 一切「移除按钮 / 同步按钮」的请求都是 no-op，消费方据此跳过
// 调用即可（stop/remove/sync 的幂等性由该不变量保证）。

let modulePromise = null;

// 按需加载 ai/player-ai.js，同一文档内重复调用共享同一 promise。
export function loadPlayerAi() {
  if (!modulePromise) {
    modulePromise = import("../ai/player-ai.js").catch((error) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

// 模块是否已存在加载请求（含仍在加载中）。消费方用它区分「未加载可跳过」
// 与「已加载/加载中需继续走异步路径」。
export function isPlayerAiLoaded() {
  return modulePromise !== null;
}
