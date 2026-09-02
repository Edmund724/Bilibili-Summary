// Local type declarations for JS modules consumed by the reader domain.
// These modules live outside reader/ and are being migrated by other agents;
// declaring their surface here keeps reader/ strict without editing shared files.

declare module "../subtitle/core.js" {
  export interface ReadingSubtitleItem {
    index: number;
    from: number;
    to: number;
    content: string;
  }

  export function getReadingSubtitleItems(
    body?: Array<{ from?: number; to?: number; content?: string }>
  ): ReadingSubtitleItem[];
  export function getReadingSubtitlePlaceholderText(): string;
  export function findActiveSubtitleIndex(currentTime: number): number;
  export function findActiveChapterIndex(currentTime: number): number;
}

declare module "../subtitle/selection.js" {
  export interface NormalizedChapter {
    title: string;
    from: number;
    to?: number;
  }

  export function normalizeChapters(chapters: unknown): NormalizedChapter[];
  export function isAiSubtitle(item: unknown): boolean;
}

declare module "../subtitle/lazy.js" {
  export function ensureSummarizeChain(): Promise<unknown>;
}

declare module "../notes/render.js" {
  import type { State } from "../core/state.js";

  export function shouldShowHoursInNote(state: State, body: unknown[]): boolean;
}

declare module "../ui/ui-renderer.js" {
  export function buildUiHtml(): string;
  export function bindUiEvents(): void;
  export function ensureUiReady(options?: { forceRecreate?: boolean }): void;
  export function setStatus(text: string): void;
  export function setMessage(text: string): void;
}
