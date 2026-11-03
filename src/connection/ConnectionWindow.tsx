import type { SQLNamespace } from "@codemirror/lang-sql";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  commands,
  type Filter,
  type SavedQuery,
  type Schema_Serialize,
  type SessionInfo_Serialize,
  type TableInfo_Serialize,
  type TransactionStatus,
} from "../bindings";
import { ApiError, call, errorMessage } from "../lib/api";
import { ENV_LABEL } from "../lib/env";
import { isMod, keyLabel } from "../lib/keys";
import { SqlTab, type SqlTabState } from "../sql/SqlTab";
import { type TableTabState, TableView } from "../table/TableView";
import { Confirm } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { Sidebar } from "./Sidebar";

type Tab = TableTabState | SqlTabState;

let nextId = 1;
const newId = () => `tab-${nextId++}`;

function tableTab(schema: string, table: string, filter: Filter | null): TableTabState {
  return {
    id: newId(),
    kind: "table",
    schema,
    table,
    view: "content",
    filterOpen: filter !== null,
    filter,
    sort: [],
    reload: 0,
  };
}

let sqlCount = 1;
function sqlTab(sql = "", savedName: string | null = null): SqlTabState {
  return {
    id: newId(),
    kind: "sql",
    title: savedName ?? `クエリ ${sqlCount++}`,
    savedName,
    initialSql: sql,
  };
}

