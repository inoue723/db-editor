import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const profile = {
  id: "a",
  name: "local",
  color: "#2f8a57",
  environment: "development",
  group: "",
  host: "localhost",
  port: 5432,
  database: "shop",
  user: "app",
  ssl: { mode: "prefer", rootCert: null, clientCert: null, clientKey: null },
  readOnly: false,
  lastUsedAt: null,
};

const column = (name: string, typeName: string, category: string, extra = {}) => ({
  name,
  typeName,
  category,
  notNull: false,
  default: null,
  comment: null,
  identity: false,
  generated: false,
  enumValues: [],
  ...extra,
});

const responses = {
  session_connect: { profile, database: "shop", serverVersion: "17.2" },
  load_schemas: [
    {
      name: "public",
      relations: [{ name: "users", kind: "table", estimatedRows: 2 }],
      functions: [],
      types: [],
    },
  ],
  list_saved_queries: [],
  list_databases: ["shop"],
  load_keybindings: { path: "/config/keybindings.json", bindings: [] },
  table_info: {
    schema: "public",
    name: "users",
    kind: "table",
    comment: null,
    estimatedRows: 2,
    columns: [
      column("id", "bigint", "N", { notNull: true, identity: true }),
      column("name", "text", "S"),
      column("age", "integer", "N"),
    ],
    keyColumns: ["id"],
    foreignKeys: [],
    references: [],
    indexes: [],
    constraints: [],
  },
  fetch_page: {
    columns: ["id", "name", "age"],
    rows: [
      ["1", "Ann", "30"],
      ["2", "Bob", null],
    ],
    next: null,
    elapsedMs: 3,
    sql: "",
  },
  preview_changes: ['UPDATE "public"."users" SET "name" = \'Anna\' WHERE "id" = \'1\' RETURNING *'],
  save_changes: {
    kind: "saved",
    columns: ["id", "name", "age"],
    rows: [["1", "Anna", "30"]],
    elapsedMs: 2,
  },
  read_clipboard: { text: "Carl\t41\nDora\t52\n", cells: null },
  parse_tsv: [
    ["Carl", "41"],
    ["Dora", "52"],
  ],
};

async function openUsers(page: Page) {
  await page.goto("/?connection=a");
  await page.getByRole("treeitem", { name: /users/ }).click();
  const grid = page.getByRole("grid", { name: "public.users" });
  await expect(grid).toContainText("Ann");
  const mac = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
  );
  return { grid, mod: mac ? "Meta" : "Control" };
}

test("edits a cell, undoes and redoes it, then saves", async ({ page, mockIpc, ipcCalls }) => {
  await mockIpc(responses);
  const { grid, mod } = await openUsers(page);

  await grid.getByRole("cell", { name: "Ann" }).dblclick();
  const editor = grid.getByLabel("name を編集");
  await editor.fill("Anna");
  await editor.press("Enter");
  await expect(grid.locator("td.ed")).toHaveText("Anna");
  await expect(page.locator("output.dirty")).toHaveText("未保存 1行");

  await page.keyboard.press(`${mod}+z`);
  await expect(grid.locator("td.ed")).toHaveCount(0);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(grid.locator("td.ed")).toHaveText("Anna");

  await page.keyboard.press(`${mod}+s`);
  await expect.poll(ipcCalls).toContainEqual({
    cmd: "save_changes",
    args: {
      changes: {
        schema: "public",
        table: "users",
        keyColumns: ["id"],
        changes: [
          {
            kind: "update",
            key: ["1"],
            values: [{ column: "name", value: { kind: "value", text: "Anna" } }],
          },
        ],
      },
      allowWrites: false,
    },
  });
  await expect(grid.locator("td.ed")).toHaveCount(0);
  await expect(grid).toContainText("Anna");
  await expect(page.locator("output.dirty")).toHaveCount(0);
});

test("pastes rows, marks deletes and adds rows from the command palette", async ({
  page,
  mockIpc,
}) => {
  await mockIpc(responses);
  const { grid, mod } = await openUsers(page);

  // A two-row block pasted on a cell of the last row overflows into a new row.
  await grid.getByRole("cell", { name: "Bob" }).click();
  await expect(grid).toBeFocused();
  await page.keyboard.press(`${mod}+v`);
  await page.getByRole("button", { name: "追加して貼り付け" }).click();
  await expect(grid.locator("td.ed")).toHaveText(["Carl", "41"]);
  await expect(grid.locator("tr.ins")).toHaveCount(1);
  await expect(grid.locator("tr.ins")).toContainText("Dora");

  // Delete the first row (marked, not removed).
  await grid.getByRole("cell", { name: "Ann" }).click();
  await page.keyboard.press(`${mod}+Backspace`);
  await expect(grid.locator("tr.del")).toContainText("Ann");
  await expect(page.locator("output.dirty")).toHaveText("未保存 3行");

  // The palette finds commands by Japanese or English names.
  await page.keyboard.press(`${mod}+Shift+p`);
  const palette = page.getByRole("dialog", { name: "コマンドパレット" });
  await palette.getByLabel("検索").fill(">insert row");
  await expect(palette.getByRole("button").first()).toContainText("行を追加");
  await palette.getByLabel("検索").press("Enter");
  await expect(grid.locator("tr.ins")).toHaveCount(2);
  await expect(page.locator("output.dirty")).toHaveText("未保存 4行");
});

test("rebinds a command in the shortcut editor", async ({ page, mockIpc, ipcCalls }) => {
  await mockIpc({ ...responses, save_keybindings: null });
  const { mod } = await openUsers(page);

  await page.keyboard.press(`${mod}+k`);
  await page.keyboard.press(`${mod}+s`);
  const dialog = page.getByRole("dialog", { name: "キーボードショートカット" });
  await dialog.getByLabel("コマンドを検索").fill("行を複製");
  await dialog.getByRole("button", { name: "行を複製 にキーを追加" }).click();
  await page.keyboard.press(`${mod}+Shift+d`);
  await expect.poll(ipcCalls).toContainEqual({
    cmd: "save_keybindings",
    args: { bindings: [{ key: "mod+shift+d", command: "table.duplicateRow" }] },
  });
  await expect(dialog.locator(".chip.custom")).toBeVisible();
});
