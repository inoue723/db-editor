/**
 * Turns clipboard cells into edits (spec 4.3). What a paste does depends on the
 * selection: overwrite a cell or a rectangle, fill a range with one value, add rows
 * after selected rows, or (⌘⇧V) update rows whose key matches and add the rest.
 */

import type { CellValue } from "../bindings";

/** What the paste needs to know about a column. */
export interface PasteColumn {
  name: string;
  /** `pg_type.typcategory`; `S` (string) keeps empty cells as empty strings. */
  category: string;
  /** Generated columns cannot be written. */
  writable: boolean;
  /** Identity or serial: left to its default in added rows. */
  autoKey: boolean;
}

/** Clipboard cells; `null` is a NULL copied from this app's grid. */
export type Cells = (string | null)[][];

interface CellPut {
  /** Display row index. */
  row: number;
  column: string;
  value: CellValue;
}

export interface PastePlan {
  /** Writes to existing (displayed) rows. */
  writes: CellPut[];
  /** Rows to add, by column name. */
  newRows: Record<string, CellValue>[];
  /** The first clipboard row was column names. */
  header: boolean;
  /** Clipboard columns that matched no column (or a generated one) and were left out. */
  ignored: number;
}

/**
 * A cell value from the clipboard. Spreadsheets cannot tell NULL from an empty
 * string, so an empty cell is NULL except in text columns.
 */
export function cellValue(cell: string | null, column: PasteColumn): CellValue {
  if (cell === null || (cell === "" && column.category !== "S")) {
    return { kind: "null" };
  }
  return { kind: "value", text: cell };
}

/**
 * Whether the first row names columns: its cells are distinct and more than half of
 * them are column names (extra columns from a spreadsheet are allowed and ignored).
 */
export function isHeader(first: (string | null)[] | undefined, columns: PasteColumn[]): boolean {
  if (!first || first.length === 0 || new Set(first).size !== first.length) {
    return false;
  }
  const names = new Set(columns.map((c) => c.name));
  const matched = first.filter((c) => c !== null && names.has(c)).length;
  return matched * 2 > first.length;
}

/** For each clipboard column, the target column index (or -1), from a start column. */
function mapping(
  cells: Cells,
  columns: PasteColumn[],
  startCol: number,
): { header: boolean; targets: number[]; data: Cells } {
  const width = Math.max(0, ...cells.map((r) => r.length));
  const header = cells.length > 1 && isHeader(cells[0], columns);
  if (header) {
    const first = cells[0] ?? [];
    return {
      header,
      targets: first.map((name) => columns.findIndex((c) => c.name === name)),
      data: cells.slice(1),
    };
  }
  return {
    header,
    targets: Array.from({ length: width }, (_, j) =>
      startCol + j < columns.length ? startCol + j : -1,
    ),
    data: cells,
  };
}

function countIgnored(targets: number[], columns: PasteColumn[]): number {
  return targets.filter((t) => t < 0 || !columns[t]?.writable).length;
}

function rowValues(
  cells: (string | null)[],
  targets: number[],
  columns: PasteColumn[],
  blankAutoKeys: boolean,
): Record<string, CellValue> {
  const values: Record<string, CellValue> = {};
  targets.forEach((t, j) => {
    const col = columns[t];
    if (!col?.writable) {
      return;
    }
    values[col.name] =
      blankAutoKeys && col.autoKey ? { kind: "default" } : cellValue(cells[j] ?? "", col);
  });
  return values;
}

/**
 * Paste onto a cell selection. `rows` and `cols` are the selected display rows and
 * columns; `rowCount` is the number of displayed rows.
 */
export function planCellPaste(
  cells: Cells,
  columns: PasteColumn[],
  rows: number[],
  cols: number[],
  rowCount: number,
): PastePlan {
  const top = Math.min(...rows);
  const left = Math.min(...cols);
  const single = cells.length === 1 && cells[0]?.length === 1;
  if (single && rows.length * cols.length > 1) {
    // One value fills the whole selection.
    const writes: CellPut[] = [];
    for (const r of rows) {
      for (const c of cols) {
        const col = columns[c];
        if (col?.writable) {
          writes.push({ row: r, column: col.name, value: cellValue(cells[0]?.[0] ?? "", col) });
        }
      }
    }
    return { writes, newRows: [], header: false, ignored: 0 };
  }
  const { header, targets, data } = mapping(cells, columns, left);
  const writes: CellPut[] = [];
  const newRows: Record<string, CellValue>[] = [];
  data.forEach((line, i) => {
    const r = top + i;
    if (r >= rowCount) {
      newRows.push(rowValues(line, targets, columns, false));
      return;
    }
    targets.forEach((t, j) => {
      const col = columns[t];
      if (col?.writable) {
        writes.push({ row: r, column: col.name, value: cellValue(line[j] ?? "", col) });
      }
    });
  });
  return { writes, newRows, header, ignored: countIgnored(targets, columns) };
}

/**
 * Paste onto selected rows: every clipboard row becomes a new row. Identity and
 * serial keys are left to their default, so copied rows can be pasted as duplicates.
 */
export function planRowPaste(cells: Cells, columns: PasteColumn[]): PastePlan {
  const { header, targets, data } = mapping(cells, columns, 0);
  return {
    writes: [],
    newRows: data.map((line) => rowValues(line, targets, columns, true)),
    header,
    ignored: countIgnored(targets, columns),
  };
}

/**
 * "Paste matching the primary key" (⌘⇧V): rows whose key is displayed are updated,
 * the others are added as upserts. `findRow` maps key values to a display row.
 * Returns an error message when the clipboard has no value for a key column.
 */
export function planKeyPaste(
  cells: Cells,
  columns: PasteColumn[],
  keyColumns: string[],
  findRow: (key: (string | null)[]) => number | null,
): PastePlan | string {
  const { header, targets, data } = mapping(cells, columns, 0);
  const keyPositions = keyColumns.map((k) => targets.findIndex((t) => columns[t]?.name === k));
  if (keyColumns.length === 0) {
    return "このテーブルには主キーがありません";
  }
  if (keyPositions.some((p) => p < 0)) {
    return `主キー列(${keyColumns.join(", ")})の値がクリップボードにありません`;
  }
  const writes: CellPut[] = [];
  const newRows: Record<string, CellValue>[] = [];
  for (const line of data) {
    const key = keyPositions.map((p) => line[p] ?? null);
    const row = findRow(key);
    const values = rowValues(line, targets, columns, false);
    if (row === null) {
      newRows.push(values);
      continue;
    }
    for (const [column, value] of Object.entries(values)) {
      if (!keyColumns.includes(column)) {
        writes.push({ row, column, value });
      }
    }
  }
  return { writes, newRows, header, ignored: countIgnored(targets, columns) };
}
