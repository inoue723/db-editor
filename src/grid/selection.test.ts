import { expect, test } from "vitest";
import {
  activeRow,
  cellSelection,
  clickRow,
  isCellSelected,
  moveSelection,
  selectionBounds,
} from "./selection";

test("bounds of a cell rectangle drawn in any direction", () => {
  const sel = { mode: "cells" as const, anchor: { row: 3, col: 2 }, focus: { row: 1, col: 0 } };
  expect(selectionBounds(sel, 5)).toEqual({ rows: [1, 2, 3], cols: [0, 1, 2] });
  expect(isCellSelected(sel, 2, 1)).toBe(true);
  expect(isCellSelected(sel, 4, 1)).toBe(false);
  expect(activeRow(sel)).toBe(1);
});

test("row selections cover every column, in display order", () => {
  const sel = { mode: "rows" as const, rows: [4, 1], anchor: 1 };
  expect(selectionBounds(sel, 3)).toEqual({ rows: [1, 4], cols: [0, 1, 2] });
  expect(isCellSelected(sel, 4, 2)).toBe(true);
});

test("arrow keys move and Shift+arrow grows, clamped to the grid", () => {
  const moved = moveSelection(cellSelection(0, 0), -1, 1, false, 10, 2);
  expect(moved).toEqual(cellSelection(0, 1));
  const grown = moveSelection(moved, 5, 5, true, 3, 2);
  expect(grown).toEqual({ mode: "cells", anchor: { row: 0, col: 1 }, focus: { row: 2, col: 1 } });
  expect(moveSelection(null, 1, 1, false, 3, 3)).toEqual(cellSelection(0, 0));
});

test("row-number clicks: plain, Shift range and ⌘ toggle", () => {
  const one = clickRow(null, 2, false, false);
  expect(one).toEqual({ mode: "rows", rows: [2], anchor: 2 });
  expect(clickRow(one, 5, true, false)).toEqual({ mode: "rows", rows: [2, 3, 4, 5], anchor: 2 });
  const two = clickRow(one, 7, false, true);
  expect(two).toEqual({ mode: "rows", rows: [2, 7], anchor: 7 });
  expect(clickRow(clickRow(two, 2, false, true), 7, false, true)).toBeNull();
});
