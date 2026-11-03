import { test as base } from "@playwright/test";

/** Maps a command name to the value it resolves with. */
type Responses = Record<string, unknown>;

/**
 * Installs a fake `window.__TAURI_INTERNALS__.invoke` before the app loads,
 * the same hook that `@tauri-apps/api/mocks` uses in unit tests.
 * Calls are recorded so `ipcCalls()` can assert on them.
 */
export const test = base.extend<{
  mockIpc: (responses: Responses) => Promise<void>;
  ipcCalls: () => Promise<unknown>;
}>({
  mockIpc: async ({ page }, provide) => {
    await provide(async (responses) => {
      await page.addInitScript((table: Responses) => {
        const calls: unknown[] = [];
        Object.assign(window, {
          e2eIpcCalls: calls,
          __TAURI_INTERNALS__: {
            invoke: async (cmd: string, args: unknown) => {
              calls.push({ cmd, args });
              if (!(cmd in table)) {
                throw new Error(`no mock for command ${cmd}`);
              }
              return table[cmd];
            },
            transformCallback: () => 0,
          },
        });
      }, responses);
    });
  },
  ipcCalls: async ({ page }, provide) => {
    await provide(() => page.evaluate(() => Reflect.get(window, "e2eIpcCalls")));
  },
});

export { expect } from "@playwright/test";
