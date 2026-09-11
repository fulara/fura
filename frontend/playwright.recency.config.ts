import { defineConfig, devices } from "@playwright/test";

if (!process.env.FURA_RECENCY_BINARY || !process.env.FURA_RECENCY_STATIC_DIR || !process.env.FURA_RECENCY_EVIDENCE_DIR) {
  throw new Error("Set FURA_RECENCY_BINARY, FURA_RECENCY_STATIC_DIR and FURA_RECENCY_EVIDENCE_DIR to isolated paths before running this regression.");
}

export default defineConfig({
  testDir: "./smoke",
  testMatch: "session-recency.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: `${process.env.FURA_RECENCY_EVIDENCE_DIR}/playwright-${process.env.FURA_RECENCY_PHASE ?? "after"}`,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1366, height: 900 },
    serviceWorkers: "block",
    trace: "off",
  },
});
