/**
 * Unsaved changes of a table tab (spec 3.5). Edits are kept apart from the loaded
 * rows and drawn on top of them: edited cells yellow, added rows green, rows to be
 * deleted struck through. Saving turns them into a {@link ChangeSet}.
 *
 * Loaded rows are identified by their key values, so edits survive loading more
 * pages or reloading.
 */

import type { CellValue, ChangeSet, RowChange, Saved } from "../bindings";
import type { GridRow } from "../grid/types";

export type { CellValue };

interface PendingInsert {
  id: string;
  /** Key of the loaded row this row is shown after; `null` for the top. */
  after: string | null;
  /** Values by column name; missing columns get their default. */
  values: Record<string, CellValue>;
  /** Update the existing row when the key exists (paste matching the primary key). */
  upsert: boolean;
}

export interface EditState {
  /** Changed cells by row key, then column name. */
  updates: Record<string, Record<string, CellValue>>;
  /** Keys of rows to delete. */
  deletes: string[];
  inserts: PendingInsert[];
}

export const NO_EDITS: EditState = { updates: {}, deletes: [], inserts: [] };

/** A row as shown: a loaded row (by its position in the loaded rows) or an added one. */
export type RowRef =
  | { kind: "loaded"; index: number; key: string }
  | { kind: "insert"; id: string };

/** The identity of a loaded row: its key values as JSON. */
export function rowKey(row: GridRow, keyIndexes: number[]): string {
  return JSON.stringify(keyIndexes.map((i) => row[i] ?? null));
}

/** Loaded rows with the added rows placed after the rows they were added after. */
export function displayRows(loaded: GridRow[], keyIndexes: number[], state: EditState): RowRef[] {
  const byAfter = new Map<string | null, PendingInsert[]>();
  const keys = loaded.map((r) => rowKey(r, keyIndexes));
  const present = new Set(keys);
  for (const ins of state.inserts) {
    // Rows added after a row that is no longer loaded go to the top.
    const after = ins.after !== null && present.has(ins.after) ? ins.after : null;
    const list = byAfter.get(after) ?? [];
    list.push(ins);
    byAfter.set(after, list);
  }
  const out: RowRef[] = (byAfter.get(null) ?? []).map((i) => ({ kind: "insert", id: i.id }));
  keys.forEach((key, index) => {
    out.push({ kind: "loaded", index, key });
    for (const ins of byAfter.get(key) ?? []) {
      out.push({ kind: "insert", id: ins.id });
    }
  });
  return out;
}

function text(v: CellValue | undefined, fallback: string | null): string | null {
  if (!v) {
    return fallback;
  }
  return v.kind === "value" ? v.text : null;
}

/** The values of a row as shown, with its edits applied. DEFAULT shows as `null`. */
export function displayValues(
  ref: RowRef,
  loaded: GridRow[],
  columns: string[],
  state: EditState,
): GridRow {
  if (ref.kind === "insert") {
    const ins = state.inserts.find((i) => i.id === ref.id);
    return columns.map((c) => text(ins?.values[c], null));
  }
  const row = loaded[ref.index] ?? [];
  const upd = state.updates[ref.key];
  return columns.map((c, i) => text(upd?.[c], row[i] ?? null));
}

export type CellStatus = "edited" | "default" | null;

export function cellStatus(ref: RowRef, column: string, state: EditState): CellStatus {
  const v =
    ref.kind === "insert"
      ? state.inserts.find((i) => i.id === ref.id)?.values[column]
      : state.updates[ref.key]?.[column];
  if (ref.kind === "insert") {
    return !v || v.kind === "default" ? "default" : null;
  }
  if (!v) {
    return null;
  }
  return v.kind === "default" ? "default" : "edited";
}

export type RowStatus = "inserted" | "deleted" | null;

export function rowStatus(ref: RowRef, state: EditState): RowStatus {
  if (ref.kind === "insert") {
    return "inserted";
  }
  return state.deletes.includes(ref.key) ? "deleted" : null;
}

/** Number of rows with unsaved changes. */
export function changeCount(state: EditState): number {
  const updated = Object.keys(state.updates).filter((k) => !state.deletes.includes(k)).length;
  return updated + state.deletes.length + state.inserts.length;
}

export interface CellWrite {
  ref: RowRef;
  column: string;
  value: CellValue;
  /** The loaded value, so that typing it back removes the edit. */
  original: string | null;
}

function same(value: CellValue, original: string | null): boolean {
  return value.kind === "null"
    ? original === null
    : value.kind === "value" && value.text === original;
}

