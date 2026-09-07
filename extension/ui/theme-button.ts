// ui/theme-button.ts — header 主题按钮（太阳/月亮）图标与文案的单点。
// 图标按 readingTheme 映射：light=太阳、dark=月亮（纸色档已退役，归一化
// 只产出这两值）。两个消费方：ui-renderer 建壳时取初值；
// reader/presentation.ts 的 applyReadingViewPresentation 尾部经 refreshThemeButton
// 刷新——所有改主题路径（点击循环、进入阅读模式、storage 跨页同步 watcher）
// 都收敛到该函数，按钮不另接。
// 依赖全为轻叶子（core/state、reader/state 的 ids 表、本目录图标表）；
// 按钮节点缺失时静默跳过（测试骨架不搭该按钮，见 tests/helpers/reader-skeleton.js）。
import { state } from "../core/state.js";
import { ids } from "../reader/state.js";
import { READING_HEADER_ICONS } from "./reading-header-icons.js";

const THEME_TITLES: Record<string, string> = {
  light: "浅色",
  dark: "深色"
};

export function themeButtonView(theme: string): { icon: string; title: string } {
  const dark = theme === "dark";
  return {
    icon: dark ? READING_HEADER_ICONS.themeDark : READING_HEADER_ICONS.theme,
    title: THEME_TITLES[dark ? "dark" : "light"]
  };
}

let lastApplied: string | null = null;

export function refreshThemeButton(): void {
  const button = document.getElementById(ids.readingThemeSelect);
  if (!button) {
    return;
  }
  const theme = state.reader.readingTheme;
  if (theme === lastApplied) {
    return;
  }
  lastApplied = theme;
  const view = themeButtonView(theme);
  button.innerHTML = view.icon;
  button.title = `主题：${view.title}`;
  button.setAttribute("aria-label", `主题：${view.title}`);
}