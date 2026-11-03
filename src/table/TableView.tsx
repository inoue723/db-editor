import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commands,
  type Filter,
  type ForeignKey,
  type PageCursor,
  type Reference,
  type SortKey,
  type TableInfo_Serialize,
} from "../bindings";
import { DataGrid } from "../grid/DataGrid";
import { type Selection, selectionBounds } from "../grid/selection";
import { type GridColumn, type GridRow, isNumericType } from "../grid/types";
import { call, errorMessage } from "../lib/api";
import { keyLabel } from "../lib/keys";
import { FilterBar } from "./FilterBar";
import { RowDetail } from "./RowDetail";
import { StructureView } from "./StructureView";

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
export function TableView({
  tab,
  active,
  rightOpen,
  onChange,
  onOpenTable,
  onStatus,
  onInfo,
}: Props) {
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

  const openForeignKey = useCallback(
    (fk: ForeignKey, row: GridRow) => {
      const names = data?.columns ?? [];
      const values = fk.columns.map((c) => row[names.indexOf(c)] ?? null);
      onOpenTable(fk.targetSchema, fk.targetTable, equalsFilter(fk.targetColumns, values));
    },
    [data?.columns, onOpenTable],
  );

  const openReference = useCallback(
    (ref: Reference, row: GridRow) => {
      const names = data?.columns ?? [];
      const values = ref.columns.map((c) => row[names.indexOf(c)] ?? null);
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
    if (selection) {
      const b = selectionBounds(selection, columns.length);
      text +=
        selection.mode === "rows"
          ? ` · ${b.rows.length}行を選択`
          : ` · 選択 ${b.rows.length}行×${b.cols.length}列`;
    }
    onStatus(text);
  }, [active, data, info, tab.filter, tab.view, selection, columns.length, onStatus]);

  const toolbar = (
    <div className="toolbar">
      <span className="crumb">
        {tab.schema} › <b>{tab.table}</b>
        {info && info.keyColumns.length === 0 && info.kind === "table" && (
          <span className="kbd"> (主キーなし)</span>
        )}
      </span>
      <div className="seg" style={{ marginLeft: 10 }}>
        <button
          type="button"
          aria-pressed={tab.view === "content"}
          onClick={() => onChange({ view: "content" })}
          title={`コンテンツ / 構造の切替 ${keyLabel("⌥⌘T")}`}
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
      {tab.view === "content" && (
        <button
          type="button"
          className="ibtn"
          aria-pressed={tab.filterOpen}
          onClick={() => onChange({ filterOpen: !tab.filterOpen })}
        >
          フィルタ <span className="kbd">{keyLabel("⌥⌘F")}</span>
        </button>
      )}
      <button type="button" className="ibtn" onClick={() => onChange({ reload: tab.reload + 1 })}>
        再読み込み <span className="kbd">{keyLabel("⌘R")}</span>
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

  const activeRow = activeRowIndex !== null ? (data?.rows[activeRowIndex] ?? null) : null;

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
              label={`${tab.schema}.${tab.table}`}
              columns={columns}
              rows={data?.rows ?? []}
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
            columns={data?.columns ?? []}
            row={activeRow}
            onOpenForeignKey={openForeignKey}
            onOpenReference={openReference}
          />
        )}
      </div>
    </>
  );
}
