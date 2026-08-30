// content-error-sentinels.js — 浏览器引擎错误文案哨兵（shared 常量收口）。
//
// 注入恢复编排（entry/background-content-orchestration.js）需要按浏览器引擎
// 抛出的错误文案做错误分类；这些文案由浏览器生成，不是本扩展代码主动 throw
// 的，集中在此避免同一字面量在 SW / 页面侧散落多处后随引擎改版悄悄失配。

// 重复 classic 注入的全局词法冲突哨兵：同一文档里先后执行两份顶层声明了同名
// const 绑定的 classic 脚本时，浏览器对后注入脚本抛出的 SyntaxError 文案。
// 典型场景是扩展更新版本偏斜——旧版（候选4 分包前）content.js 的顶层
// `const DEFAULT_SETTINGS = …` 仍留在页面全局词法环境里，新一轮 classic 注入
// 再声明同名绑定即触发。哨兵由浏览器抛出、编排层视为「已注入」吞掉；与
// classic 重注入场景的对应关系另见 entry/content-bootstrap.js 头注。
export const DUPLICATE_CLASSIC_INJECTION_SENTINEL =
  "Identifier 'DEFAULT_SETTINGS' has already been declared";

// 接收端缺失哨兵：content script 尚未在目标 tab 挂上 onMessage 接收端时，
// chrome.tabs.sendMessage 以该文案 reject。触发/关闭阅读视图的重试编排以此
// 分类——触发路径命中才走「确保 content 就绪」兜底后再重试。
export const RECEIVING_END_MISSING_SENTINEL =
  "Could not establish connection. Receiving end does not exist.";
