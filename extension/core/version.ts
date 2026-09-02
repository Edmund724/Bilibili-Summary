// extension/core/version.ts
// 扩展版本的单一事实源；由 scripts/build-content.js 的版本守卫与
// manifest.json 的 "version" 保持同步。
//
// 为什么从 defaults.ts 拆出来：entry/content-bootstrap.ts 只需要版本号一个
// 常量，若 import defaults.ts，esbuild 会把 DEFAULT_SETTINGS 等全部默认值
// 常量一并打进每次页面导航都要解析执行的 classic bootstrap。拆出后 bootstrap
// 只打包这一行，defaults.ts re-export 该符号，原有消费方（content.js、
// subtitle/ui.js 等）的 import 路径不变。
export const BOC_VERSION = "2.0.0";
