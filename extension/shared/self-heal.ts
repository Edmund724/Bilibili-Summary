// extension/shared/self-heal.ts
// 自愈调度共享常量（arch-slim-2/09 单源收口）。
//
// SELF_HEAL_INTERVAL_MS：content 侧按钮「定时自查自愈」的节拍——
// ui/digest-button.ts 的按钮补回自查（原 REINJECT_INTERVAL_MS 本地字面量）。
// 它此前与 reader/digest-host.ts 的面板重锚自查共用本常量（原两处注释互引
// 同一口径、各持一份 800ms 字面量，收口于此）；面板重锚节拍后拆回 digest-host
// 本地常量（2s，面板跑位是降级表现非功能失效，纯兜底拍语义独立，理由见
// digest-host.ts 的 REANCHOR_INTERVAL_MS 处注释），本常量回归按钮自愈专用。
// 修改按钮自查节拍请只改这里（digest-button 注释指向本文件）。
//
// READER_CLOSED_EVENT：阅读壳退出通知（window CustomEvent，无 detail）。
// exitReaderShell 完成退出事务后派发（reader/shell.ts），ui/digest-button.ts
// 监听它恢复常速自查并立即补回按钮——这是「视图关闭后补回按钮」的恢复触发点。
// 有意不走静态 import 边（digest-button 不 import reader/shell）：两侧只共享
// 本事件名字符串，派发方/监听方谁也不进谁的模块图。
export const SELF_HEAL_INTERVAL_MS = 800;

export const READER_CLOSED_EVENT = "boc:reader-closed";
