import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 120_000,
  use: {
    channel: "chrome",
    headless: true,
  },
});
