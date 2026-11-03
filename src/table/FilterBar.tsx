import { type KeyboardEvent, useState } from "react";
import type { Conjunction, Filter, FilterCondition, FilterOp } from "../bindings";

const OPS: { op: FilterOp; label: string }[] = [
  { op: "eq", label: "=" },
  { op: "notEq", label: "≠" },
  { op: "lt", label: "<" },
  { op: "gt", label: ">" },
  { op: "contains", label: "含む" },
  { op: "startsWith", label: "始まる" },
  { op: "iLike", label: "ILIKE" },
  { op: "in", label: "IN" },
  { op: "isNull", label: "IS NULL" },
  { op: "isNotNull", label: "IS NOT NULL" },
];

const NO_VALUE: ReadonlySet<FilterOp> = new Set<FilterOp>(["isNull", "isNotNull"]);

function quote(v: string): string {
  return `'${v.replaceAll("'", "''")}'`;
}

function ident(c: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(c) ? c : `"${c.replaceAll('"', '""')}"`;
}

function parseConjunction(value: string): Conjunction {
  return value === "or" ? "or" : "and";
}

function parseOp(value: string): FilterOp {
  return OPS.find((o) => o.op === value)?.op ?? "eq";
}

function blank(): FilterCondition {
  return { column: "", op: "eq", value: "", conjunction: "and" };
}

/** Converts structured conditions to an editable WHERE expression for "SQLで書く". */
function toRaw(conditions: FilterCondition[]): string {
  return conditions
    .filter((c) => c.column)
    .map((c, i) => {
      const prefix = i === 0 ? "" : `${c.conjunction.toUpperCase()} `;
      const col = ident(c.column);
      const expr: Record<FilterOp, string> = {
        eq: `${col} = ${quote(c.value)}`,
        notEq: `${col} IS DISTINCT FROM ${quote(c.value)}`,
        lt: `${col} < ${quote(c.value)}`,
        gt: `${col} > ${quote(c.value)}`,
        contains: `${col}::text ILIKE ${quote(`%${c.value}%`)}`,
        startsWith: `${col}::text ILIKE ${quote(`${c.value}%`)}`,
        iLike: `${col}::text ILIKE ${quote(c.value)}`,
        in: `${col} IN (${c.value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
          .map(quote)
          .join(", ")})`,
        isNull: `${col} IS NULL`,
        isNotNull: `${col} IS NOT NULL`,
      };
      return prefix + expr[c.op];
    })
    .join(" ");
}

interface Props {
  columns: string[];
  applied: Filter | null;
  onApply: (filter: Filter | null) => void;
}

/** "column · operator · value" rows joined with AND / OR, or a raw WHERE (spec 3.4). */
export function FilterBar({ columns, applied, onApply }: Props) {
  const [raw, setRaw] = useState(applied?.kind === "raw" ? applied.sql : "");
  const [rawMode, setRawMode] = useState(applied?.kind === "raw");
  const [conditions, setConditions] = useState<FilterCondition[]>(
    applied?.kind === "conditions" && applied.conditions.length ? applied.conditions : [blank()],
  );

  function update(i: number, patch: Partial<FilterCondition>) {
    setConditions((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }

  function apply() {
    if (rawMode) {
      onApply(raw.trim() ? { kind: "raw", sql: raw } : null);
    } else {
      const used = conditions.filter((c) => c.column);
      onApply(used.length ? { kind: "conditions", conditions: used } : null);
    }
  }

  function clear() {
    setConditions([blank()]);
    setRaw("");
    onApply(null);
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  };

  return (
    <div className="fbar">
      {rawMode ? (
        <div className="frow">
          <span className="kbd lead">WHERE</span>
          <input
            className="where"
            aria-label="WHERE句"
            value={raw}
            placeholder="plan <> 'free' AND created_at > now() - interval '30 days'"
            onChange={(e) => setRaw(e.currentTarget.value)}
            onKeyDown={onEnter}
          />
        </div>
      ) : (
        conditions.map((c, i) => (
          // Rows are fully controlled, so a positional key is safe.
          // oxlint-disable-next-line react/no-array-index-key
          <div className="frow" key={i}>
            {i === 0 ? (
              <span className="kbd lead">WHERE</span>
            ) : (
              <select
                className="lead"
                aria-label="結合"
                value={c.conjunction}
                onChange={(e) =>
                  update(i, { conjunction: parseConjunction(e.currentTarget.value) })
                }
              >
                <option value="and">AND</option>
                <option value="or">OR</option>
              </select>
            )}
            <select
              aria-label="列"
              value={c.column}
              onChange={(e) => update(i, { column: e.currentTarget.value })}
            >
              <option value="">列を選択</option>
              {columns.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select
              aria-label="演算子"
              value={c.op}
              onChange={(e) => update(i, { op: parseOp(e.currentTarget.value) })}
            >
              {OPS.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {!NO_VALUE.has(c.op) && (
              <input
                aria-label="値"
                value={c.value}
                placeholder={c.op === "in" ? "a, b, c" : "値"}
                onChange={(e) => update(i, { value: e.currentTarget.value })}
                onKeyDown={onEnter}
              />
            )}
            <button
              type="button"
              className="rm"
              aria-label="条件を削除"
              onClick={() =>
                setConditions((cs) => (cs.length > 1 ? cs.filter((_, j) => j !== i) : [blank()]))
              }
            >
              −
            </button>
            {i === conditions.length - 1 && (
              <button
                type="button"
                className="rm"
                aria-label="条件を追加"
                onClick={() => setConditions((cs) => [...cs, blank()])}
              >
                ＋
              </button>
            )}
          </div>
        ))
      )}
      <div className="acts">
        <button type="button" className="pbtn small" onClick={apply}>
          適用
        </button>
        <button type="button" className="sbtn small" onClick={clear}>
          クリア
        </button>
        <button
          type="button"
          className="ibtn"
          onClick={() => {
            if (!rawMode && !raw) {
              setRaw(toRaw(conditions));
            }
            setRawMode(!rawMode);
          }}
        >
          {rawMode ? "条件で指定" : "SQLで書く"}
        </button>
        <span className="kbd">{applied ? "適用中" : "未適用"}</span>
      </div>
    </div>
  );
}
