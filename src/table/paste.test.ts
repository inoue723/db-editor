import { expect, test } from "vitest";
import {
  cellValue,
  isHeader,
  type PasteColumn,
  planCellPaste,
  planKeyPaste,
  planRowPaste,
} from "./paste";

const id: PasteColumn = { name: "id", category: "N", writable: true, autoKey: true };
const name: PasteColumn = { name: "name", category: "S", writable: true, autoKey: false };
const age: PasteColumn = { name: "age", category: "N", writable: true, autoKey: false };
const upper: PasteColumn = { name: "upper", category: "S", writable: false, autoKey: false };
const columns = [id, name, age, upper];
const v = (text: string) => ({ kind: "value", text });
const NULL = { kind: "null" };

test("empty cells are NULL except in text columns; copied NULLs stay NULL", () => {
  expect(cellValue("", age)).toEqual(NULL);
  expect(cellValue("", name)).toEqual(v(""));
  expect(cellValue(null, name)).toEqual(NULL);
});

test("one value fills the selection", () => {
  const plan = planCellPaste([["x"]], columns, [0, 1], [1, 3], 5);
  // The generated column is skipped.
  expect(plan.writes).toEqual([
    { row: 0, column: "name", value: v("x") },
    { row: 1, column: "name", value: v("x") },
  ]);
});

test("a block pastes from the top-left cell and overflows into new rows", () => {
  const plan = planCellPaste(
    [
      ["a", "1", "z"],
      ["b", "", "z"],
    ],
    columns,
    [1],
    [1],
    2,
  );
  expect(plan.writes).toEqual([
    { row: 1, column: "name", value: v("a") },
    { row: 1, column: "age", value: v("1") },
  ]);
  expect(plan.newRows).toEqual([{ name: v("b"), age: NULL }]);
  // "z" went to the generated column.
  expect(plan.ignored).toBe(1);
});

test("a header row maps columns by name", () => {
  expect(isHeader(["age", "name"], columns)).toBe(true);
  expect(isHeader(["age", "nope"], columns)).toBe(false);
  const plan = planCellPaste(
    [
      ["age", "name", "extra"],
      ["30", "Ann"],
    ],
    columns,
    [0],
    [0],
    3,
  );
  expect(plan.header).toBe(true);
  expect(plan.writes).toEqual([
    { row: 0, column: "age", value: v("30") },
    { row: 0, column: "name", value: v("Ann") },
  ]);
  expect(plan.ignored).toBe(1);
});

test("pasting on rows adds rows and leaves identity keys to the server", () => {
  const plan = planRowPaste([["7", "Bob", "40"]], columns);
  expect(plan.newRows).toEqual([{ id: { kind: "default" }, name: v("Bob"), age: v("40") }]);
});

test("paste matching the key updates shown rows and upserts the rest", () => {
  const plan = planKeyPaste(
    [
      ["id", "name"],
      ["1", "A"],
      ["9", "Z"],
    ],
    columns,
    ["id"],
    (key) => (key[0] === "1" ? 0 : null),
  );
  expect(plan).toEqual({
    writes: [{ row: 0, column: "name", value: v("A") }],
    newRows: [{ id: v("9"), name: v("Z") }],
    header: true,
    ignored: 0,
  });
  expect(planKeyPaste([["Bob"]], columns.slice(1), ["id"], () => null)).toMatch(/主キー列/);
});