/** Applies cell writes (one undo step for the caller). */
export function setCells(state: EditState, writes: CellWrite[]): EditState {
  let updates = state.updates;
  let inserts = state.inserts;
  for (const w of writes) {
    if (w.ref.kind === "insert") {
      const id = w.ref.id;
      inserts = inserts.map((i) =>
        i.id === id ? { ...i, values: { ...i.values, [w.column]: w.value } } : i,
      );
      continue;
    }
    const row = { ...updates[w.ref.key] };
    if (same(w.value, w.original)) {
      delete row[w.column];
    } else {
      row[w.column] = w.value;
    }
    updates = { ...updates };
    if (Object.keys(row).length === 0) {
      delete updates[w.ref.key];
    } else {
      updates[w.ref.key] = row;
    }
  }
  return { ...state, updates, inserts };
}

let insertCounter = 0;

/** A fresh id for an added row. */
function newInsertId(): string {
  insertCounter += 1;
  return `new-${Date.now().toString(36)}-${insertCounter}`;
}

/** Adds rows after a loaded row (or at the top). Returns the new state and the row ids. */
export function insertRows(
  state: EditState,
  after: string | null,
  rows: Record<string, CellValue>[],
  upsert = false,
  /** Insert before this added row (to keep pasted rows in order after an added row). */
  afterInsert?: string,
): { state: EditState; ids: string[] } {
  const added = rows.map((values) => ({ id: newInsertId(), after, values, upsert }));
  const inserts = [...state.inserts];
  const at = afterInsert ? inserts.findIndex((i) => i.id === afterInsert) : -1;
  if (at >= 0) {
    inserts.splice(at + 1, 0, ...added);
  } else {
    // Rows with the same anchor are shown in the order they were added.
    inserts.push(...added);
  }
  return { state: { ...state, inserts }, ids: added.map((a) => a.id) };
}

/** Marks loaded rows for deletion and drops added rows. */
export function deleteRows(state: EditState, refs: RowRef[]): EditState {
  const dropped = new Set(refs.filter((r) => r.kind === "insert").map((r) => r.id));
  const deletes = [...state.deletes];
  for (const r of refs) {
    if (r.kind === "loaded" && !deletes.includes(r.key)) {
      deletes.push(r.key);
    }
  }
  return {
    ...state,
    deletes,
    inserts: state.inserts.filter((i) => !dropped.has(i.id)),
  };
}

/** The key values of a row key. */
function parseKey(key: string): (string | null)[] {
  const parsed: unknown = JSON.parse(key);
  return Array.isArray(parsed)
    ? parsed.map((v: unknown) => (typeof v === "string" ? v : null))
    : [];
}

/** Which row each change of a change set came from. */
export type ChangeSource = { kind: "loaded"; key: string } | { kind: "insert"; id: string };

/** Turns the edits into the change set to save: deletes, then updates, then inserts. */
export function toChangeSet(
  state: EditState,
  table: { schema: string; table: string; keyColumns: string[] },
): { set: ChangeSet; sources: ChangeSource[] } {
  const changes: RowChange[] = [];
  const sources: ChangeSource[] = [];
  for (const key of state.deletes) {
    changes.push({ kind: "delete", key: parseKey(key) });
    sources.push({ kind: "loaded", key });
  }
  for (const [key, cols] of Object.entries(state.updates)) {
    if (state.deletes.includes(key)) {
      continue;
    }
    changes.push({
      kind: "update",
      key: parseKey(key),
      values: Object.entries(cols).map(([column, value]) => ({ column, value })),
    });
    sources.push({ kind: "loaded", key });
  }
  for (const ins of state.inserts) {
    changes.push({
      kind: "insert",
      upsert: ins.upsert,
      values: Object.entries(ins.values).map(([column, value]) => ({ column, value })),
    });
    sources.push({ kind: "insert", id: ins.id });
  }
  return {
    set: { schema: table.schema, table: table.table, keyColumns: table.keyColumns, changes },
    sources,
  };
}

/**
 * The loaded rows after a successful save: deleted rows removed, and changed and
 * added rows replaced by what the server stored (`RETURNING *`), in display order.
 */
export function rowsAfterSave(
  loaded: GridRow[],
  columns: string[],
  keyIndexes: number[],
  state: EditState,
  sources: ChangeSource[],
  saved: Saved,
): GridRow[] {
  const positions = columns.map((c) => saved.columns.indexOf(c));
  const stored = (i: number): GridRow | null => {
    const row = saved.rows[i];
    return row ? positions.map((p) => (p >= 0 ? (row[p] ?? null) : null)) : null;
  };
  const byKey = new Map<string, GridRow | null>();
  const byInsert = new Map<string, GridRow | null>();
  sources.forEach((s, i) => {
    if (s.kind === "loaded") {
      byKey.set(s.key, stored(i));
    } else {
      byInsert.set(s.id, stored(i));
    }
  });
  const out: GridRow[] = [];
  for (const ref of displayRows(loaded, keyIndexes, state)) {
    if (ref.kind === "insert") {
      const row = byInsert.get(ref.id);
      if (row) {
        out.push(row);
      }
      continue;
    }
    if (state.deletes.includes(ref.key)) {
      continue;
    }
    const row = byKey.get(ref.key);
    out.push(row ?? loaded[ref.index] ?? []);
  }
  return out;
}
