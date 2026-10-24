import { defineConfig } from "vitest/config";

// Unit tests only. They need neither Docker nor a network: ClickHouse and Grafana are replaced by
// fake fetch functions. The real thing is exercised by `pnpm grafana:check` in CI.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
