import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.FURA_BTW_BASE_URL;
const evidence = process.env.FURA_BTW_EVIDENCE_DIR;
if (!baseURL || !evidence || new URL(baseURL).hostname !== "127.0.0.1") {
  throw new Error("BTW smoke requires an explicitly owned loopback FURA_BTW_BASE_URL and outside-repo FURA_BTW_EVIDENCE_DIR.");
}
export default defineConfig({
  testDir: "./smoke",
  testMatch: process.env.FURA_BTW_REAL === "1" ? "transcript-btw-real.spec.ts" : "transcript-btw.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: `${evidence}/playwright`,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], channel: "chrome", baseURL, viewport: { width: 1440, height: 1000 }, serviceWorkers: "block", trace: "off" },
});
