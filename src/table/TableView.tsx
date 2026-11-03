import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CellValue,
  type ChangeSet,
  commands,
  type Filter,
  type ForeignKey,
  type PageCursor,
  type Reference,
  type SortKey,
  type TableInfo_Serialize,
} from "../bindings";
import { useCommands, useKeyLabel } from "../commands/CommandProvider";
import { DataGrid, type GridEditing, type GridHandle } from "../grid/DataGrid";
import { cellSelection, type Selection, selectionBounds } from "../grid/selection";
import { type GridColumn, type GridRow, isNumericType } from "../grid/types";
import { ApiError, call, errorMessage } from "../lib/api";
import type { MenuItem } from "../ui/Menu";
import { Confirm, Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import {
  type CellWrite,
  type ChangeSource,
  cellStatus,
  changeCount,
  deleteRows,
  displayRows,
  displayValues,
  type EditState,
  insertRows,
  NO_EDITS,
  type RowRef,
  rowStatus,
  rowsAfterSave,
  setCells,
  toChangeSet,
} from "./edits";
import { FilterBar } from "./FilterBar";
import {
  type Cells,
  type PasteColumn,
  type PastePlan,
  planCellPaste,
  planKeyPaste,
  planRowPaste,
} from "./paste";
import { RowDetail } from "./RowDetail";
import { StructureView } from "./StructureView";
import { useEdits } from "./useEdits";
import { invalidReason } from "./validate";

/** Pastes above this many rows ask first (spec 4.4). */
const LARGE_PASTE_ROWS = 1000;

export interface TableTabState {
  id: string;
  kind: "table";
  schema: string;
  table: string;
  view: "content" | "structure";
  filterOpen: boolean;
  filter: Filter | null;
  sort: SortKey[];
  /** Bumped to reload the rows (⌘R). */
  reload: number;
}

interface Props {
  tab: TableTabState;
  active: boolean;
  rightOpen: boolean;
  /** The connection is read-only: no editing. */
  readOnly: boolean;
  /** Production: every save shows its SQL and asks first. */
  production: boolean;
  /** Reports the number of rows with unsaved changes. */
  onDirty: (count: number) => void;
  onChange: (patch: Partial<TableTabState>) => void;
  onOpenTable: (schema: string, table: string, filter: Filter | null) => void;
  onStatus: (text: string) => void;
  onInfo: (info: TableInfo_Serialize) => void;
}

interface Data {
  columns: string[];
  rows: GridRow[];
  next: PageCursor | null;
  elapsedMs: number;
}

/** Equality conditions that open the rows a key points to. */
function equalsFilter(columns: string[], values: (string | null)[]): Filter {
  return {
    kind: "conditions",
    conditions: columns.map((column, i) => {
      const value = values[i] ?? null;
      return value === null
        ? { column, op: "isNull", value: "", conjunction: "and" }
        : { column, op: "eq", value, conjunction: "and" };
    }),
  };
}

function formatCount(n: number): string {
  return Math.round(n).toLocaleString("ja-JP");
}

/** A table tab: contents with filter and sort, row details, and the structure view. */
interface PendingSave {
  set: ChangeSet;
  sources: ChangeSource[];
  state: EditState;
  sql: string[];
}

interface Question {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export function TableView({
  tab,
  active,
  rightOpen,
  readOnly,
  production,
  onDirty,
  onChange,
  onOpenTable,
  onStatus,
  onInfo,
}: Props) {
  const toast = useToast();
  const keyLabel = useKeyLabel();
  const grid = useRef<GridHandle>(null);
  const edits = useEdits();
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ source: ChangeSource; message: string } | null>(
    null,
  );
  const [question, setQuestion] = useState<Question | null>(null);
  /** An added row to select once it is rendered. */
  const selectAfterRender = useRef<{ id: string; col: number } | null>(null);
  const [info, setInfo] = useState<TableInfo_Serialize | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRowIndex, setActiveRowIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const generation = useRef(0);
  // Set synchronously so that two scroll events never request the same page twice.
  const loadingMore = useRef(false);

  useEffect(() => {
    let cancelled = false;
    call(commands.tableInfo(tab.schema, tab.table)).then(
      (i) => {
        if (!cancelled) {
          setInfo(i);
          setInfoError(null);
          onInfo(i);
        }
      },
      (e: unknown) => !cancelled && setInfoError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
    // `tab.reload` is not read here: bumping it (⌘R) refetches the structure.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [tab.schema, tab.table, tab.reload, onInfo]);

  const load = useCallback(
    async (cursor: PageCursor, append: boolean) => {
      if (!info) {
        return;
      }
      const gen = append ? generation.current : ++generation.current;
      setLoading(true);
      if (!append) {
        setError(null);
      }
      try {
        const page = await call(
          commands.fetchPage({
            schema: tab.schema,
            table: tab.table,
            filter: tab.filter ?? { kind: "conditions", conditions: [] },
            sort: tab.sort,
            keyColumns: info.keyColumns,
            cursor,
          }),
        );
        if (gen !== generation.current) {
          return;
        }
        setData((prev) => ({
          columns: page.columns,
          rows: append && prev ? [...prev.rows, ...page.rows] : page.rows,
          next: page.next,
          elapsedMs: page.elapsedMs,
        }));
      } catch (e) {
        if (gen === generation.current) {
          setError(errorMessage(e));
          if (!append) {
            setData(null);
          }
        }
      } finally {
        if (gen === generation.current) {
          setLoading(false);
        }
      }
    },
    [info, tab.schema, tab.table, tab.filter, tab.sort],
  );

  useEffect(() => {
    if (info && tab.view === "content") {
      // oxlint-disable-next-line react/set-state-in-effect -- loads rows from the backend.
      void load({ kind: "start" }, false);
    }
    // `load` changes with the filter, the sort and the table info (refetched on ⌘R).
  }, [load, info, tab.view]);

  const columns: GridColumn[] = useMemo(() => {
    const names = data?.columns ?? info?.columns.map((c) => c.name) ?? [];
    return names.map((name) => {
      const col = info?.columns.find((c) => c.name === name);
      const fk = info?.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === name);
      return {
        name,
        typeName: col?.typeName ?? "",
        numeric: col ? col.category === "N" || isNumericType(col.typeName) : false,
        key: info?.keyColumns.includes(name) ?? false,
        ...(fk ? { foreignKey: fk.targetTable } : {}),
      };
    });
  }, [data?.columns, info]);

  const copyTable = useMemo(
    () =>
      info && {
        schema: info.schema,
        name: info.name,
        keyColumns: info.keyColumns.map((k) => ({
          name: k,
          typeName: info.columns.find((c) => c.name === k)?.typeName ?? "",
        })),
      },
    [info],
  );

  const onActiveRowChange = useCallback((row: number | null, sel: Selection | null) => {
    setActiveRowIndex(row);
    setSelection(sel);
  }, []);

  // ---------------------------------------------------------------------------
  // Editing (spec 3.5)
  // ---------------------------------------------------------------------------

  const loaded = useMemo(() => data?.rows ?? [], [data?.rows]);
  const names = useMemo(() => data?.columns ?? [], [data?.columns]);
  const keyIndexes = useMemo(
    () => (info?.keyColumns ?? []).map((k) => names.indexOf(k)),
    [info, names],
  );
  const notEditable: string | null = !info
    ? "読み込み中"
    : readOnly
      ? "読み取り専用の接続です"
      : info.kind !== "table" && info.kind !== "partitionedTable"
        ? "ビューは編集できません"
        : info.keyColumns.length === 0
          ? "主キーも一意キーもないため、行を特定できません"
          : keyIndexes.some((i) => i < 0)
            ? "主キー列が読み込まれていません"
            : null;
  const editable = notEditable === null && data !== null;

  const meta = useMemo(
    () => names.map((n) => info?.columns.find((c) => c.name === n)),
    [names, info],
  );
  const pasteColumns: PasteColumn[] = useMemo(
    () =>
      names.map((name, i) => {
        const c = meta[i];
        return {
          name,
          category: c?.category ?? "S",
          writable: c ? !c.generated : false,
          autoKey: Boolean(c && (c.identity || c.default?.startsWith("nextval("))),
        };
      }),
    [names, meta],
  );

  const refs: RowRef[] = useMemo(
    () => displayRows(loaded, keyIndexes, edits.state),
    [loaded, keyIndexes, edits.state],
  );
  const shown: GridRow[] = useMemo(
    () => refs.map((r) => displayValues(r, loaded, names, edits.state)),
    [refs, loaded, names, edits.state],
  );
  const dirty = changeCount(edits.state);

  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  /** Invalid values among the changed cells, by "row:col". */
  const invalid = useMemo(() => {
    const out = new Map<string, string>();
    refs.forEach((ref, r) => {
      if (rowStatus(ref, edits.state) === "deleted") {
        return;
      }
      names.forEach((name, c) => {
        const status = cellStatus(ref, name, edits.state);
        const v = shown[r]?.[c];
        const changed = ref.kind === "insert" || status === "edited";
        if (!changed || status === "default" || v === null || v === undefined) {
          return;
        }
        const col = meta[c];
        const reason = col && invalidReason(v, col.typeName, col.enumValues);
        if (reason) {
          out.set(`${r}:${c}`, reason);
        }
      });
    });
    return out;
  }, [refs, names, shown, meta, edits.state]);

  useEffect(() => {
    const target = selectAfterRender.current;
    if (!target) {
      return;
    }
    const index = refs.findIndex((r) => r.kind === "insert" && r.id === target.id);
    if (index >= 0) {
      selectAfterRender.current = null;
      grid.current?.select(cellSelection(index, target.col));
      grid.current?.focus();
    }
  }, [refs]);

  const original = useCallback(
    (ref: RowRef | undefined, col: number): string | null =>
      ref?.kind === "loaded" ? (loaded[ref.index]?.[col] ?? null) : null,
    [loaded],
  );

  const canEditCell = useCallback(
    (row: number, col: number) => {
      const ref = refs[row];
      return (
        editable &&
        ref !== undefined &&
        rowStatus(ref, edits.state) !== "deleted" &&
        pasteColumns[col]?.writable === true
      );
    },
    [editable, refs, edits.state, pasteColumns],
  );

  /** Applies writes to display cells as one undo step. */
  const write = useCallback(
    (cells: { row: number; col: number; value: CellValue }[]) => {
      const writes: CellWrite[] = [];
      for (const { row, col, value } of cells) {
        const ref = refs[row];
        const column = names[col];
        if (ref && column !== undefined && canEditCell(row, col)) {
          writes.push({ ref, column, value, original: original(ref, col) });
        }
      }
      if (writes.length > 0) {
        setSaveError(null);
        edits.apply((s) => setCells(s, writes));
      }
      return writes.length;
    },
    [refs, names, canEditCell, original, edits],
  );

  const gridEditing: GridEditing | null = useMemo(
    () =>
      editable
        ? {
            canEdit: canEditCell,
            suggestions: (col) => {
              const c = meta[col];
              if (!c) {
                return [];
              }
              return c.typeName === "boolean" ? ["true", "false"] : c.enumValues;
            },
            commit: (row, col, text) => {
              // An emptied cell of a non-text column means NULL.
              const value: CellValue =
                text === "" && pasteColumns[col]?.category !== "S"
                  ? { kind: "null" }
                  : { kind: "value", text };
              write([{ row, col, value }]);
            },
          }
        : null,
    [editable, canEditCell, meta, pasteColumns, write],
  );

  /** Where rows added after display row `index` go. */
  const anchorAfter = useCallback(
    (index: number | null): { after: string | null; afterInsert?: string } => {
      const ref = index === null ? undefined : refs[index];
      if (!ref) {
        return { after: null };
      }
      if (ref.kind === "loaded") {
        return { after: ref.key };
      }
      const ins = edits.current().inserts.find((i) => i.id === ref.id);
      return { after: ins?.after ?? null, afterInsert: ref.id };
    },
    [refs, edits],
  );

  const selectedRows = useCallback((): number[] => {
    if (!selection) {
      return [];
    }
    return selectionBounds(selection, names.length).rows.filter((r) => r < refs.length);
  }, [selection, names.length, refs.length]);

  const requireEditable = useCallback(() => {
    if (!editable) {
      toast(`このテーブルは編集できません: ${notEditable ?? ""}`, { error: true });
      return false;
    }
    return true;
  }, [editable, notEditable, toast]);

  function addRows(index: number | null, rows: Record<string, CellValue>[], upsert = false) {
    const { after, afterInsert } = anchorAfter(index);
    let ids: string[] = [];
    edits.apply((s) => {
      const r = insertRows(s, after, rows, upsert, afterInsert);
      ids = r.ids;
      return r.state;
    });
    return ids;
  }

  function insertRow() {
    if (!requireEditable()) {
      return;
    }
    const rowsSel = selectedRows();
    const ids = addRows(rowsSel.length ? Math.max(...rowsSel) : null, [{}]);
    const first = pasteColumns.findIndex((c) => c.writable && !c.autoKey);
    if (ids[0]) {
      selectAfterRender.current = { id: ids[0], col: Math.max(0, first) };
    }
  }

  function duplicateRows() {
    if (!requireEditable()) {
      return;
    }
    const rowsSel = selectedRows();
    if (rowsSel.length === 0) {
      toast("複製する行を選んでください");
      return;
    }
    const copies = rowsSel.map((r) => {
      const values: Record<string, CellValue> = {};
      pasteColumns.forEach((c, i) => {
        if (!c.writable) {
          return;
        }
        const v = shown[r]?.[i] ?? null;
        values[c.name] = c.autoKey
          ? { kind: "default" }
          : v === null
            ? { kind: "null" }
            : { kind: "value", text: v };
      });
      return values;
    });
    const ids = addRows(Math.max(...rowsSel), copies);
    if (ids[0]) {
      selectAfterRender.current = { id: ids[0], col: 0 };
    }
  }

  function removeRows() {
    if (!requireEditable()) {
      return;
    }
    const targets = selectedRows()
      .map((r) => refs[r])
      .filter((r): r is RowRef => r !== undefined);
    if (targets.length === 0) {
      toast("削除する行を選んでください");
      return;
    }
    setSaveError(null);
    edits.apply((s) => deleteRows(s, targets));
  }

  function fillSelection(value: CellValue) {
    if (!requireEditable() || !selection) {
      return;
    }
    const b = selectionBounds(selection, names.length);
    const n = write(b.rows.flatMap((row) => b.cols.map((col) => ({ row, col, value }))));
    if (n === 0) {
      toast("変更できるセルがありません");
    }
  }

  function applyPlan(plan: PastePlan, upsert: boolean, index: number | null) {
    const writes: CellWrite[] = [];
    for (const w of plan.writes) {
      const ref = refs[w.row];
      const col = names.indexOf(w.column);
      if (ref && canEditCell(w.row, col)) {
        writes.push({ ref, column: w.column, value: w.value, original: original(ref, col) });
      }
    }
    const { after, afterInsert } = anchorAfter(index);
    setSaveError(null);
    edits.apply((s) => {
      let next = setCells(s, writes);
      if (plan.newRows.length > 0) {
        next = insertRows(next, after, plan.newRows, upsert, afterInsert).state;
      }
      return next;
    });
    const parts = [
      writes.length ? `${writes.length}セルを変更` : "",
      plan.newRows.length ? `${plan.newRows.length}行を追加` : "",
    ].filter(Boolean);
    const notes = [
      plan.header ? "1行目は列名として対応付けました" : "",
      plan.ignored ? `${plan.ignored}列は対応する列がないため無視しました` : "",
    ].filter(Boolean);
    toast(
      parts.length
        ? `ペースト: ${parts.join("、")}(未保存)${notes.length ? `。${notes.join("。")}` : ""}`
        : "ペーストできる値がありませんでした",
    );
  }

  async function paste(byKey: boolean) {
    if (!requireEditable()) {
      return;
    }
    if (!selection && !byKey) {
      toast("ペースト先のセルか行を選んでください");
      return;
    }
    let cells: Cells;
    try {
      const clip = await call(commands.readClipboard());
      cells = clip.cells ?? (await call(commands.parseTsv(clip.text)));
    } catch (e) {
      toast(`クリップボードを読めませんでした: ${errorMessage(e)}`, { error: true });
      return;
    }
    if (
      cells.length === 0 ||
      (cells.length === 1 && cells[0]?.length === 1 && cells[0][0] === "")
    ) {
      toast("クリップボードが空です");
      return;
    }
    const go = () => {
      if (byKey) {
        const positions = new Map(refs.map((r, i) => [r.kind === "loaded" ? r.key : "", i]));
        const plan = planKeyPaste(
          cells,
          pasteColumns,
          info?.keyColumns ?? [],
          (key) => positions.get(JSON.stringify(key)) ?? null,
        );
        if (typeof plan === "string") {
          toast(plan, { error: true });
          return;
        }
        applyPlan(plan, true, null);
        return;
      }
      if (selection?.mode === "rows") {
        const rowsSel = selectedRows();
        applyPlan(planRowPaste(cells, pasteColumns), false, Math.max(...rowsSel));
        return;
      }
      const b = selection ? selectionBounds(selection, names.length) : { rows: [0], cols: [0] };
      const plan = planCellPaste(cells, pasteColumns, b.rows, b.cols, refs.length);
      if (plan.newRows.length > 0) {
        setQuestion({
          title: "行を追加してペースト",
          message: `貼り付ける行が表示中の行より${plan.newRows.length}行多くあります。足りない分を新しい行として追加して貼り付けますか。`,
          confirmLabel: "追加して貼り付け",
          onConfirm: () => applyPlan(plan, false, refs.length - 1),
        });
        return;
      }
      applyPlan(plan, false, null);
    };
    if (cells.length > LARGE_PASTE_ROWS) {
      setQuestion({
        title: "大量のペースト",
        message: `${cells.length.toLocaleString("ja-JP")}行を未保存の変更として貼り付けます。CSVインポート(v1.0で対応予定)の方が速く確実です。続けますか。`,
        confirmLabel: "貼り付ける",
        onConfirm: go,
      });
      return;
    }
    go();
  }

  const finishSave = useCallback(
    async (pending: Omit<PendingSave, "sql">, allowWrites: boolean) => {
      setSaving(true);
      setSaveError(null);
      try {
        const outcome = await call(commands.saveChanges(pending.set, allowWrites));
        if (outcome.kind === "failed") {
          const source = outcome.index === null ? undefined : pending.sources[outcome.index];
          const message = [outcome.error.message, outcome.error.detail, outcome.error.hint]
            .filter(Boolean)
            .join("\n");
          if (source) {
            setSaveError({ source, message });
          }
          toast(`保存できませんでした(すべての変更を取り消しました): ${message}`, { error: true });
          return;
        }
        setData(
          (prev) =>
            prev && {
              ...prev,
              rows: rowsAfterSave(
                prev.rows,
                prev.columns,
                keyIndexes,
                pending.state,
                pending.sources,
                outcome,
              ),
            },
        );
        // Edits made while saving stay (they are rare; the save used a snapshot).
        edits.reset(edits.current() === pending.state ? NO_EDITS : edits.current());
        toast(`${pending.set.changes.length}件の変更を保存しました(${outcome.elapsedMs} ms)`);
      } catch (e) {
        if (e instanceof ApiError && e.info.kind === "confirmationRequired") {
          const sql = await call(commands.previewChanges(pending.set)).catch(() => []);
          setPendingSave({ ...pending, sql });
        } else {
          toast(errorMessage(e), { error: true });
        }
      } finally {
        setSaving(false);
      }
    },
    [keyIndexes, edits, toast],
  );

  async function save(preview: boolean) {
    if (saving) {
      return;
    }
    const state = edits.current();
    if (changeCount(state) === 0) {
      toast("保存する変更はありません");
      return;
    }
    if (!info || !requireEditable()) {
      return;
    }
    if (invalid.size > 0) {
      const [first, reason] = [...invalid.entries()][0] ?? [];
      const [r, c] = (first ?? "0:0").split(":").map(Number);
      grid.current?.select(cellSelection(r ?? 0, c ?? 0));
      toast(`型に合わない値が${invalid.size}セルあります: ${reason ?? ""}`, { error: true });
      return;
    }
    const pending = {
      ...toChangeSet(state, { schema: info.schema, table: info.name, keyColumns: info.keyColumns }),
      state,
    };
    if (preview || production) {
      try {
        const sql = await call(commands.previewChanges(pending.set));
        setPendingSave({ ...pending, sql });
      } catch (e) {
        toast(errorMessage(e), { error: true });
      }
      return;
    }
    await finishSave(pending, false);
  }

  function discard() {
    if (changeCount(edits.current()) === 0) {
      toast("破棄する変更はありません");
      return;
    }
    setSaveError(null);
    edits.apply(() => NO_EDITS);
    toast(`未保存の変更を破棄しました(${keyLabel("app.undo")} で戻せます)`);
  }

  const contentShown = active && tab.view === "content" && data !== null;
  useCommands(
    {
      "table.insertRow": insertRow,
      "table.duplicateRow": duplicateRows,
      "table.deleteRows": removeRows,
      "table.setNull": () => fillSelection({ kind: "null" }),
      "table.setDefault": () => fillSelection({ kind: "default" }),
      "table.save": () => void save(false),
      "table.previewSave": () => void save(true),
      "table.discard": discard,
      "table.paste": () => void paste(false),
      "table.pasteByKey": () => void paste(true),
      "app.undo": () => {
        if (!edits.undo()) {
          toast("元に戻す操作はありません");
        }
      },
      "app.redo": () => {
        if (!edits.redo()) {
          toast("やり直す操作はありません");
        }
      },
    },
    contentShown,
  );

  const editMenu: MenuItem[] = editable
    ? [
        { label: "ペースト", keyText: keyLabel("table.paste"), onSelect: () => void paste(false) },
        {
          label: "主キーで照合してペースト",
          keyText: keyLabel("table.pasteByKey"),
          onSelect: () => void paste(true),
        },
        {
          label: "NULLを設定",
          keyText: keyLabel("table.setNull"),
          onSelect: () => fillSelection({ kind: "null" }),
        },
        {
          label: "DEFAULTに戻す",
          keyText: keyLabel("table.setDefault"),
          onSelect: () => fillSelection({ kind: "default" }),
        },
        { kind: "separator" },
        { label: "行を追加", keyText: keyLabel("table.insertRow"), onSelect: insertRow },
        { label: "行を複製", keyText: keyLabel("table.duplicateRow"), onSelect: duplicateRows },
        { label: "行を削除", keyText: keyLabel("table.deleteRows"), onSelect: removeRows },
      ]
    : [];

  const errorRow =
    saveError &&
    refs.findIndex((r) =>
      saveError.source.kind === "loaded"
        ? r.kind === "loaded" && r.key === saveError.source.key
        : r.kind === "insert" && r.id === saveError.source.id,
    );

  const rowClass = useCallback(
    (row: number) => {
      const ref = refs[row];
      const status = ref ? rowStatus(ref, edits.state) : null;
      const cls = [
        status === "inserted" ? "ins" : status === "deleted" ? "del" : "",
        row === errorRow ? "err" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return cls || undefined;
    },
    [refs, edits.state, errorRow],
  );

  const cellClass = useCallback(
    (row: number, col: number) => {
      const ref = refs[row];
      const name = names[col];
      if (!ref || name === undefined) {
        return undefined;
      }
      const status = cellStatus(ref, name, edits.state);
      const cls = [
        status === "edited" ? "ed" : "",
        status === "default" ? "dflt" : "",
        invalid.has(`${row}:${col}`) ? "bad" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return cls || undefined;
    },
    [refs, names, edits.state, invalid],
  );

  const cellTitle = useCallback(
    (row: number, col: number) =>
      invalid.get(`${row}:${col}`) ?? (row === errorRow ? saveError?.message : undefined),
    [invalid, errorRow, saveError],
  );

  const openForeignKey = useCallback(
    (fk: ForeignKey, row: GridRow) => {
      const cols = data?.columns ?? [];
      const values = fk.columns.map((c) => row[cols.indexOf(c)] ?? null);
      onOpenTable(fk.targetSchema, fk.targetTable, equalsFilter(fk.targetColumns, values));
    },
    [data?.columns, onOpenTable],
  );

  const openReference = useCallback(
    (ref: Reference, row: GridRow) => {
      const cols = data?.columns ?? [];
      const values = ref.columns.map((c) => row[cols.indexOf(c)] ?? null);
      onOpenTable(ref.sourceSchema, ref.sourceTable, equalsFilter(ref.sourceColumns, values));
    },
    [data?.columns, onOpenTable],
  );

  const onGridForeignKey = useCallback(
    (row: GridRow, col: number) => {
      const name = columns[col]?.name;
      const fk = info?.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === name);
      if (fk) {
        openForeignKey(fk, row);
      }
    },
    [columns, info, openForeignKey],
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    if (tab.view === "structure" || !data) {
      onStatus(info ? `${info.schema}.${info.name}` : "");
      return;
    }
    const total = info?.estimatedRows;
    let text = `${formatCount(data.rows.length)}行を表示`;
    if (total !== null && total !== undefined && !tab.filter) {
      text += ` / 約${formatCount(Math.max(total, data.rows.length))}行`;
    }
    if (tab.filter) {
      text += "(フィルタ適用中)";
    }
    text += ` · ${data.elapsedMs} ms`;
    if (dirty > 0) {
      text += ` · 未保存 ${dirty}行`;
    }
    if (selection) {
      const b = selectionBounds(selection, columns.length);
      text +=
        selection.mode === "rows"
          ? ` · ${b.rows.length}行を選択`
          : ` · 選択 ${b.rows.length}行×${b.cols.length}列`;
    }
    onStatus(text);
  }, [active, data, info, tab.filter, tab.view, selection, columns.length, dirty, onStatus]);

  const toolbar = (
    <div className="toolbar">
      <span className="crumb">
        {tab.schema} › <b>{tab.table}</b>
        {info && info.keyColumns.length === 0 && info.kind === "table" && (
          <span className="kbd"> (主キーなし)</span>
        )}
      </span>
      {tab.view === "content" && info && notEditable && !readOnly && (
        <span className="pill ro" title={notEditable}>
          閲覧のみ
        </span>
      )}
      <div className="seg" style={{ marginLeft: 10 }}>
        <button
          type="button"
          aria-pressed={tab.view === "content"}
          onClick={() => onChange({ view: "content" })}
          title={`コンテンツ / 構造の切替 ${keyLabel("table.toggleView")}`}
        >
          コンテンツ
        </button>
        <button
          type="button"
          aria-pressed={tab.view === "structure"}
          onClick={() => onChange({ view: "structure" })}
        >
          構造(閲覧のみ)
        </button>
      </div>
      <span className="sp" />
      {tab.view === "content" && editable && (
        <>
          <button
            type="button"
            className="ibtn"
            onClick={insertRow}
            title={`行を追加 ${keyLabel("table.insertRow")}`}
          >
            行を追加
          </button>
          {dirty > 0 && (
            <>
              <output className="dirty">未保存 {dirty}行</output>
              <button
                type="button"
                className="ibtn"
                onClick={discard}
                title={`変更を破棄 ${keyLabel("table.discard")}`}
              >
                破棄
              </button>
              <button
                type="button"
                className="ibtn"
                onClick={() => void save(true)}
                title={`SQLをプレビューして保存 ${keyLabel("table.previewSave")}`}
              >
                SQLを確認
              </button>
              <button
                type="button"
                className="pbtn small"
                disabled={saving}
                onClick={() => void save(false)}
              >
                {saving ? "保存中…" : "保存"}{" "}
                <span className="kbd" style={{ color: "inherit", opacity: 0.8 }}>
                  {keyLabel("table.save")}
                </span>
              </button>
            </>
          )}
        </>
      )}
      {tab.view === "content" && (
        <button
          type="button"
          className="ibtn"
          aria-pressed={tab.filterOpen}
          onClick={() => onChange({ filterOpen: !tab.filterOpen })}
        >
          フィルタ <span className="kbd">{keyLabel("table.toggleFilter")}</span>
        </button>
      )}
      <button type="button" className="ibtn" onClick={() => onChange({ reload: tab.reload + 1 })}>
        再読み込み <span className="kbd">{keyLabel("app.reload")}</span>
      </button>
    </div>
  );

  if (infoError) {
    return (
      <>
        {toolbar}
        <div className="gerr" role="alert">
          {infoError}
        </div>
      </>
    );
  }
  if (!info) {
    return (
      <>
        {toolbar}
        <div className="empty">読み込み中…</div>
      </>
    );
  }
  if (tab.view === "structure") {
    return (
      <>
        {toolbar}
        <StructureView info={info} />
      </>
    );
  }

  const activeRow = activeRowIndex !== null ? (shown[activeRowIndex] ?? null) : null;
  const activeRef = activeRowIndex !== null ? refs[activeRowIndex] : undefined;

  return (
    <>
      {toolbar}
      {tab.filterOpen && (
        <FilterBar
          key={JSON.stringify(tab.filter)}
          columns={info.columns.map((c) => c.name)}
          applied={tab.filter}
          onApply={(filter) => onChange({ filter })}
        />
      )}
      <div className="body">
        <div className="main">
          {error ? (
            <div className="gerr" role="alert">
              {error}
            </div>
          ) : (
            <DataGrid
              ref={grid}
              label={`${tab.schema}.${tab.table}`}
              active={contentShown}
              columns={columns}
              rows={shown}
              editing={gridEditing}
              rowClass={rowClass}
              cellClass={cellClass}
              cellTitle={cellTitle}
              editMenu={editMenu}
              hasMore={Boolean(data?.next)}
              loading={loading}
              onLoadMore={() => {
                if (data?.next && !loadingMore.current) {
                  loadingMore.current = true;
                  void load(data.next, true).finally(() => {
                    loadingMore.current = false;
                  });
                }
              }}
              sort={tab.sort}
              onSort={(sort) => onChange({ sort })}
              copyTable={copyTable}
              onForeignKey={onGridForeignKey}
              onActiveRowChange={onActiveRowChange}
              resetKey={`${JSON.stringify(tab.filter)}|${JSON.stringify(tab.sort)}|${tab.reload}`}
              emptyText={tab.filter ? "条件に一致する行はありません" : "行はありません"}
            />
          )}
        </div>
        {rightOpen && (
          <RowDetail
            info={info}
            columns={names}
            row={activeRow}
            isNew={activeRef?.kind === "insert"}
            edit={
              editable && activeRowIndex !== null && activeRef
                ? {
                    canEdit: (column) => canEditCell(activeRowIndex, names.indexOf(column)),
                    status: (column) => cellStatus(activeRef, column, edits.state),
                    commit: (column, value) =>
                      write([{ row: activeRowIndex, col: names.indexOf(column), value }]),
                  }
                : null
            }
            onOpenForeignKey={openForeignKey}
            onOpenReference={openReference}
          />
        )}
      </div>
      {pendingSave && (
        <Modal
          title={production ? "本番データベースに保存" : "保存するSQL"}
          onClose={() => setPendingSave(null)}
          wide
          footer={
            <>
              <span className="res tip">
                {pendingSave.set.changes.length}
                文を1トランザクションで実行します。失敗したらすべて取り消します。
              </span>
              <button type="button" className="sbtn" onClick={() => setPendingSave(null)}>
                キャンセル
              </button>
              <button
                type="button"
                className={production ? "pbtn danger" : "pbtn"}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the main action of the dialog.
                autoFocus
                onClick={() => {
                  const p = pendingSave;
                  setPendingSave(null);
                  void finishSave(p, true);
                }}
              >
                保存
              </button>
            </>
          }
        >
          <div className="mblock">
            {production && (
              <p className="warn">本番の接続です。内容を確認してから保存してください。</p>
            )}
            <pre className="sqlprev">{pendingSave.sql.join(";\n")};</pre>
          </div>
        </Modal>
      )}
      {question && (
        <Confirm
          title={question.title}
          message={question.message}
          confirmLabel={question.confirmLabel}
          onCancel={() => setQuestion(null)}
          onConfirm={() => {
            const q = question;
            setQuestion(null);
            q.onConfirm();
          }}
        />
      )}
    </>
  );
}
