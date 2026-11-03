import {
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { commands, type CopyFormat, type CopyTable, type SortKey } from "../bindings";
import { call, errorMessage } from "../lib/api";
import { isMod } from "../lib/keys";
import { Menu, type MenuItem } from "../ui/Menu";
import { useToast } from "../ui/Toast";
import {
  activeRow,
  cellSelection,
  clickRow,
  isCellSelected,
  moveSelection,
  type Selection,
  selectionBounds,
} from "./selection";
import type { GridColumn, GridRow } from "./types";

const ROW_HEIGHT = 24;
const OVERSCAN = 12;
const ROW_NUMBER_WIDTH = 56;

const FORMAT_LABEL: Record<CopyFormat, string> = {
  tsv: "TSV",
  tsvWithHeader: "ヘッダ付きTSV",
  csv: "CSV",
  json: "JSON",
  markdown: "Markdown表",
  insert: "SQL INSERT",
  update: "SQL UPDATE",
  where: "WHERE句",
};

export interface GridHandle {
  focus: () => void;
  /** Jumps through the foreign key of the active cell, if any. */
  followForeignKey: () => void;
}

interface Props {
  columns: GridColumn[];
  rows: GridRow[];
  /** More rows can be loaded at the bottom. */
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
  sort?: SortKey[];
  onSort?: (sort: SortKey[]) => void;
  /** Source table, for SQL INSERT / UPDATE / WHERE copies. */
  copyTable?: CopyTable | null;
  onForeignKey?: (row: GridRow, col: number) => void;
  onActiveRowChange?: (row: number | null, selection: Selection | null) => void;
  /** Bumped by the parent to clear the selection (new data). */
  resetKey?: unknown;
  emptyText?: string;
  label: string;
}

function columnWidth(col: GridColumn, rows: GridRow[], index: number): number {
  let chars = Math.max(
    col.name.length + (col.key || col.foreignKey ? 3 : 0) + 2,
    col.typeName.length,
  );
  for (const row of rows.slice(0, 200)) {
    const v = row[index];
    chars = Math.max(chars, v == null ? 4 : Math.min(v.length, 60));
  }
  return Math.max(64, Math.min(340, Math.round(chars * 7.4 + 22)));
}

/** A virtualized, spreadsheet-like grid for table contents and query results. */
export const DataGrid = forwardRef<GridHandle, Props>(function DataGrid(
  {
    columns,
    rows,
    hasMore,
    loading,
    onLoadMore,
    sort,
    onSort,
    copyTable,
    onForeignKey,
    onActiveRowChange,
    resetKey,
    emptyText,
    label,
  },
  ref,
) {
  const toast = useToast();
  const wrap = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; formatsOnly?: boolean } | null>(null);

  // Column widths are computed once per column set, so loading more rows does not shift them.
  const widthKey = columns.map((c) => `${c.name}:${c.typeName}`).join("|");
  const widths = useMemo(
    () => columns.map((c, i) => columnWidth(c, rows, i)),
    // oxlint-disable-next-line react/exhaustive-deps -- recomputed only when the columns change.
    [widthKey, rows.length > 0],
  );

  useEffect(() => {
    setSelection(null);
  }, [resetKey]);

  useEffect(() => {
    onActiveRowChange?.(activeRow(selection), selection);
  }, [selection, onActiveRowChange]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) {
      return undefined;
    }
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  useEffect(() => {
    if (hasMore && !loading && onLoadMore && last >= rows.length - OVERSCAN) {
      onLoadMore();
    }
  }, [hasMore, loading, onLoadMore, last, rows.length]);

  const scrollToRow = useCallback((row: number) => {
    const el = wrap.current;
    if (!el) {
      return;
    }
    const header = el.querySelector("thead")?.clientHeight ?? 0;
    const top = row * ROW_HEIGHT;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight - header) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight + header;
    }
  }, []);

  const fkCell = useCallback((): { row: number; col: number } | null => {
    if (selection?.mode !== "cells") {
      return null;
    }
    const { row, col } = selection.focus;
    return columns[col]?.foreignKey && rows[row]?.[col] != null ? { row, col } : null;
  }, [selection, columns, rows]);

  const followForeignKey = useCallback(() => {
    const cell = fkCell();
    const row = cell && rows[cell.row];
    if (cell && row && onForeignKey) {
      onForeignKey(row, cell.col);
    }
  }, [fkCell, rows, onForeignKey]);

  useImperativeHandle(ref, () => ({ focus: () => wrap.current?.focus(), followForeignKey }), [
    followForeignKey,
  ]);

  const keyIndexes = useMemo(
    () => (copyTable?.keyColumns ?? []).map((k) => columns.findIndex((c) => c.name === k.name)),
    [copyTable, columns],
  );
  const canKeyCopy = Boolean(
    copyTable && copyTable.keyColumns.length > 0 && keyIndexes.every((i) => i >= 0),
  );

  async function copy(format: CopyFormat) {
    if (!selection) {
      toast("コピーするセルを選んでください");
      return;
    }
    const bounds = selectionBounds(selection, columns.length);
    const selectedRows = bounds.rows
      .map((r) => rows[r])
      .filter((r): r is GridRow => r !== undefined);
    try {
      const text = await call(
        commands.copySelection({
          format,
          columns: bounds.cols.map((c) => ({
            name: columns[c]?.name ?? "",
            typeName: columns[c]?.typeName ?? "",
          })),
          rows: selectedRows.map((r) => bounds.cols.map((c) => r[c] ?? null)),
          table: copyTable ?? null,
          keyValues: canKeyCopy ? selectedRows.map((r) => keyIndexes.map((i) => r[i] ?? null)) : [],
        }),
      );
      toast(
        `${selectedRows.length}行×${bounds.cols.length}列を${FORMAT_LABEL[format]}でコピーしました`,
        {
          preview: text,
        },
      );
    } catch (error) {
      toast(errorMessage(error), { error: true });
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const mod = isMod(e);
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (mod && e.key === "ArrowDown" && fkCell()) {
      e.preventDefault();
      followForeignKey();
      return;
    }
    const move = moves[e.key];
    if (move && !mod) {
      e.preventDefault();
      const next = moveSelection(
        selection,
        move[0],
        move[1],
        e.shiftKey,
        rows.length,
        columns.length,
      );
      setSelection(next);
      if (next?.mode === "cells") {
        scrollToRow(next.focus.row);
      }
      return;
    }
    if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      const step =
        Math.max(1, Math.floor(height / ROW_HEIGHT) - 1) * (e.key === "PageDown" ? 1 : -1);
      const next = moveSelection(selection, step, 0, e.shiftKey, rows.length, columns.length);
      setSelection(next);
      if (next?.mode === "cells") {
        scrollToRow(next.focus.row);
      }
      return;
    }
    if (mod && e.code === "KeyA") {
      e.preventDefault();
      if (rows.length) {
        setSelection({ mode: "rows", rows: rows.map((_, i) => i), anchor: 0 });
      }
      return;
    }
    if (mod && e.code === "KeyC") {
      e.preventDefault();
      if (e.altKey) {
        const rect = wrap.current?.getBoundingClientRect();
        setMenu({ x: (rect?.left ?? 0) + 80, y: (rect?.top ?? 0) + 60, formatsOnly: true });
      } else {
        void copy(e.shiftKey ? "tsvWithHeader" : "tsv");
      }
      return;
    }
    if (e.key === "Escape" && selection) {
      setSelection(null);
    }
  }

  function onCellMouseDown(e: MouseEvent, row: number, col: number) {
    if (e.button !== 0) {
      return;
    }
    if (e.shiftKey && selection?.mode === "cells") {
      setSelection({ ...selection, focus: { row, col } });
    } else {
      setSelection(cellSelection(row, col));
    }
  }

  function onCellMouseEnter(e: MouseEvent, row: number, col: number) {
    // Drag to extend the rectangle.
    if (e.buttons === 1 && selection?.mode === "cells") {
      setSelection({ ...selection, focus: { row, col } });
    }
  }

  function onContextMenu(e: MouseEvent, row: number, col: number | null) {
    e.preventDefault();
    if (!isCellSelected(selection, row, col ?? 0) || (col === null && selection?.mode !== "rows")) {
      setSelection(
        col === null ? { mode: "rows", rows: [row], anchor: row } : cellSelection(row, col),
      );
    }
    setMenu({ x: e.clientX, y: e.clientY });
  }

  function onHeaderClick(e: MouseEvent, name: string) {
    if (!onSort) {
      return;
    }
    const current = sort ?? [];
    const i = current.findIndex((s) => s.column === name);
    if (e.shiftKey) {
      if (i < 0) {
        onSort([...current, { column: name, descending: false }]);
      } else if (!current[i]?.descending) {
        onSort(current.map((s, j) => (j === i ? { ...s, descending: true } : s)));
      } else {
        onSort(current.filter((_, j) => j !== i));
      }
    } else if (i < 0 || current.length > 1) {
      onSort([{ column: name, descending: false }]);
    } else if (!current[i]?.descending) {
      onSort([{ column: name, descending: true }]);
    } else {
      onSort([]);
    }
  }

  const formatItems: MenuItem[] = (
    ["csv", "json", "markdown", "insert", "update", "where"] as const
  ).map((f) => ({
    label: FORMAT_LABEL[f],
    onSelect: () => void copy(f),
    disabled: (f === "update" || f === "where") && !canKeyCopy,
  }));

  const menuItems: MenuItem[] = menu?.formatsOnly
    ? [{ kind: "heading", label: "形式を指定してコピー" }, ...formatItems]
    : [
        { label: "コピー", shortcut: "⌘C", onSelect: () => void copy("tsv") },
        {
          label: "ヘッダ付きでコピー",
          shortcut: "⌘⇧C",
          onSelect: () => void copy("tsvWithHeader"),
        },
        { kind: "separator" },
        { kind: "heading", label: "形式を指定してコピー ⌘⌥C" },
        ...formatItems,
        ...(fkCell() && onForeignKey
          ? ([
              { kind: "separator" },
              { label: "外部キーの参照先へ", shortcut: "⌘↓", onSelect: followForeignKey },
            ] satisfies MenuItem[])
          : []),
        { kind: "separator" },
        { label: "ペースト", disabled: true, tag: "v0.2" },
        { label: "NULLを設定", disabled: true, tag: "v0.2" },
        { label: "行を削除", disabled: true, tag: "v0.2" },
      ];

  const sortMark = (name: string) => {
    const list = sort ?? [];
    const i = list.findIndex((s) => s.column === name);
    if (i < 0) {
      return null;
    }
    return (
      <span className="so">
        {list[i]?.descending ? "▼" : "▲"}
        {list.length > 1 ? i + 1 : ""}
      </span>
    );
  };

  const totalWidth = ROW_NUMBER_WIDTH + widths.reduce((a, b) => a + b, 0);
  const visibleRows = rows.slice(first, last);

  return (
    <div
      className="gridwrap"
      ref={wrap}
      tabIndex={0}
      role="grid"
      aria-label={label}
      aria-rowcount={rows.length}
      onKeyDown={onKeyDown}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <table className="g" style={{ width: totalWidth }}>
        <colgroup>
          <col style={{ width: ROW_NUMBER_WIDTH }} />
          {widths.map((w, i) => (
            // Query results can repeat a column name, so the position is the identity.
            // oxlint-disable-next-line react/no-array-index-key
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="rn" aria-label="行番号" />
            {columns.map((c) => (
              <th
                key={c.name}
                onClick={(e) => onHeaderClick(e, c.name)}
                title={onSort ? "クリックでソート、Shift+クリックで複合ソート" : undefined}
              >
                {c.key && <span className="pkfk pk">PK</span>}
                {c.foreignKey && <span className="pkfk fk">FK</span>}
                {c.name}
                {sortMark(c.name)}
                <span className="ty">
                  {c.typeName || " "}
                  {c.foreignKey ? ` → ${c.foreignKey}` : ""}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {first > 0 && (
            <tr style={{ height: first * ROW_HEIGHT }} aria-hidden="true">
              <td
                colSpan={columns.length + 1}
                style={{ padding: 0, border: 0 }}
                aria-label="スクロール領域"
              />
            </tr>
          )}
          {visibleRows.map((row, i) => {
            const r = first + i;
            const rowSelected = selection?.mode === "rows" && selection.rows.includes(r);
            return (
              <tr key={r} className={rowSelected ? "rsel" : undefined} aria-rowindex={r + 1}>
                <td
                  className="rn"
                  onMouseDown={(e) => {
                    if (e.button === 0) {
                      setSelection(clickRow(selection, r, e.shiftKey, isMod(e)));
                    }
                  }}
                  onContextMenu={(e) => onContextMenu(e, r, null)}
                >
                  {r + 1}
                </td>
                {columns.map((c, ci) => {
                  const v = row[ci] ?? null;
                  const selected = !rowSelected && isCellSelected(selection, r, ci);
                  const anchor =
                    selection?.mode === "cells" &&
                    selection.focus.row === r &&
                    selection.focus.col === ci;
                  const cls = [
                    c.numeric ? "num" : "",
                    selected ? "sel" : "",
                    anchor ? "anchor" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <td
                      // oxlint-disable-next-line react/no-array-index-key -- see the colgroup above.
                      key={ci}
                      className={cls || undefined}
                      onMouseDown={(e) => onCellMouseDown(e, r, ci)}
                      onMouseEnter={(e) => onCellMouseEnter(e, r, ci)}
                      onContextMenu={(e) => onContextMenu(e, r, ci)}
                      title={v !== null && v.length > 40 ? v.slice(0, 500) : undefined}
                    >
                      {v === null ? (
                        <span className="nul">NULL</span>
                      ) : v.length > 300 ? (
                        `${v.slice(0, 300)}…`
                      ) : (
                        v
                      )}
                      {c.foreignKey && v !== null && onForeignKey && (
                        <button
                          type="button"
                          className="fkb"
                          title="参照先へ ⌘↓"
                          aria-label={`${c.foreignKey} の参照先を開く`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={() => onForeignKey(row, ci)}
                        >
                          →
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {last < rows.length && (
            <tr style={{ height: (rows.length - last) * ROW_HEIGHT }} aria-hidden="true">
              <td
                colSpan={columns.length + 1}
                style={{ padding: 0, border: 0 }}
                aria-label="スクロール領域"
              />
            </tr>
          )}
          {(loading || hasMore) && (
            <tr className="loadmore">
              <td className="rn" aria-label="行番号" />
              <td colSpan={columns.length}>
                {loading ? "読み込み中…" : "スクロールで次の500行を読み込みます"}
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr className="loadmore">
              <td className="rn" aria-label="行番号" />
              <td colSpan={Math.max(1, columns.length)}>{emptyText ?? "行はありません"}</td>
            </tr>
          )}
        </tbody>
      </table>
      {menu && <Menu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
});
