// ===== Player-AI state =====
//
// playerAi 状态微模块（随 ai 域内聚，自 core/state.ts 平移）：player-ai.js
// 动态 chunk 独占读写；core/message-handler.ts 在 reader-enter 触发阅读模式时经
// suppressUntil 抑制快捷按钮弹出，无需加载整个 player-ai chunk。

type PlayerAiBusinessState = {
  playerAiQuickActionObserver: MutationObserver | null;
  playerAiQuickActionLayoutBound: boolean;
  playerAiQuickActionSyncTimer: number;
  playerAiQuickActionRevealTimer: number;
  playerAiQuickActionHideTimer: number;
  playerAiQuickActionCursorHideTimer: number;
  playerAiQuickActionSubmitting: boolean;
  playerAiQuickActionSuppressedUntil: number;
};

type PlayerAiSetters = {
  setObserver(value: MutationObserver | null): void;
  setLayoutBound(value: boolean): void;
  setSyncTimer(value: number): void;
  setRevealTimer(value: number): void;
  setHideTimer(value: number): void;
  setCursorHideTimer(value: number): void;
  setSubmitting(value: boolean): void;
  setSuppressedUntil(value: number): void;
};

export type PlayerAiState = Readonly<PlayerAiBusinessState> & PlayerAiSetters;
type PlayerAiStateWritable = PlayerAiBusinessState & PlayerAiSetters;

export const playerAiState: PlayerAiStateWritable = {
  playerAiQuickActionObserver: null,
  playerAiQuickActionLayoutBound: false,
  playerAiQuickActionSyncTimer: 0,
  playerAiQuickActionRevealTimer: 0,
  playerAiQuickActionHideTimer: 0,
  playerAiQuickActionCursorHideTimer: 0,
  playerAiQuickActionSubmitting: false,
  playerAiQuickActionSuppressedUntil: 0,
  setObserver(value) { this.playerAiQuickActionObserver = value; },
  setLayoutBound(value) { this.playerAiQuickActionLayoutBound = value; },
  setSyncTimer(value) { this.playerAiQuickActionSyncTimer = value; },
  setRevealTimer(value) { this.playerAiQuickActionRevealTimer = value; },
  setHideTimer(value) { this.playerAiQuickActionHideTimer = value; },
  setCursorHideTimer(value) { this.playerAiQuickActionCursorHideTimer = value; },
  setSubmitting(value) { this.playerAiQuickActionSubmitting = value; },
  setSuppressedUntil(value) { this.playerAiQuickActionSuppressedUntil = value; }
};

// reader-enter 的意图级写入点：抑制快捷按钮 2.5s（等阅读模式
// URL 翻转与重域装载完成）。message-handler 只应表达意图，不碰具体槽位。
export function suppressUntil(timestamp: number): void {
  playerAiState.setSuppressedUntil(timestamp);
}
