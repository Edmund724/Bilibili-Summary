// extension/entry/settings-migration.ts
// 安装/更新一次性设置迁移的决策半边（纯函数，就地变异；执行与落盘仍由
// background 的 initializeSettingsStorage 统一走全量写，本函数不触碰 storage
// ——background.js 有 35KB 体积守卫，迁移逻辑必须保持最小字节量）。
//
// 2026-09 AI 键默认开迁移：enablePlayerAiQuickAction 默认值 false → true
// （core/defaults.ts）。旧版本的所有落盘路径（设置面板整包保存、旧安装迁移的
// 全量键落盘）都会把当时的默认值 false 显式写进 storage.sync，存量 false
// 分不清「用户刻意关闭」与「历史默认值被动落盘」。本决策把存量 false 改写回
// 新默认 true，并把 aiBtnDefaultOnMigrated 旗标置进同一份合并对象随全量写
// 落盘——旗标保证迁移只生效一次，此后用户显式关闭的值不会被后续更新翻转。
//
// 取舍（有意为之）：存量用户里曾刻意关闭按钮的会被这次迁移重新打开一次，
// 需要再手动关一次——在不引入用户可见确认弹窗的前提下无法区分两种 false，
// 而不改写则默认翻转对全部存量安装（含提出该诉求用户的浏览器）无效。

// 存量显式 false 且旗标未置位 → 改写回 true + 置旗标；否则原样返回。旗标键
// 已进 DEFAULT_SETTINGS 键面（settings 存储白名单自动覆盖），随调用方的
// 全量写持久化。
export function applyPlayerAiQuickActionDefaultOnMigration(
  syncCurrent: Record<string, unknown>
): Record<string, unknown> {
  if (
    syncCurrent.enablePlayerAiQuickAction === false &&
    !syncCurrent.aiBtnDefaultOnMigrated
  ) {
    syncCurrent.enablePlayerAiQuickAction = true;
    syncCurrent.aiBtnDefaultOnMigrated = true;
  }
  return syncCurrent;
}
