/** Grid selection (spec 4.1): a rectangle of cells, or whole rows. */
export type Selection =
  | { mode: "cells"; anchor: Cell; focus: Cell }
  | { mode: "rows"; rows: number[]; anchor: number };

interface Cell {
  row: number;
  col: number;
}

export interface Bounds {
  rows: number[];
  cols: number[];
}

function range(a: number, b: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** Rows and columns covered by a selection, in display order. */
export function selectionBounds(sel: Selection, columnCount: number): Bounds {
  if (sel.mode === "rows") {
    return {
      rows: sel.rows.toSorted((a, b) => a - b),
      cols: range(0, columnCount - 1),
    };
  }
  return {
    rows: range(sel.anchor.row, sel.focus.row),
    cols: range(sel.anchor.col, sel.focus.col),
  };
}

export function isCellSelected(sel: Selection | null, row: number, col: number): boolean {
  if (!sel) {
    return false;
  }
  if (sel.mode === "rows") {
    return sel.rows.includes(row);
  }
  const { anchor: a, focus: f } = sel;
  return (
    row >= Math.min(a.row, f.row) &&
    row <= Math.max(a.row, f.row) &&
    col >= Math.min(a.col, f.col) &&
    col <= Math.max(a.col, f.col)
  );
}

/** The row shown in the detail sidebar: the anchor of a cell selection or the last clicked row. */
export function activeRow(sel: Selection | null): number | null {
  if (!sel) {
    return null;
  }
  return sel.mode === "cells" ? sel.focus.row : sel.anchor;
}

/** Selects a single cell. */
export function cellSelection(row: number, col: number): Selection {
  return { mode: "cells", anchor: { row, col }, focus: { row, col } };
}

/** Moves (or with `extend`, grows) a cell selection by a step, clamped to the grid. */
export function moveSelection(
  sel: Selection | null,
  dRow: number,
  dCol: number,
  extend: boolean,
  rowCount: number,
  colCount: number,
): Selection | null {
  if (rowCount === 0 || colCount === 0) {
    return sel;
  }
  const clamp = (c: Cell): Cell => ({
    row: Math.max(0, Math.min(rowCount - 1, c.row)),
    col: Math.max(0, Math.min(colCount - 1, c.col)),
  });
  if (!sel) {
    return cellSelection(0, 0);
  }
  const base: Cell = sel.mode === "cells" ? sel.focus : { row: sel.anchor, col: 0 };
  const next = clamp({ row: base.row + dRow, col: base.col + dCol });
  if (extend && sel.mode === "cells") {
    return { ...sel, focus: next };
  }
  return { mode: "cells", anchor: next, focus: next };
}

/** Handles a click on a row number: plain, Shift (range) or ⌘/Ctrl (toggle). */
export function clickRow(
  sel: Selection | null,
  row: number,
  shift: boolean,
  toggle: boolean,
): Selection | null {
  if (toggle && sel?.mode === "rows") {
    const rows = sel.rows.includes(row) ? sel.rows.filter((r) => r !== row) : [...sel.rows, row];
    return rows.length ? { mode: "rows", rows, anchor: row } : null;
  }
  if (shift && sel?.mode === "rows") {
    return { mode: "rows", rows: range(sel.anchor, row), anchor: sel.anchor };
  }
  return { mode: "rows", rows: [row], anchor: row };
}
