import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/support/build-test-artifacts.ts"],
    maxWorkers: 2,
  },
});
