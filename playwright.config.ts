import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      HOSTNAME: "127.0.0.1",
      PORT: "3100",
      TURSO_DATABASE_URL: "file:.data/e2e.db",
      APP_PASSWORD: "branchlab-e2e-password",
      OPENAI_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      ENABLE_LOCAL_MODELS: "false",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
