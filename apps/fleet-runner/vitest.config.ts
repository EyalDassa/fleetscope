import { defineConfig } from "vitest/config";

// Unit tests only: a fake HTTP server and fake pages, no Docker and no real browser.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
