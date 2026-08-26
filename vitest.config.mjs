import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "https://www.bilibili.com/video/BV1test000000/"
      }
    },
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/setup.js"],
    clearMocks: true
  }
});
