import { defineConfig } from "vitest/config";

// Needs a running ClickHouse (pnpm infra:up). Connection settings come from env or ../../.env.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["./test/load-env.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
