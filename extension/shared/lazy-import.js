// 模块级 promise 缓存式懒加载器工厂：core/lazy-player-ai.js、core/lazy-reader.js、
// subtitle/lazy.js、subtitle/fetcher.js（ASR 回退装载）四处同构模式的收拢。
//
// 失败语义：首次 load() 调用 loadFn 并缓存 promise，后续调用共享同一 promise；
// 失败时清空缓存并 rethrow，下次 load() 可重试（例如扩展刚更新、旧 chunk 404
// 的过渡窗口内先失败，重试即可恢复）。
//
// isLoaded 的语义约定（消费方依赖它区分「未加载可跳过」与「已加载/加载中需
// 继续走异步路径」）：已存在加载请求（含仍在加载中）⇒ true；失败清缓存后
// 回落 false。
export function createLazyLoader(loadFn) {
  let promise = null;
  return {
    load() {
      if (!promise) {
        promise = loadFn().catch((error) => {
          promise = null;
          throw error;
        });
      }
      return promise;
    },
    isLoaded() {
      return promise !== null;
    }
  };
}
