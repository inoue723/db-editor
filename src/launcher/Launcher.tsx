import { useCallback, useEffect, useMemo, useState } from "react";
import { commands, type ConnectionProfile_Serialize } from "../bindings";
import { call, errorMessage } from "../lib/api";
import { ENV_LABEL, ENVIRONMENTS, relativeTime } from "../lib/env";
import { Menu, type MenuItem } from "../ui/Menu";
import { Confirm } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { ConnectionDialog } from "./ConnectionDialog";

const ALL = "すべて";
const NO_GROUP = "グループなし";

type Profile = ConnectionProfile_Serialize;

/** The start screen: saved connections as cards (spec 3.1). */
export function Launcher() {
  const toast = useToast();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [group, setGroup] = useState(ALL);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; profile: Profile } | null>(null);

  const reload = useCallback(async () => {
    try {
      setProfiles(await call(commands.listConnections()));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- loads from the backend.
    void reload();
    // Refresh "last used" when coming back from a connection window.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  const groups = useMemo(() => {
    const names = new Set((profiles ?? []).map((p) => p.group || NO_GROUP));
    return [ALL, ...[...names].toSorted((a, b) => a.localeCompare(b, "ja"))];
  }, [profiles]);

  const visible = useMemo(() => {
    const q = query.toLowerCase();
    return (profiles ?? []).filter(
      (p) =>
        (group === ALL || (p.group || NO_GROUP) === group) &&
        (!q || `${p.name} ${p.host} ${p.database} ${p.user}`.toLowerCase().includes(q)),
    );
  }, [profiles, group, query]);

  const byGroup = useMemo(() => {
    const map = new Map<string, Profile[]>();
    for (const p of visible) {
      const g = p.group || NO_GROUP;
      map.set(g, [...(map.get(g) ?? []), p]);
    }
    return [...map.entries()].toSorted(([a], [b]) => a.localeCompare(b, "ja"));
  }, [visible]);

  async function open(profile: Profile) {
    try {
      await call(commands.openConnectionWindow(profile.id));
    } catch (error) {
      toast(`接続ウィンドウを開けませんでした: ${errorMessage(error)}`, { error: true });
    }
  }

  async function remove(profile: Profile) {
    setDeleting(null);
    try {
      await call(commands.deleteConnection(profile.id));
      await reload();
      toast(`「${profile.name}」を削除しました`);
    } catch (error) {
      toast(errorMessage(error), { error: true });
    }
  }

  function menuItems(profile: Profile): MenuItem[] {
    return [
      { label: "開く", onSelect: () => void open(profile) },
      { label: "編集…", onSelect: () => setEditing(profile) },
      {
        label: "複製",
        onSelect: () =>
          setEditing({ ...profile, id: "", name: `${profile.name} のコピー`, lastUsedAt: null }),
      },
      { kind: "separator" },
      { label: "削除…", onSelect: () => setDeleting(profile) },
    ];
  }

  return (
    <div className="app">
      <div className="launch">
        <nav className="l-side" aria-label="グループ">
          <div className="side-h">グループ</div>
          {groups.map((g) => (
            <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}>
              <span>{g}</span>
              <span className="kbd">
                {g === ALL
                  ? (profiles?.length ?? 0)
                  : (profiles ?? []).filter((p) => (p.group || NO_GROUP) === g).length}
              </span>
            </button>
          ))}
          <div className="side-h">環境ラベル</div>
          {ENVIRONMENTS.map((env) => (
            <div key={env} className="l-envrow">
              <span
                className="dot"
                style={{
                  background: `var(--${env === "development" ? "dev" : env === "staging" ? "stg" : "prod"})`,
                }}
              />
              {ENV_LABEL[env]}
              <span className="kbd">
                {(profiles ?? []).filter((p) => p.environment === env).length}
              </span>
            </div>
          ))}
        </nav>
        <main className="l-main">
          <div className="l-top">
            <input
              className="search"
              type="search"
              aria-label="接続を検索"
              placeholder="接続を検索(名前・ホスト・DB名)"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            <span className="kbd version">v{import.meta.env.APP_VERSION}</span>
            <button type="button" className="pbtn" onClick={() => setEditing("new")}>
              新しい接続
            </button>
          </div>
          {loadError && <div className="err">接続一覧を読み込めませんでした: {loadError}</div>}
          {profiles && profiles.length === 0 && (
            <div className="empty">
              接続がまだありません。「新しい接続」から PostgreSQL の接続先を登録してください。
            </div>
          )}
          {profiles && profiles.length > 0 && visible.length === 0 && (
            <div className="empty">一致する接続はありません</div>
          )}
          {byGroup.map(([g, list]) => (
            <section key={g} className="grp">
              <h3>{g}</h3>
              <div className="cards">
                {list.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="card"
                    onClick={() => void open(p)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, profile: p });
                    }}
                    title="クリックで接続、右クリックで編集"
                  >
                    <span className="top">
                      <span className="dot" style={{ background: p.color }} />
                      <b>{p.name}</b>
                      <span className={`env ${p.environment}`}>{ENV_LABEL[p.environment]}</span>
                    </span>
                    <span className="host">
                      {p.user}@{p.host}:{p.port}/{p.database}
                    </span>
                    <span className="meta">
                      {p.ssl.mode !== "disable" && <span>SSL {p.ssl.mode}</span>}
                      {p.readOnly && <span>読み取り専用</span>}
                      <span className="when">{relativeTime(p.lastUsedAt)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </main>
      </div>
      {menu && (
        <Menu x={menu.x} y={menu.y} items={menuItems(menu.profile)} onClose={() => setMenu(null)} />
      )}
      {editing && (
        <ConnectionDialog
          initial={editing === "new" ? null : editing}
          groups={groups.filter((g) => g !== ALL && g !== NO_GROUP)}
          onClose={() => setEditing(null)}
          onSaved={async (saved, connect) => {
            setEditing(null);
            await reload();
            if (connect) {
              await open(saved);
            } else {
              toast(`「${saved.name}」を保存しました`);
            }
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="接続を削除"
          message={`「${deleting.name}」を削除します。キーチェーンに保存したパスワードも削除されます。`}
          confirmLabel="削除"
          danger
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
