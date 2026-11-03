/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import process from "node:process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env["TAURI_DEV_HOST"];
const packageJson: unknown = JSON.parse(
  readFileSync(new URL("package.json", import.meta.url), "utf8"),
);
const version =
  typeof packageJson === "object" && packageJson !== null && "version" in packageJson
    ? String(packageJson.version)
    : "unknown";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Shown in the UI so an installed build can be told apart, e.g. after an auto-update.
  define: { "import.meta.env.APP_VERSION": JSON.stringify(version) },
  // Keep Rust errors visible in `tauri dev`.
  clearScreen: false,
  server: {
    // Tauri expects a fixed port.
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
