import { useEffect, useState } from "react";
import {
  type CellValue,
  commands,
  type ForeignKey,
  type Reference,
  type TableInfo_Serialize,
} from "../bindings";
import { useKeyLabel } from "../commands/CommandProvider";
import type { GridRow } from "../grid/types";
import { call } from "../lib/api";
import type { CellStatus } from "./edits";

/** Counts above this are shown as "1000+" so a big table is never scanned in full. */
const COUNT_LIMIT = 1000;

interface Props {
  info: TableInfo_Serialize;
  /** Column names of the loaded rows, in order. */
  columns: string[];
  row: GridRow | null;
  /** The row was added and is not saved yet (it has no references). */
  isNew?: boolean;
  /** Editing of the row's values, when the table can be edited. */
  edit?: {
    canEdit: (column: string) => boolean;
    status: (column: string) => CellStatus;
    commit: (column: string, value: CellValue) => void;
  } | null;
  onOpenForeignKey: (fk: ForeignKey, row: GridRow) => void;
  onOpenReference: (ref: Reference, row: GridRow) => void;
}

function pretty(value: string, typeName: string): string {
  if (typeName === "json" || typeName === "jsonb") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return value;
}

function valuesOf(row: GridRow, columns: string[], names: string[]): (string | null)[] {
  return names.map((n) => row[columns.indexOf(n)] ?? null);
}

/** The right sidebar of a table tab: every value of the selected row and the rows that reference it. */
/** A value field that edits in place: a text area committed on blur (spec 3.5). */
function EditableValue({
  value,
  typeName,
  status,
  label,
  onCommit,
}: {
  value: string | null;
  typeName: string;
  status: CellStatus;
  label: string;
  onCommit: (value: CellValue) => void;
}) {
  const shown = value === null ? "" : pretty(value, typeName);
  const [draft, setDraft] = useState<string | null>(null);
  const cls = ["v", "edit", status === "edited" ? "ed" : "", status === "default" ? "dflt" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="vedit">
      <textarea
        className={cls}
        aria-label={label}
        value={draft ?? shown}
        placeholder={status === "default" ? "DEFAULT" : value === null ? "NULL" : ""}
        rows={Math.min(10, Math.max(1, shown.split("\n").length))}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        onBlur={() => {
          if (draft !== null && draft !== shown) {
            onCommit({ kind: "value", text: draft });
          }
          setDraft(null);
        }}
      />
      <button
        type="button"
        className="mini"
        title="NULLを設定"
        disabled={value === null && status !== "default"}
        onClick={() => onCommit({ kind: "null" })}
      >
        NULL
      </button>
    </div>
  );
}

export function RowDetail({
  info,
  columns,
  row,
  isNew,
  edit,
  onOpenForeignKey,
  onOpenReference,
}: Props) {
  const keyLabel = useKeyLabel();
  // Counts belong to the row they were fetched for, so a new row starts empty.
  const [fetched, setFetched] = useState<{
    row: GridRow | null;
    counts: Record<string, number | "error">;
  }>({
    row: null,
    counts: {},
  });
  const counts = fetched.row === row ? fetched.counts : {};

  useEffect(() => {
    if (!row || isNew || info.references.length === 0) {
      return undefined;
    }
    let cancelled = false;
    const record = (name: string, value: number | "error") => {
      if (!cancelled) {
        setFetched((f) => ({ row, counts: { ...(f.row === row ? f.counts : {}), [name]: value } }));
      }
    };
    // Wait a moment so that moving through rows with the arrow keys does not flood the server.
    const timer = setTimeout(() => {
      for (const ref of info.references) {
        const values = valuesOf(row, columns, ref.columns);
        call(
          commands.countReferences(
            ref.sourceSchema,
            ref.sourceTable,
            ref.sourceColumns,
            values,
            COUNT_LIMIT,
          ),
        ).then(
          (n) => record(ref.name, n),
          () => record(ref.name, "error"),
        );
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [row, isNew, info, columns]);

  if (!row) {
    return (
      <aside className="right" aria-label="行の詳細">
        <div className="rh">行の詳細</div>
        <div className="rb">
          <div className="tip">行を選ぶと、ここに全列の値が出ます。</div>
        </div>
      </aside>
    );
  }

  const keyText = info.keyColumns
    .map((k) => `${k} ${row[columns.indexOf(k)] ?? "NULL"}`)
    .join(", ");

  return (
    <aside className="right" aria-label="行の詳細">
      <div className="rh">
        行の詳細 <span className="kbd">{isNew ? "新しい行(未保存)" : keyText || info.name}</span>
      </div>
      <div className="rb">
        {info.columns.map((c) => {
          const v = row[columns.indexOf(c.name)] ?? null;
          const fk = info.foreignKeys.find(
            (f) => f.columns.length === 1 && f.columns[0] === c.name,
          );
          return (
            <div className="fld" key={c.name}>
              <div className="k">
                {c.name}
                <em>{c.typeName}</em>
                {fk && v !== null && (
                  <button type="button" className="fkb" onClick={() => onOpenForeignKey(fk, row)}>
                    {fk.targetTable} を開く →
                  </button>
                )}
              </div>
              {edit?.canEdit(c.name) ? (
                <EditableValue
                  // A new row, or a new value from the grid, resets the draft.
                  key={`${keyText}|${v ?? "\u0000"}`}
                  value={v}
                  typeName={c.typeName}
                  status={edit.status(c.name)}
                  label={c.name}
                  onCommit={(value) => edit.commit(c.name, value)}
                />
              ) : (
                <div className={v === null ? "v nul" : "v"}>
                  {v === null ? "NULL" : pretty(v, c.typeName)}
                </div>
              )}
            </div>
          );
        })}
        {info.references.length > 0 && !isNew && (
          <div className="refs">
            <h5>この行を参照している行</h5>
            {info.references.map((ref) => {
              const n = counts[ref.name];
              return (
                <button
                  type="button"
                  className="ref"
                  key={ref.name}
                  onClick={() => onOpenReference(ref, row)}
                >
                  <span className="mono" style={{ fontSize: 12 }}>
                    {ref.sourceTable}.{ref.sourceColumns.join(", ")}
                  </span>
                  <span className="n">
                    {n === undefined
                      ? "…"
                      : n === "error"
                        ? "?"
                        : n > COUNT_LIMIT
                          ? `${COUNT_LIMIT}+行`
                          : `${n}行`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {edit && (
          <div className="ro">
            値を書き換えると、フォーカスを外したときに未保存の変更になります。保存は{" "}
            {keyLabel("table.save")}。
          </div>
        )}
      </div>
    </aside>
  );
}