/** A window for one connection: schema tree, tabs and status bar (spec 3.1). */
export function ConnectionWindow() {
  const toast = useToast();
  const [info, setInfo] = useState<SessionInfo_Serialize | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<Schema_Serialize[] | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [transaction, setTransaction] = useState<TransactionStatus>("idle");
  const [statusText, setStatusText] = useState("");
  const [columnsCache, setColumnsCache] = useState<Record<string, string[]>>({});
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null);
  const [deleteSaved, setDeleteSaved] = useState<SavedQuery | null>(null);
  const treeFilter = useRef<HTMLInputElement>(null);

  const active = tabs.find((t) => t.id === activeId) ?? null;

  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.info.kind === "notConnected") {
        setLost(true);
      }
      toast(errorMessage(e), { error: true });
    },
    [toast],
  );

  const loadSchemas = useCallback(async () => {
    setSchemaError(null);
    try {
      setSchemas(await call(commands.loadSchemas()));
    } catch (e) {
      setSchemaError(errorMessage(e));
      if (e instanceof ApiError && e.info.kind === "notConnected") {
        setLost(true);
      }
    }
  }, []);

  const loadSaved = useCallback(async () => {
    try {
      setSaved(await call(commands.listSavedQueries()));
    } catch {
      setSaved([]);
    }
  }, []);

  const connect = useCallback(
    async (database: string | null) => {
      setConnecting(true);
      setConnectError(null);
      try {
        const session = await call(commands.sessionConnect(database));
        setInfo(session);
        setLost(false);
        setTransaction("idle");
        setColumnsCache({});
        void loadSchemas();
        void loadSaved();
        call(commands.listDatabases()).then(setDatabases, () => setDatabases([]));
      } catch (e) {
        setConnectError(errorMessage(e));
      } finally {
        setConnecting(false);
      }
    },
    [loadSchemas, loadSaved],
  );

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- connects through the backend.
    void connect(null);
  }, [connect]);

  // Tab state is read through a ref so the open/close helpers can decide outside
  // state updaters, which must stay pure (they run twice in development).
  const tabsRef = useRef(tabs);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const openTable = useCallback(
    (schema: string, table: string, filter: Filter | null, newTab = false) => {
      const existing = newTab
        ? undefined
        : tabsRef.current.find(
            (t): t is TableTabState =>
              t.kind === "table" && t.schema === schema && t.table === table,
          );
      if (existing) {
        setActiveId(existing.id);
        if (filter !== null) {
          setTabs((ts) =>
            ts.map((t) =>
              t.id === existing.id && t.kind === "table"
                ? { ...t, filter, filterOpen: true, view: "content" as const, sort: [] }
                : t,
            ),
          );
        }
        return;
      }
      const tab = tableTab(schema, table, filter);
      setTabs((ts) => [...ts, tab]);
      setActiveId(tab.id);
    },
    [],
  );

  const openSql = useCallback((sql = "", savedName: string | null = null) => {
    const existing = savedName
      ? tabsRef.current.find((t) => t.kind === "sql" && t.savedName === savedName)
      : undefined;
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const tab = sqlTab(sql, savedName);
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  }, []);

  const closeTab = useCallback((id: string) => {
    const ts = tabsRef.current;
    const i = ts.findIndex((t) => t.id === id);
    const rest = ts.filter((t) => t.id !== id);
    setTabs((current) => current.filter((t) => t.id !== id));
    setActiveId((current) => (current === id ? (rest[Math.max(0, i - 1)]?.id ?? null) : current));
  }, []);

  const patchTable = useCallback((id: string, patch: Partial<TableTabState>) => {
    setTabs((ts) => ts.map((t) => (t.id === id && t.kind === "table" ? { ...t, ...patch } : t)));
  }, []);

  const patchSql = useCallback((id: string, patch: Partial<SqlTabState>) => {
    setTabs((ts) => ts.map((t) => (t.id === id && t.kind === "sql" ? { ...t, ...patch } : t)));
  }, []);

  const onInfo = useCallback((table: TableInfo_Serialize) => {
    setColumnsCache((c) => ({
      ...c,
      [`${table.schema}.${table.name}`]: table.columns.map((col) => col.name),
    }));
  }, []);

  const completion: SQLNamespace = useMemo(() => {
    const ns: Record<string, Record<string, string[]>> = {};
    for (const s of schemas ?? []) {
      const tables: Record<string, string[]> = {};
      for (const r of s.relations) {
        tables[r.name] = columnsCache[`${s.name}.${r.name}`] ?? [];
      }
      ns[s.name] = tables;
    }
    return ns;
  }, [schemas, columnsCache]);

  async function copyDdl(schema: string, table: string) {
    try {
      const ddl = await call(commands.tableDdl(schema, table));
      await call(commands.writeClipboard(ddl));
      toast(`${table} のDDLをコピーしました`, { preview: ddl });
    } catch (e) {
      handleError(e);
    }
  }

  async function copyName(name: string) {
    try {
      await call(commands.writeClipboard(name));
      toast(`「${name}」をコピーしました`);
    } catch (e) {
      handleError(e);
    }
  }

  async function finishTransaction(sql: "COMMIT" | "ROLLBACK") {
    try {
      const result = await call(commands.runSql(sql, { kind: "all" }, true));
      setTransaction(result.transaction);
      const outcome = result.results[0]?.outcome;
      if (outcome?.kind === "error") {
        toast(outcome.error.message, { error: true });
      } else {
        toast(sql === "COMMIT" ? "コミットしました" : "ロールバックしました");
      }
    } catch (e) {
      handleError(e);
    }
  }

  async function switchDatabase(name: string) {
    setConfirmSwitch(null);
    setTabs([]);
    setActiveId(null);
    setSchemas(null);
    await connect(name);
  }

  // Window-level shortcuts (spec 5.2). Grid and editor keys are handled where the focus is.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isMod(e) || !info) {
        return;
      }
      const tab = tabs.find((t) => t.id === activeId);
      const key = e.code;
      const handled = (() => {
        if (key === "KeyT" && !e.altKey && !e.shiftKey) {
          openSql();
          return true;
        }
        if (key === "KeyW" && !e.altKey && !e.shiftKey) {
          if (activeId) {
            closeTab(activeId);
          }
          return true;
        }
        if (/^Digit[1-9]$/.test(key) && !e.altKey && !e.shiftKey) {
          const i = Number(key.slice(5)) - 1;
          const target = i === 8 ? tabs[tabs.length - 1] : tabs[i];
          if (target) {
            setActiveId(target.id);
          }
          return true;
        }
        if (key === "Digit0" && !e.shiftKey) {
          if (e.altKey) {
            setRightOpen((v) => !v);
          } else {
            setLeftOpen((v) => !v);
          }
          return true;
        }
        if (key === "KeyR" && !e.altKey && !e.shiftKey) {
          if (tab?.kind === "table") {
            patchTable(tab.id, { reload: tab.reload + 1 });
          } else {
            void loadSchemas();
          }
          return true;
        }
        if (key === "KeyT" && e.altKey && tab?.kind === "table") {
          patchTable(tab.id, { view: tab.view === "content" ? "structure" : "content" });
          return true;
        }
        if (key === "KeyF" && e.altKey && !e.shiftKey && tab?.kind === "table") {
          patchTable(tab.id, { filterOpen: !tab.filterOpen, view: "content" });
          return true;
        }
        if (key === "KeyF" && e.shiftKey && !e.altKey) {
          setLeftOpen(true);
          setTimeout(() => treeFilter.current?.focus(), 0);
          return true;
        }
        return false;
      })();
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [info, tabs, activeId, openSql, closeTab, patchTable, loadSchemas]);

  if (!info) {
    if (connecting || !connectError) {
      return <div className="empty">接続しています…</div>;
    }
    return (
      <div className="empty" role="alert">
        <p>接続できませんでした。</p>
        <pre className="err" style={{ whiteSpace: "pre-wrap" }}>
          {connectError}
        </pre>
        <p className="tip">ランチャーで接続設定(ホスト、パスワード、SSL)を確認してください。</p>
        <button type="button" className="pbtn" onClick={() => void connect(null)}>
          再試行
        </button>
      </div>
    );
  }

  const profile = info.profile;
  const prod = profile.environment === "production";

  return (
    <div className="app">
      {prod && (
        <div className="prodband" role="note">
          本番 · {profile.name}{" "}
          <span>{profile.readOnly ? "読み取り専用で接続中" : "書き込み可能"}</span>
        </div>
      )}
      {(lost || connecting || connectError) && (
        <div className="banner" role="alert">
          {connecting
            ? "接続しています…"
            : connectError
              ? `接続できませんでした: ${connectError}`
              : "接続が切れました。"}
          {!connecting && (
            <button
              type="button"
              className="sbtn small"
              onClick={() => void connect(info.database)}
            >
              再接続
            </button>
          )}
        </div>
      )}
      <div className="cw">
        {leftOpen && (
          <Sidebar
            ref={treeFilter}
            databases={databases}
            database={info.database}
            onDatabase={(name) => {
              if (name === info.database) {
                return;
              }
              if (tabs.length > 0) {
                setConfirmSwitch(name);
              } else {
                void switchDatabase(name);
              }
            }}
            schemas={schemas}
            schemaError={schemaError}
            activeTable={
              active?.kind === "table" ? { schema: active.schema, table: active.table } : null
            }
            onOpen={(schema, table, newTab) => openTable(schema, table, null, newTab)}
            onCopyDdl={(schema, table) => void copyDdl(schema, table)}
            onCopyName={(name) => void copyName(name)}
            savedQueries={saved}
            onOpenSaved={(q) => openSql(q.sql, q.name)}
            onDeleteSaved={setDeleteSaved}
            onReload={() => void loadSchemas()}
          />
        )}
        <div className="center">
          <div className="tabs" role="tablist" aria-label="タブ">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={t.id === activeId ? "tab on" : "tab"}
                role="tab"
                aria-selected={t.id === activeId}
                tabIndex={0}
                onClick={() => setActiveId(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    setActiveId(t.id);
                  }
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    closeTab(t.id);
                  }
                }}
                title={t.kind === "table" ? `${t.schema}.${t.table}` : t.title}
              >
                <span className="tic">{t.kind === "sql" ? "SQL" : "T"}</span>
                <span className="tt">{t.kind === "sql" ? t.title : t.table}</span>
                <button
                  type="button"
                  className="x"
                  aria-label="タブを閉じる"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="add"
              onClick={() => openSql()}
              title={`新しいSQLタブ ${keyLabel("⌘T")}`}
              aria-label="新しいSQLタブ"
            >
              +
            </button>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="ibtn"
              aria-pressed={leftOpen}
              onClick={() => setLeftOpen((v) => !v)}
              title={`左パネル ${keyLabel("⌘0")}`}
            >
              左 <span className="kbd">{keyLabel("⌘0")}</span>
            </button>
            <button
              type="button"
              className="ibtn"
              aria-pressed={rightOpen}
              onClick={() => setRightOpen((v) => !v)}
              title={`右パネル ${keyLabel("⌥⌘0")}`}
            >
              右 <span className="kbd">{keyLabel("⌥⌘0")}</span>
            </button>
          </div>
          {tabs.length === 0 && (
            <div className="empty">
              左のツリーからテーブルを開くか、+ ({keyLabel("⌘T")}) でSQLタブを作ります。
            </div>
          )}
          {tabs.map((t) => (
            <div
              key={t.id}
              className="main"
              style={{ display: t.id === activeId ? "flex" : "none" }}
              role="tabpanel"
            >
              {t.kind === "table" ? (
                <TableView
                  tab={t}
                  active={t.id === activeId}
                  rightOpen={rightOpen}
                  onChange={(patch) => patchTable(t.id, patch)}
                  onOpenTable={openTable}
                  onStatus={setStatusText}
                  onInfo={onInfo}
                />
              ) : (
                <SqlTab
                  tab={t}
                  active={t.id === activeId}
                  rightOpen={rightOpen}
                  schema={completion}
                  connectionName={profile.name}
                  onChange={(patch) => patchSql(t.id, patch)}
                  onTransaction={setTransaction}
                  onStatus={setStatusText}
                  onSaved={() => void loadSaved()}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      <footer className="status" aria-label="ステータス">
        <span className="dot" style={{ background: profile.color }} />
        <span className="mono addr">
          {profile.user}@{profile.host}:{profile.port}/{info.database}
        </span>
        <span>PostgreSQL {info.serverVersion}</span>
        <span className={`env ${profile.environment}`}>{ENV_LABEL[profile.environment]}</span>
        {transaction === "idle" ? (
          <span className="pill auto">自動コミット</span>
        ) : (
          <>
            <span className={transaction === "failed" ? "pill failed" : "pill tx"}>
              ●{" "}
              {transaction === "failed"
                ? "トランザクション失敗(ロールバックしてください)"
                : "トランザクション中"}
            </span>
            {transaction === "inTransaction" && (
              <button
                type="button"
                className="mini"
                onClick={() => void finishTransaction("COMMIT")}
              >
                コミット
              </button>
            )}
            <button
              type="button"
              className="mini"
              onClick={() => void finishTransaction("ROLLBACK")}
            >
              ロールバック
            </button>
          </>
        )}
        {profile.readOnly && <span className="pill ro">読み取り専用</span>}
        <span className="sp" />
        <span>{active ? statusText : ""}</span>
      </footer>
      {confirmSwitch && (
        <Confirm
          title="データベースを切り替え"
          message={`「${confirmSwitch}」に切り替えます。開いているタブはすべて閉じます。`}
          confirmLabel="切り替える"
          onConfirm={() => void switchDatabase(confirmSwitch)}
          onCancel={() => setConfirmSwitch(null)}
        />
      )}
      {deleteSaved && (
        <Confirm
          title="保存済みクエリを削除"
          message={`「${deleteSaved.name}.sql」を削除します。`}
          confirmLabel="削除"
          danger
          onCancel={() => setDeleteSaved(null)}
          onConfirm={() => {
            const q = deleteSaved;
            setDeleteSaved(null);
            call(commands.deleteSavedQuery(q.name)).then(() => void loadSaved(), handleError);
          }}
        />
      )}
    </div>
  );
}
