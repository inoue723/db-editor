import process from "node:process";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run the frontend in a browser with Tauri IPC mocked (see e2e/fixtures.ts).
 * WebKit is the closest engine to the app's WebViews (WKWebView on macOS, WebKitGTK on Linux).
 */
export default defineConfig({
  testDir: "e2e",
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Lets a machine with a preinstalled Chromium skip `playwright install`.
        launchOptions: { executablePath: process.env["PW_CHROMIUM_PATH"] },
      },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env["CI"],
  },
});
