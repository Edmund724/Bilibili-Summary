import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "https://www.bilibili.com/video/BV1test000000/"
      }
    },
    include: ["tests/**/*.test.js", "tests/**/*.test.ts"],
    setupFiles: ["tests/setup.js"],
    clearMocks: true,
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["extension/**/*.js", "extension/**/*.ts"],
      exclude: ["extension/entry/content-classic.js", "extension/icons/**"]
    }
  }
});
