import { expect, test } from "vitest";
import {
  cellStatus,
  changeCount,
  deleteRows,
  displayRows,
  displayValues,
  insertRows,
  NO_EDITS,
  rowKey,
  rowStatus,
  rowsAfterSave,
  setCells,
  toChangeSet,
} from "./edits";

const columns = ["id", "name"];
const loaded = [
  ["1", "a"],
  ["2", "b"],
];
const keys = [0];
const table = { schema: "public", table: "users", keyColumns: ["id"] };
const ref = (index: number) => ({
  kind: "loaded" as const,
  index,
  key: rowKey(loaded[index] ?? [], keys),
});

test("edits show on top of loaded rows and typing the old value removes them", () => {
  let s = setCells(NO_EDITS, [
    { ref: ref(0), column: "name", value: { kind: "value", text: "x" }, original: "a" },
  ]);
  expect(displayValues(ref(0), loaded, columns, s)).toEqual(["1", "x"]);
  expect(cellStatus(ref(0), "name", s)).toBe("edited");
  expect(changeCount(s)).toBe(1);
  s = setCells(s, [
    { ref: ref(0), column: "name", value: { kind: "value", text: "a" }, original: "a" },
  ]);
  expect(s.updates).toEqual({});
  expect(changeCount(s)).toBe(0);
});

test("added rows are placed after their anchor and deleted rows are marked", () => {
  const { state, ids } = insertRows(NO_EDITS, ref(0).key, [{ name: { kind: "value", text: "n" } }]);
  const top = insertRows(state, null, [{}]);
  const s = deleteRows(top.state, [ref(1)]);
  const rows = displayRows(loaded, keys, s);
  expect(rows.map((r) => (r.kind === "insert" ? r.id : r.index))).toEqual([
    top.ids[0],
    0,
    ids[0],
    1,
  ]);
  const added = rows[2];
  expect(added && displayValues(added, loaded, columns, s)).toEqual([null, "n"]);
  expect(added && cellStatus(added, "id", s)).toBe("default");
  expect(rowStatus(ref(1), s)).toBe("deleted");
  // Deleting an added row just drops it.
  expect(added && deleteRows(s, [added]).inserts).toHaveLength(1);
});

test("a change set deletes, then updates, then inserts", () => {
  let s = setCells(NO_EDITS, [
    { ref: ref(0), column: "name", value: { kind: "null" }, original: "a" },
    { ref: ref(1), column: "name", value: { kind: "value", text: "gone" }, original: "b" },
  ]);
  s = deleteRows(s, [ref(1)]);
  s = insertRows(s, null, [{ id: { kind: "default" }, name: { kind: "value", text: "c" } }]).state;
  const { set, sources } = toChangeSet(s, table);
  expect(set.changes).toEqual([
    { kind: "delete", key: ["2"] },
    { kind: "update", key: ["1"], values: [{ column: "name", value: { kind: "null" } }] },
    {
      kind: "insert",
      upsert: false,
      values: [
        { column: "id", value: { kind: "default" } },
        { column: "name", value: { kind: "value", text: "c" } },
      ],
    },
  ]);
  expect(sources.map((x) => x.kind)).toEqual(["loaded", "loaded", "insert"]);

  const after = rowsAfterSave(loaded, columns, keys, s, sources, {
    columns: ["id", "name"],
    rows: [null, ["1", null], ["3", "c"]],
    elapsedMs: 1,
  });
  expect(after).toEqual([
    ["3", "c"],
    ["1", null],
  ]);
});
