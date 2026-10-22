import { defineConfig } from "vitest/config";

// Unit tests only: ClickHouse is faked. Integration tests use vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
  },
});
