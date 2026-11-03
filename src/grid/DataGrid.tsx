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
import { useCommands, useKeyLabel } from "../commands/CommandProvider";
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
  /** Replaces the selection and scrolls to it. */
  select: (selection: Selection | null) => void;
}

/** Cell editing, when the grid shows an editable table (spec 3.5). */
export interface GridEditing {
  canEdit: (row: number, col: number) => boolean;
  /** Values offered while typing (enum labels, true / false). */
  suggestions: (col: number) => readonly string[];
  /** Stores a typed value. */
  commit: (row: number, col: number, text: string) => void;
}

interface CellEditor {
  row: number;
  col: number;
  text: string;
  /** The user changed the text (committing an untouched NULL keeps it NULL). */
  dirty: boolean;
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
  /** The grid's tab is shown: it handles grid commands (copy, select all, ...). */
  active?: boolean;
  editing?: GridEditing | null;
  /** Extra class of a row: `ins` (added) or `del` (to be deleted). */
  rowClass?: (row: number) => string | undefined;
  /** Extra class of a cell: `ed` (edited), `dflt` (DEFAULT), `bad` (invalid). */
  cellClass?: (row: number, col: number) => string | undefined;
  /** Tooltip of a cell, for example why its value is invalid. */
  cellTitle?: (row: number, col: number) => string | undefined;
  /** Menu items for editing, added to the context menu. */
  editMenu?: MenuItem[];
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
    active = true,
    editing,
    rowClass,
    cellClass,
    cellTitle,
    editMenu,
  },
  ref,
) {
  const toast = useToast();
  const keyLabel = useKeyLabel();
  const [editor, setEditorState] = useState<CellEditor | null>(null);
  // Mirrors `editor` synchronously: moving the focus after Enter blurs the field,
  // and that blur must not commit the same edit a second time.
  const editorRef = useRef<CellEditor | null>(null);
  const setEditor = useCallback((next: CellEditor | null) => {
    editorRef.current = next;
    setEditorState(next);
  }, []);
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
    setEditor(null);
  }, [resetKey, setEditor]);

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

  useImperativeHandle(
    ref,
    () => ({
      focus: () => wrap.current?.focus(),
      followForeignKey,
      select: (sel) => {
        setSelection(sel);
        if (sel) {
          scrollToRow(sel.mode === "cells" ? sel.focus.row : sel.anchor);
        }
      },
    }),
    [followForeignKey, scrollToRow],
  );

  function startEdit(row: number, col: number, typed?: string) {
    if (!editing?.canEdit(row, col)) {
      return false;
    }
    setSelection(cellSelection(row, col));
    setEditor({
      row,
      col,
      text: typed ?? rows[row]?.[col] ?? "",
      dirty: typed !== undefined,
    });
    return true;
  }

  /** Stores the editor's text (if changed) and closes it. */
  function commitEdit() {
    const ed = editorRef.current;
    if (!ed) {
      return;
    }
    setEditor(null);
    if (ed.dirty && ed.text !== (rows[ed.row]?.[ed.col] ?? null)) {
      editing?.commit(ed.row, ed.col, ed.text);
    }
  }

  function moveAfterEdit(dRow: number, dCol: number) {
    const next = moveSelection(selection, dRow, dCol, false, rows.length, columns.length);
    setSelection(next);
    if (next?.mode === "cells") {
      scrollToRow(next.focus.row);
    }
    wrap.current?.focus();
  }

  function onEditorKeyDown(e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    // Arrow keys and typing belong to the text field, not the grid.
    e.stopPropagation();
    if (e.nativeEvent.isComposing) {
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setEditor(null);
      wrap.current?.focus();
    } else if (e.key === "Enter" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
      moveAfterEdit(1, 0);
    } else if (e.key === "Tab") {
      e.preventDefault();
      commitEdit();
      moveAfterEdit(0, e.shiftKey ? -1 : 1);
    }
  }

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
    if (e.key === "Escape" && selection) {
      setSelection(null);
      return;
    }
    const cell = selection?.mode === "cells" ? selection.focus : null;
    if (!cell || mod || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) {
      return;
    }
    // Return or F2 edits the cell; typing replaces it (spec 3.5).
    if (e.key === "Enter" || e.key === "F2") {
      if (startEdit(cell.row, cell.col)) {
        e.preventDefault();
      }
    } else if (e.key === "Backspace" || e.key === "Delete") {
      if (!e.altKey && startEdit(cell.row, cell.col, "")) {
        e.preventDefault();
      }
    } else if (e.key.length === 1 && !e.altKey) {
      if (startEdit(cell.row, cell.col, e.key)) {
        e.preventDefault();
      }
    }
  }

  function selectAll() {
    if (rows.length) {
      setSelection({ mode: "rows", rows: rows.map((_, i) => i), anchor: 0 });
    }
  }

  function openFormatMenu() {
    const rect = wrap.current?.getBoundingClientRect();
    setMenu({ x: (rect?.left ?? 0) + 80, y: (rect?.top ?? 0) + 60, formatsOnly: true });
  }

  useCommands(
    {
      "grid.copy": () => void copy("tsv"),
      "grid.copyWithHeader": () => void copy("tsvWithHeader"),
      "grid.copyAs": openFormatMenu,
      "grid.selectAll": selectAll,
      "grid.followForeignKey": fkCell() && onForeignKey ? followForeignKey : null,
    },
    active,
  );

  function onCellMouseDown(e: MouseEvent, row: number, col: number) {
    if (e.button !== 0 || (editor?.row === row && editor.col === col)) {
      return;
    }
    // Grid keys need the focus on the grid; not every engine moves it there when a
    // cell of a focusable container is clicked.
    wrap.current?.focus({ preventScroll: true });
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
        { label: "コピー", keyText: keyLabel("grid.copy"), onSelect: () => void copy("tsv") },
        {
          label: "ヘッダ付きでコピー",
          keyText: keyLabel("grid.copyWithHeader"),
          onSelect: () => void copy("tsvWithHeader"),
        },
        { kind: "separator" },
        { kind: "heading", label: `形式を指定してコピー ${keyLabel("grid.copyAs")}`.trim() },
        ...formatItems,
        ...(fkCell() && onForeignKey
          ? ([
              { kind: "separator" },
              {
                label: "外部キーの参照先へ",
                keyText: keyLabel("grid.followForeignKey"),
                onSelect: followForeignKey,
              },
            ] satisfies MenuItem[])
          : []),
        ...(editMenu && editMenu.length > 0
          ? ([{ kind: "separator" }, ...editMenu] satisfies MenuItem[])
          : []),
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
            const rowCls = [rowSelected ? "rsel" : "", rowClass?.(r) ?? ""]
              .filter(Boolean)
              .join(" ");
            return (
              <tr key={r} className={rowCls || undefined} aria-rowindex={r + 1}>
                <td
                  className="rn"
                  onMouseDown={(e) => {
                    if (e.button === 0) {
                      wrap.current?.focus({ preventScroll: true });
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
                  const extra = cellClass?.(r, ci);
                  const isEditing = editor?.row === r && editor.col === ci;
                  const cls = [
                    c.numeric ? "num" : "",
                    selected ? "sel" : "",
                    anchor ? "anchor" : "",
                    extra ?? "",
                    isEditing ? "editing" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  if (isEditing) {
                    const suggestions = editing?.suggestions(ci) ?? [];
                    const listId = `sugg-${ci}`;
                    const common = {
                      "data-cell-editor": true,
                      className: "celled",
                      "aria-label": `${c.name} を編集`,
                      value: editor.text,
                      onKeyDown: onEditorKeyDown,
                      onBlur: () => commitEdit(),
                      onFocus: (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
                        const el = e.currentTarget;
                        el.setSelectionRange(el.value.length, el.value.length);
                      },
                      onChange: (e: { currentTarget: { value: string } }) => {
                        const text = e.currentTarget.value;
                        const ed = editorRef.current;
                        if (ed) {
                          setEditor({ ...ed, text, dirty: true });
                        }
                      },
                    };
                    return (
                      // oxlint-disable-next-line react/no-array-index-key -- see the colgroup above.
                      <td key={ci} className={cls}>
                        {suggestions.length > 0 ? (
                          <>
                            <input
                              type="text"
                              list={listId}
                              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the editor opens on purpose.
                              autoFocus
                              {...common}
                              aria-label={`${c.name} を編集`}
                            />
                            <datalist id={listId}>
                              {suggestions.map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </datalist>
                          </>
                        ) : (
                          <textarea
                            rows={1}
                            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the editor opens on purpose.
                            autoFocus
                            {...common}
                            aria-label={`${c.name} を編集`}
                          />
                        )}
                      </td>
                    );
                  }
                  return (
                    <td
                      // oxlint-disable-next-line react/no-array-index-key -- see the colgroup above.
                      key={ci}
                      className={cls || undefined}
                      onMouseDown={(e) => onCellMouseDown(e, r, ci)}
                      onMouseEnter={(e) => onCellMouseEnter(e, r, ci)}
                      onContextMenu={(e) => onContextMenu(e, r, ci)}
                      onDoubleClick={() => startEdit(r, ci)}
                      title={
                        cellTitle?.(r, ci) ??
                        (v !== null && v.length > 40 ? v.slice(0, 500) : undefined)
                      }
                    >
                      {v === null ? (
                        <span className="nul">{extra?.includes("dflt") ? "DEFAULT" : "NULL"}</span>
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
