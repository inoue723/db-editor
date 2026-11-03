import { expect, test } from "./fixtures";

const profile = {
  id: "b",
  name: "shop-prod",
  color: "#c8352b",
  environment: "production",
  group: "仕事",
  host: "db.example.com",
  port: 5432,
  database: "shop",
  user: "app",
  ssl: { mode: "verify-full", rootCert: null, clientCert: null, clientKey: null },
  readOnly: true,
  lastUsedAt: null,
};

test("opens a saved connection from the launcher", async ({ page, mockIpc, ipcCalls }) => {
  await mockIpc({ list_connections: [profile], open_connection_window: null });
  await page.goto("/");

  const card = page.getByRole("button", { name: /shop-prod/ });
  await expect(card).toContainText("app@db.example.com:5432/shop");
  await expect(card).toContainText("読み取り専用");
  await card.click();

  await expect.poll(ipcCalls).toContainEqual({ cmd: "open_connection_window", args: { id: "b" } });
});

test("new connection dialog fills fields from a pasted URL", async ({ page, mockIpc }) => {
  await mockIpc({
    list_connections: [],
    parse_connection_url: {
      user: "app",
      password: "secret",
      host: "db.example.com",
      port: 6432,
      database: "shop",
      sslMode: "require",
    },
  });
  await page.goto("/");

  await page.getByRole("button", { name: "新しい接続" }).click();
  const dialog = page.getByRole("dialog", { name: "新しい接続" });
  await dialog
    .getByLabel("接続URL", { exact: true })
    .fill("postgres://app:secret@db.example.com:6432/shop");

  await expect(dialog.getByLabel("ホスト / ポート", { exact: true })).toHaveValue("db.example.com");
  await expect(dialog.getByLabel("ポート", { exact: true })).toHaveValue("6432");
  await expect(dialog.getByLabel("データベース", { exact: true })).toHaveValue("shop");
  await expect(dialog.getByLabel("名前", { exact: true })).toHaveValue("shop");
  await dialog.getByRole("tab", { name: "SSL" }).click();
  await expect(dialog.getByLabel("SSLモード", { exact: true })).toHaveValue("require");
});
