// ui/icons.ts — inline SVG 图标构建函数。
// AI 播放器快捷动作图标原在 ai/player-ai.js。均为纯函数，不依赖 DOM/全局状态。
// 候选02 分层惰性：阅读视图 header 图标（READING_HEADER_ICONS）已拆往
// ./reading-header-icons.js——两批图标消费方分属常驻（ui-renderer）与动态
// chunk（ai/player-ai.js），共享模块会被 esbuild 整体提升为常驻静态 chunk，
// 拆开后 AI 图标随 player-ai 按需下载。

// 快捷动作图标形态键（player-ai 的快捷按钮唯一使用默认 "badge"）。
export type PlayerAiQuickActionIconVariant = "badge" | "sparkles" | "nodes" | "chip";

export function buildPlayerAiQuickActionIconSvg(variant: PlayerAiQuickActionIconVariant = "badge"): string {
  const variants: Record<PlayerAiQuickActionIconVariant, string> = {
    badge: `
      <svg viewBox="0 0 132 132" focusable="false" aria-hidden="true" data-ai-icon="badge">
        <path stroke-width="8.25" d="M22 90.7494C22 99.8618 29.3873 107.249 38.5 107.249C38.5 114.843 44.6561 120.999 52.25 120.999C59.8438 120.999 66 114.843 66 107.249C66 114.843 72.1562 120.999 79.75 120.999C87.3438 120.999 93.5 114.843 93.5 107.249C102.613 107.249 110 99.8613 110 90.7489C110 87.621 109.13 84.6967 107.618 82.2046C115.24 80.7466 121 74.0454 121 65.9989C121 57.9518 115.24 51.2507 107.618 49.7929C109.13 47.3006 110 44.3763 110 41.2487C110 32.1359 102.613 24.7487 93.5 24.7487C93.5 17.1547 87.3438 10.9987 79.75 10.9987C72.1562 10.9987 66 17.1552 66 24.7492C66 17.1552 59.8438 10.9992 52.25 10.9992C44.6561 10.9992 38.5 17.1552 38.5 24.7492C29.3873 24.7492 22 32.1365 22 41.2492C22 44.3768 22.8702 47.3012 24.3817 49.7934C16.76 51.2512 11 57.9524 11 65.9994C11 74.0459 16.76 80.7471 24.3817 82.2052C22.8702 84.6972 22 87.6216 22 90.7494Z"></path>
        <path stroke-width="8.25" d="M41.25 79.7494L51.3804 49.3582C51.8997 47.8002 53.3577 46.7493 55 46.7493C56.6423 46.7493 58.1004 47.8002 58.6196 49.3582L68.75 79.7494M85.25 46.7493V79.7494M46.75 68.7494H63.25"></path>
      </svg>
    `,
    sparkles: `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" data-ai-icon="sparkles">
        <path stroke-width="1.8" d="M12 3.6l1.84 4.96 4.96 1.84-4.96 1.84L12 17.2l-1.84-4.96L5.2 10.4l4.96-1.84L12 3.6z"></path>
        <path stroke-width="1.8" d="M18.2 3.8l.64 1.72 1.72.64-1.72.64-.64 1.72-.64-1.72-1.72-.64 1.72-.64.64-1.72z"></path>
        <path stroke-width="1.8" d="M18 14.2l.48 1.28 1.28.48-1.28.48-.48 1.28-.48-1.28-1.28-.48 1.28-.48.48-1.28z"></path>
      </svg>
    `,
    nodes: `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" data-ai-icon="nodes">
        <circle stroke-width="1.8" cx="7" cy="8" r="2.1"></circle>
        <circle stroke-width="1.8" cx="17" cy="7" r="2.1"></circle>
        <circle stroke-width="1.8" cx="12" cy="16.8" r="2.1"></circle>
        <path stroke-width="1.8" d="M8.8 8.7l2.4 5.2"></path>
        <path stroke-width="1.8" d="M15.2 7.8l-2.2 5.8"></path>
        <path stroke-width="1.8" d="M8.9 8.1h5.9"></path>
      </svg>
    `,
    chip: `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" data-ai-icon="chip">
        <rect stroke-width="1.8" x="7.2" y="7.2" width="9.6" height="9.6" rx="2.1"></rect>
        <path stroke-width="1.8" d="M10 10h4"></path>
        <path stroke-width="1.8" d="M10 12h4"></path>
        <path stroke-width="1.8" d="M10 14h2.8"></path>
        <path stroke-width="1.8" d="M9 4.8v2"></path>
        <path stroke-width="1.8" d="M12 4.8v2"></path>
        <path stroke-width="1.8" d="M15 4.8v2"></path>
        <path stroke-width="1.8" d="M9 17.2v2"></path>
        <path stroke-width="1.8" d="M12 17.2v2"></path>
        <path stroke-width="1.8" d="M15 17.2v2"></path>
        <path stroke-width="1.8" d="M4.8 9h2"></path>
        <path stroke-width="1.8" d="M4.8 12h2"></path>
        <path stroke-width="1.8" d="M4.8 15h2"></path>
        <path stroke-width="1.8" d="M17.2 9h2"></path>
        <path stroke-width="1.8" d="M17.2 12h2"></path>
        <path stroke-width="1.8" d="M17.2 15h2"></path>
      </svg>
    `
  };
  return variants[variant] || variants.badge;
}
