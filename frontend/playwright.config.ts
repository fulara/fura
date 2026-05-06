import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.FURA_SMOKE_PORT ?? "38738");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./smoke",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "dot" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `FURA_SKIP_FRONTEND_BUILD=1 FURA_TOKEN=dev FURA_PORT=${port} ./run-mock-rpc.sh`,
    cwd: "..",
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    stdout: "ignore",
    stderr: "pipe",
  },
});
