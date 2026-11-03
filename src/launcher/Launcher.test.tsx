import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import type { ConnectionProfile_Serialize } from "../bindings";
import { ToastProvider } from "../ui/Toast";
import { Launcher } from "./Launcher";

afterEach(() => {
  cleanup();
  clearMocks();
});

function profile(patch: Partial<ConnectionProfile_Serialize>): ConnectionProfile_Serialize {
  return {
    id: "a",
    name: "shop-dev",
    color: "#2f8a57",
    environment: "development",
    group: "仕事",
    host: "localhost",
    port: 5432,
    database: "shop",
    user: "app",
    ssl: { mode: "prefer", rootCert: null, clientCert: null, clientKey: null },
    readOnly: false,
    lastUsedAt: null,
    ...patch,
  };
}

const PROFILES = [
  profile({}),
  profile({
    id: "b",
    name: "shop-prod",
    environment: "production",
    host: "db.example.com",
    readOnly: true,
  }),
  profile({ id: "c", name: "blog", group: "", database: "blog" }),
];

function setup() {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "list_connections") {
      return PROFILES;
    }
    if (cmd === "open_connection_window") {
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  render(
    <ToastProvider>
      <Launcher />
    </ToastProvider>,
  );
  return calls;
}

test("lists saved connections by group and opens one on click", async () => {
  const calls = setup();
  const user = userEvent.setup();

  const card = await screen.findByRole("button", { name: /shop-prod/ });
  expect(card.textContent).toContain("本番");
  expect(card.textContent).toContain("読み取り専用");
  expect(screen.getByRole("heading", { name: "グループなし" })).toBeTruthy();

  await user.click(card);
  expect(calls).toContainEqual({ cmd: "open_connection_window", args: { id: "b" } });
});

test("filters by search text and by group", async () => {
  setup();
  const user = userEvent.setup();
  await screen.findByRole("button", { name: /shop-dev/ });

  await user.type(screen.getByRole("searchbox", { name: "接続を検索" }), "example");
  expect(screen.queryByRole("button", { name: /shop-dev/ })).toBeNull();
  expect(screen.getByRole("button", { name: /shop-prod/ })).toBeTruthy();

  await user.clear(screen.getByRole("searchbox", { name: "接続を検索" }));
  await user.click(screen.getByRole("button", { name: /^グループなし/ }));
  expect(screen.getByRole("button", { name: /blog/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /shop-prod/ })).toBeNull();
});
