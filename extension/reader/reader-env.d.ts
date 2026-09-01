// Local ambient type augmentation for globals used inside reader/.

declare global {
  // Bilibili page globals used by page-context resolution.
  interface Window {
    __INITIAL_STATE__?: Record<string, unknown>;
    __PLAYER_STATE__?: Record<string, unknown>;
    __BILI_PLAYER__?: Record<string, unknown>;
  }

  // Debug helpers registered by init-essentials.js.
  var __BOC_READER_DEBUG_SNAPSHOT__:
    | ((label?: string) => Promise<Record<string, unknown> | null>)
    | undefined;
  var __BOC_FORCE_SYNC_PLAYER_AI__: (() => void) | undefined;
  var __BOC_DEBUG__: Record<string, unknown> | undefined;

  interface HTMLVideoElement {
    __bocReadingSyncHandler?: ((event: Event) => void) | undefined;
  }
}

export {};
