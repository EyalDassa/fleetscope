import { defineConfig } from "vitest/config";

// Unit tests only: no Docker needed. Integration tests run with vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
  },
});
