import { expect, test } from "./fixtures";

test("parses pasted TSV through the Rust command", async ({ page, mockIpc, ipcCalls }) => {
  await mockIpc({
    parse_tsv: [
      ["id", "name"],
      ["1", "Alice"],
    ],
  });
  await page.goto("/");

  await page.getByLabel("Paste TSV").fill("id\tname\n1\tAlice");
  await page.getByRole("button", { name: "Parse" }).click();

  await expect(page.getByRole("status")).toHaveText("2 rows × 2 columns");
  expect(await ipcCalls()).toEqual([{ cmd: "parse_tsv", args: { text: "id\tname\n1\tAlice" } }]);
});
