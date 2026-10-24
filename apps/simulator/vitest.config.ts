import { defineConfig } from "vitest/config";

// Unit tests only: the generator is pure, the poster is tested against a fake HTTP server.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
