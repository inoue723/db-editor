import { useEffect, useState } from "react";
import { commands, type TableInfo_Serialize } from "../bindings";
import { call, errorMessage } from "../lib/api";
import { useToast } from "../ui/Toast";

const CONSTRAINT_KIND: Record<string, string> = {
  p: "主キー",
  u: "一意",
  f: "外部キー",
  c: "CHECK",
  x: "排他",
};

/** Read-only structure: columns, indexes, constraints and DDL. Editing comes in v1.0. */
export function StructureView({ info }: { info: TableInfo_Serialize }) {
  const toast = useToast();
  const [ddl, setDdl] = useState<string | null>(null);
  const [ddlError, setDdlError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    call(commands.tableDdl(info.schema, info.name)).then(
      (text) => !cancelled && setDdl(text),
      (e: unknown) => !cancelled && setDdlError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [info.schema, info.name]);

  async function copyDdl() {
    if (ddl === null) {
      return;
    }
    try {
      await call(commands.writeClipboard(ddl));
      toast(`${info.name} のDDLをコピーしました`, { preview: ddl });
    } catch (e) {
      toast(errorMessage(e), { error: true });
    }
  }

  return (
    <div className="struct">
      {info.comment && <div className="tip">{info.comment}</div>}
      <section>
        <h3>列</h3>
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>型</th>
              <th>NULL</th>
              <th>DEFAULT</th>
              <th>コメント</th>
            </tr>
          </thead>
          <tbody>
            {info.columns.map((c) => (
              <tr key={c.name}>
                <td className="m">
                  {c.name}
                  {info.keyColumns.includes(c.name) && <span className="kbd"> PK</span>}
                </td>
                <td className="m">{c.typeName}</td>
                <td>{c.notNull ? "NOT NULL" : "可"}</td>
                <td className="m">{c.default ?? ""}</td>
                <td>{c.comment ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {info.indexes.length > 0 && (
        <section>
          <h3>インデックス</h3>
          <table>
            <tbody>
              {info.indexes.map((i) => (
                <tr key={i.name}>
                  <td className="m">{i.name}</td>
                  <td className="m">{i.definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {info.constraints.length > 0 && (
        <section>
          <h3>制約</h3>
          <table>
            <tbody>
              {info.constraints.map((c) => (
                <tr key={c.name}>
                  <td>{CONSTRAINT_KIND[c.kind] ?? c.kind}</td>
                  <td className="m">{c.name}</td>
                  <td className="m">{c.definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {info.references.length > 0 && (
        <section>
          <h3>このテーブルを参照する外部キー</h3>
          <table>
            <tbody>
              {info.references.map((r) => (
                <tr key={`${r.sourceSchema}.${r.sourceTable}.${r.name}`}>
                  <td className="m">
                    {r.sourceSchema}.{r.sourceTable} ({r.sourceColumns.join(", ")})
                  </td>
                  <td className="m">→ ({r.columns.join(", ")})</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <section>
        <h3>
          DDL
          <button
            type="button"
            className="ibtn"
            onClick={() => void copyDdl()}
            disabled={ddl === null}
          >
            コピー
          </button>
        </h3>
        {ddlError ? (
          <div className="err">{ddlError}</div>
        ) : (
          <pre className="ddl">{ddl ?? "読み込み中…"}</pre>
        )}
      </section>
      <div className="ro">
        列の追加・変更やインデックスの作成は v1.0 で入ります。このタブは閲覧のみです。
      </div>
    </div>
  );
}
