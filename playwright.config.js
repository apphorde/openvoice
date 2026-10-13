import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  reporter: "list",
  use: {
    baseURL: process.env.SESSION_VOICE_BASE_URL || "http://127.0.0.1:43173",
    headless: true,
    serviceWorkers: "block",
  },
  webServer: process.env.SESSION_VOICE_BASE_URL
    ? undefined
    : {
        command: "node server.js",
        env: {
          HOST: "127.0.0.1",
          PORT: "43173",
          APP_URL: "http://127.0.0.1:43173",
          OPENCODE_URL: "http://127.0.0.1:9",
          OIDC_ISSUER: "",
          OIDC_CLIENT_ID: "",
          OIDC_CLIENT_SECRET: "",
          OPENAI_API_KEY: "",
          DATA_FILE: "/tmp/opencode/session-voice-e2e-goals.json",
        },
        url: "http://127.0.0.1:43173/healthz",
        reuseExistingServer: false,
        timeout: 10_000,
      },
});
