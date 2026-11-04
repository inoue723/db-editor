import type { SQLNamespace } from "@codemirror/lang-sql";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format as formatSql } from "sql-formatter";
import {
  commands,
  type HistoryEntry,
  type RunMode,
  type StatementResult_Serialize,
  type TransactionStatus,
} from "../bindings";
import { DataGrid } from "../grid/DataGrid";
import type { Selection } from "../grid/selection";
import { type GridColumn, isNumericType } from "../grid/types";
import { useCommands, useKeyLabel } from "../commands/CommandProvider";
import { ApiError, call, errorMessage } from "../lib/api";
import { Confirm, Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { type EditorHandle, SqlEditor } from "./SqlEditor";

export interface SqlTabState {
  id: string;
  kind: "sql";
  title: string;
  /** Name of the saved query this tab was opened from or saved as. */
  savedName: string | null;
  initialSql: string;
}

interface Props {
  tab: SqlTabState;
  active: boolean;
  rightOpen: boolean;
  schema: SQLNamespace;
  connectionName: string;
  onChange: (patch: Partial<SqlTabState>) => void;
  onTransaction: (status: TransactionStatus) => void;
  onStatus: (text: string) => void;
  onSaved: () => void;
}

function resultLabel(r: StatementResult_Serialize): string {
  if (r.outcome.kind === "rows") {
    return `${r.sql.split(/\s/)[0]?.toUpperCase() ?? ""} · ${r.outcome.totalRows}行 · ${r.elapsedMs} ms`;
  }
  if (r.outcome.kind === "command") {
    return `${r.outcome.command} ${r.outcome.rowsAffected}`;
  }
  return "エラー";
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString()
    ? `今日 ${time}`
    : `${d.toLocaleDateString("ja-JP")} ${time}`;
}

/** A SQL editor tab with result tabs and the query history (spec 3.7). */
export function SqlTab({
  tab,
  active,
  rightOpen,
  schema,
  connectionName,
  onChange,
  onTransaction,
  onStatus,
  onSaved,
}: Props) {
  const toast = useToast();
  const editor = useRef<EditorHandle>(null);
  const [results, setResults] = useState<{
    list: StatementResult_Serialize[];
    offset: number;
  } | null>(null);
  const [resultIndex, setResultIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [confirmRun, setConfirmRun] = useState<{
    sql: string;
    mode: RunMode;
    offset: number;
  } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const textRef = useRef(tab.initialSql);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await call(commands.queryHistory()));
    } catch {
      // History is optional; a broken file must not block the editor.
    }
  }, []);

  useEffect(() => {
    if (active) {
      // Typing goes to the editor right after the tab opens or is switched to.
      editor.current?.focus();
      // oxlint-disable-next-line react/set-state-in-effect -- loads from the backend.
      void loadHistory();
    }
  }, [active, loadHistory]);

  const execute = useCallback(
    async (sql: string, mode: RunMode, offset: number, allowWrites: boolean) => {
      setRunning(true);
      try {
        const run = await call(commands.runSql(sql, mode, allowWrites));
        setResults({ list: run.results, offset });
        const failed = run.results.findIndex((r) => r.outcome.kind === "error");
        setResultIndex(failed >= 0 ? failed : 0);
        onTransaction(run.transaction);
        // Put the cursor on the error position.
        const failedResult = run.results[failed];
        const range = run.ranges[failed];
        if (
          failedResult?.outcome.kind === "error" &&
          failedResult.outcome.error.position &&
          range
        ) {
          editor.current?.moveCursor(offset + range.from + failedResult.outcome.error.position - 1);
        }
        setHistoryCursor(-1);
        void loadHistory();
      } catch (e) {
        if (e instanceof ApiError && e.info.kind === "confirmationRequired") {
          setConfirmRun({ sql, mode, offset });
        } else {
          toast(errorMessage(e), { error: true });
        }
      } finally {
        setRunning(false);
      }
    },
    [onTransaction, loadHistory, toast],
  );

  const run = useCallback(
    (all: boolean) => {
      if (running) {
        return;
      }
      const ed = editor.current;
      if (!ed) {
        return;
      }
      const sel = ed.getSelection();
      if (sel) {
        void execute(sel.text, { kind: "all" }, sel.from, false);
      } else if (all) {
        void execute(ed.getText(), { kind: "all" }, 0, false);
      } else {
        void execute(ed.getText(), { kind: "cursor", position: ed.getCursor() }, 0, false);
      }
    },
    [running, execute],
  );

  const cancel = useCallback(async () => {
    try {
      await call(commands.cancelQuery());
    } catch (e) {
      toast(errorMessage(e), { error: true });
    }
  }, [toast]);

  const format = useCallback(() => {
    try {
      editor.current?.replaceSelectionOrAll((text) =>
        formatSql(text, { language: "postgresql", keywordCase: "upper", tabWidth: 2 }),
      );
    } catch (e) {
      toast(`整形できませんでした: ${errorMessage(e)}`, { error: true });
    }
  }, [toast]);

  const stepHistory = useCallback(
    (delta: number) => {
      if (history.length === 0) {
        return;
      }
      const next = Math.max(-1, Math.min(history.length - 1, historyCursor + delta));
      setHistoryCursor(next);
      const entry = history[next];
      editor.current?.setText(next < 0 ? "" : (entry?.sql ?? ""));
    },
    [history, historyCursor],
  );

  const keyLabel = useKeyLabel();
  useCommands(
    {
      "sql.run": () => run(false),
      "sql.runAll": () => run(true),
      "sql.cancel": () => void cancel(),
      "sql.format": format,
      "sql.historyPrevious": () => stepHistory(1),
      "sql.historyNext": () => stepHistory(-1),
      "sql.save": () => {
        if (tab.savedName) {
          void save(tab.savedName);
        } else {
          setSaving("");
        }
      },
    },
    active,
  );

  async function save(name: string) {
    try {
      const saved = await call(commands.saveQuery(name, textRef.current));
      onChange({ savedName: saved.name, title: saved.name });
      setSaving(null);
      onSaved();
      toast(`「${saved.name}.sql」を保存済みクエリに保存しました`);
    } catch (e) {
      toast(errorMessage(e), { error: true });
    }
  }

  const current = results?.list[resultIndex];

  useEffect(() => {
    if (!active) {
      return;
    }
    if (running) {
      onStatus("実行中…");
    } else if (current?.outcome.kind === "rows") {
      let text = `${current.outcome.totalRows}行 · ${current.elapsedMs} ms`;
      if (current.outcome.totalRows > current.outcome.rows.length) {
        text += `(先頭${current.outcome.rows.length}行を表示)`;
      }
      if (selection?.mode === "rows") {
        text += ` · ${selection.rows.length}行を選択`;
      }
      onStatus(text);
    } else {
      onStatus("");
    }
  }, [active, running, current, selection, onStatus]);

  const resultColumns: GridColumn[] = useMemo(
    () =>
      current?.outcome.kind === "rows"
        ? current.outcome.columns.map((c) => ({
            name: c.name,
            typeName: c.typeName ?? "",
            numeric: isNumericType(c.typeName ?? ""),
          }))
        : [],
    [current],
  );

  const onActiveRowChange = useCallback(
    (_: number | null, sel: Selection | null) => setSelection(sel),
    [],
  );

  const q = historyQuery.toLowerCase();
  const visibleHistory = q ? history.filter((h) => h.sql.toLowerCase().includes(q)) : history;

  return (
    <>
      <div className="toolbar">
        <button type="button" className="pbtn small" onClick={() => run(false)} disabled={running}>
          実行{" "}
          <span className="kbd" style={{ color: "inherit", opacity: 0.8 }}>
            {keyLabel("sql.run")}
          </span>
        </button>
        <button type="button" className="sbtn small" onClick={() => run(true)} disabled={running}>
          全て実行 <span className="kbd">{keyLabel("sql.runAll")}</span>
        </button>
        <button type="button" className="ibtn" onClick={() => void cancel()} disabled={!running}>
          キャンセル <span className="kbd">{keyLabel("sql.cancel")}</span>
        </button>
        <button type="button" className="ibtn" onClick={format}>
          整形 <span className="kbd">{keyLabel("sql.format")}</span>
        </button>
        <span className="sp" />
        <button type="button" className="ibtn" onClick={() => setSaving(tab.savedName ?? "")}>
          {tab.savedName ? "名前を付けて保存" : "保存"}
        </button>
        {tab.savedName && (
          <button type="button" className="ibtn" onClick={() => void save(tab.savedName ?? "")}>
            上書き保存
          </button>
        )}
      </div>
      <div className="body">
        <div className="main sqlwrap">
          <SqlEditor
            ref={editor}
            initialText={tab.initialSql}
            schema={schema}
            onChange={(text) => {
              textRef.current = text;
            }}
          />
          <div className="results">
            {results ? (
              <>
                <div className="rtabs" role="tablist" aria-label="結果">
                  {results.list.map((r, i) => (
                    <button
                      // Results of one run never reorder; the position is the identity.
                      // oxlint-disable-next-line react/no-array-index-key
                      key={i}
                      type="button"
                      role="tab"
                      className={r.outcome.kind === "error" ? "e" : undefined}
                      aria-selected={resultIndex === i}
                      onClick={() => setResultIndex(i)}
                    >
                      {i + 1}. {resultLabel(r)}
                    </button>
                  ))}
                </div>
                {current?.outcome.kind === "rows" ? (
                  <DataGrid
                    active={active}
                    label="クエリ結果"
                    columns={resultColumns}
                    rows={current.outcome.rows}
                    resetKey={`${resultIndex}|${results.list.length}|${current.sql}`}
                    onActiveRowChange={onActiveRowChange}
                  />
                ) : current?.outcome.kind === "command" ? (
                  <div className="msg">
                    <div>
                      {current.outcome.command} {current.outcome.rowsAffected}
                    </div>
                    <div className="muted">{current.elapsedMs} ms</div>
                    <div className="muted">
                      SQLエディタで実行した変更は Undo
                      の対象外です。トランザクション中はコミットするまで他の接続からは見えません。
                    </div>
                  </div>
                ) : current?.outcome.kind === "error" ? (
                  <div className="msg" role="alert">
                    <div className="e">{current.outcome.error.message}</div>
                    {current.outcome.error.detail && (
                      <div>DETAIL: {current.outcome.error.detail}</div>
                    )}
                    {current.outcome.error.hint && <div>HINT: {current.outcome.error.hint}</div>}
                    {current.outcome.error.code && (
                      <div className="muted">SQLSTATE {current.outcome.error.code}</div>
                    )}
                    <div className="muted">{current.sql}</div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="msg">
                <span className="muted">
                  {keyLabel("sql.run")} でカーソル位置の文(選択中なら選択範囲)を、
                  {keyLabel("sql.runAll")} で全文を実行します。結果は文ごとにタブで並びます。
                </span>
              </div>
            )}
          </div>
        </div>
        {rightOpen && (
          <aside className="right" aria-label="クエリ履歴">
            <div className="rh">
              クエリ履歴 <span className="kbd">{connectionName}</span>
            </div>
            <div className="rb">
              <input
                className="search"
                type="search"
                aria-label="履歴を検索"
                placeholder="履歴を検索"
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.currentTarget.value)}
              />
              <div className="hist">
                {visibleHistory.slice(0, 200).map((h) => (
                  <button
                    key={`${h.executedAt}-${h.sql}`}
                    type="button"
                    className="hi"
                    onClick={() => editor.current?.setText(h.sql)}
                    title="クリックでエディタに読み込む"
                  >
                    <code>{h.sql}</code>
                    <small>
                      <span>{formatTime(h.executedAt ?? 0)}</span>
                      <span className={h.ok ? undefined : "e"}>{h.summary.split("\n")[0]}</span>
                      <span>{h.elapsedMs} ms</span>
                    </small>
                  </button>
                ))}
                {visibleHistory.length === 0 && (
                  <div className="tip">
                    {history.length ? "一致する履歴はありません" : "まだ実行したクエリはありません"}
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
      {confirmRun && (
        <Confirm
          title="本番データベースへの書き込み"
          message="本番の接続で、データや構造を変更する可能性のあるSQLを実行します。SQLエディタで実行した変更は Undo できません。実行しますか?"
          confirmLabel="実行する"
          danger
          onCancel={() => setConfirmRun(null)}
          onConfirm={() => {
            const r = confirmRun;
            setConfirmRun(null);
            void execute(r.sql, r.mode, r.offset, true);
          }}
        />
      )}
      {saving !== null && (
        <SaveDialog
          initial={saving}
          onCancel={() => setSaving(null)}
          onSave={(name) => void save(name)}
        />
      )}
    </>
  );
}

function SaveDialog({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <Modal
      title="クエリを保存"
      onClose={onCancel}
      footer={
        <>
          <span className="res tip">設定フォルダに .sql ファイルとして保存します</span>
          <button type="button" className="sbtn" onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            className="pbtn"
            disabled={!name.trim()}
            onClick={() => onSave(name.trim())}
          >
            保存
          </button>
        </>
      }
    >
      <div className="mbody">
        <label htmlFor="q-name">名前</label>
        <input
          type="text"
          id="q-name"
          value={name}
          placeholder="月次売上"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the only field of the dialog.
          autoFocus
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              onSave(name.trim());
            }
          }}
        />
      </div>
    </Modal>
  );
}
