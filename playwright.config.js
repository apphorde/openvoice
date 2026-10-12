import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  reporter: "list",
  use: {
    baseURL: process.env.SESSION_VOICE_BASE_URL || "http://127.0.0.1:4173",
    headless: true,
  },
});
