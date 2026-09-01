import type { State, ReaderState, ClipState } from "../../extension/core/state.js";
import type { Mock } from "vitest";

type Writable<T> = { -readonly [K in keyof T]: T[K] };

export type TestState = Omit<State, "reader" | "readerState" | "clip" | "clipState"> & {
  reader: Writable<ReaderState>;
  readerState: Writable<ReaderState>;
  clip: Writable<ClipState>;
  clipState: Writable<ClipState>;
};

export interface ChromeRuntimeStub {
  runtime: {
    sendMessage: Mock<(...args: any[]) => any>;
  };
  storage: {
    onChanged: {
      addListener: Mock<(...args: any[]) => any>;
    };
  };
}

declare global {
  interface HTMLVideoElement {
    __bocReadingSyncHandler?: ((event: Event) => void) | undefined;
  }

  interface Window {
    chrome: ChromeRuntimeStub;
  }

  interface globalThis {
    chrome: ChromeRuntimeStub;
  }
}

export {};
