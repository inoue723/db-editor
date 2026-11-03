import { useEffect, useState } from "react";
import { commands, type ForeignKey, type Reference, type TableInfo_Serialize } from "../bindings";
import { call } from "../lib/api";
import type { GridRow } from "../grid/types";

/** Counts above this are shown as "1000+" so a big table is never scanned in full. */
const COUNT_LIMIT = 1000;

interface Props {
  info: TableInfo_Serialize;
  /** Column names of the loaded rows, in order. */
  columns: string[];
  row: GridRow | null;
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
export function RowDetail({ info, columns, row, onOpenForeignKey, onOpenReference }: Props) {
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
    if (!row || info.references.length === 0) {
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
  }, [row, info, columns]);

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
        行の詳細 <span className="kbd">{keyText || info.name}</span>
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
              <div className={v === null ? "v nul" : "v"}>
                {v === null ? "NULL" : pretty(v, c.typeName)}
              </div>
            </div>
          );
        })}
        {info.references.length > 0 && (
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
        <div className="ro">v0.1 は閲覧のみです。セルの編集は v0.2 で入ります。</div>
      </div>
    </aside>
  );
}
