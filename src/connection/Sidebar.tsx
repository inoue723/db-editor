import { type CSSProperties, forwardRef, useMemo, useState } from "react";
import type { RelationKind, SavedQuery, Schema_Serialize } from "../bindings";
import { useKeyLabel } from "../commands/CommandProvider";
import { Menu, type MenuItem } from "../ui/Menu";

interface Group {
  key: string;
  label: string;
  icon: string;
  items: { name: string; detail: string; relation?: boolean }[];
}

const RELATION_GROUPS: { label: string; icon: string; kinds: RelationKind[] }[] = [
  { label: "テーブル", icon: "T", kinds: ["table", "partitionedTable", "foreignTable"] },
  { label: "ビュー", icon: "V", kinds: ["view"] },
  { label: "マテリアライズドビュー", icon: "M", kinds: ["materializedView"] },
];

/** Indentation of a tree row. */
function depth(level: number): CSSProperties {
  return { paddingLeft: 8 + level * 14 };
}

function approx(n: number | null): string {
  if (n === null) {
    return "";
  }
  if (n >= 1_000_000) {
    return `~${(n / 1_000_000).toFixed(1)}M`;
  }
  return `~${Math.round(n).toLocaleString("ja-JP")}`;
}

function groupsOf(schema: Schema_Serialize): Group[] {
  const groups: Group[] = RELATION_GROUPS.map((g) => ({
    key: `${schema.name}/${g.label}`,
    label: g.label,
    icon: g.icon,
    items: schema.relations
      .filter((r) => g.kinds.includes(r.kind))
      .map((r) => ({ name: r.name, detail: approx(r.estimatedRows), relation: true })),
  }));
  groups.push({
    key: `${schema.name}/関数`,
    label: "関数",
    icon: "ƒ",
    items: schema.functions.map((f) => ({ name: `${f.name}(${f.arguments})`, detail: "" })),
  });
  groups.push({
    key: `${schema.name}/型`,
    label: "型",
    icon: "τ",
    items: schema.types.map((t) => ({
      name: t.name,
      detail: t.kind === "e" ? "enum" : t.kind === "d" ? "domain" : "",
    })),
  });
  return groups.filter((g) => g.items.length > 0);
}

interface Props {
  databases: string[];
  database: string;
  onDatabase: (name: string) => void;
  schemas: Schema_Serialize[] | null;
  schemaError: string | null;
  activeTable: { schema: string; table: string } | null;
  onOpen: (schema: string, table: string, newTab: boolean) => void;
  onCopyDdl: (schema: string, table: string) => void;
  onCopyName: (name: string) => void;
  savedQueries: SavedQuery[];
  onOpenSaved: (query: SavedQuery) => void;
  onDeleteSaved: (query: SavedQuery) => void;
  onReload: () => void;
}

/** Schema tree with an incremental filter, and saved queries below (spec 3.3). */
export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar(
  {
    databases,
    database,
    onDatabase,
    schemas,
    schemaError,
    activeTable,
    onOpen,
    onCopyDdl,
    onCopyName,
    savedQueries,
    onOpenSaved,
    onDeleteSaved,
    onReload,
  },
  filterRef,
) {
  const keyLabel = useKeyLabel();
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({
    public: true,
    "public/テーブル": true,
  });
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const q = filter.trim().toLowerCase();

  const tree = useMemo(
    () =>
      (schemas ?? []).map((s) => ({
        schema: s,
        groups: groupsOf(s)
          .map((g) => ({
            ...g,
            items: q ? g.items.filter((i) => i.name.toLowerCase().includes(q)) : g.items,
          }))
          .filter((g) => !q || g.items.length > 0),
      })),
    [schemas, q],
  );

  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));

  function relationMenu(schema: string, table: string): MenuItem[] {
    return [
      { label: "開く", onSelect: () => onOpen(schema, table, false) },
      { label: "新しいタブで開く", onSelect: () => onOpen(schema, table, true) },
      { label: "DDLをコピー", onSelect: () => onCopyDdl(schema, table) },
      { label: "名前をコピー", onSelect: () => onCopyName(table) },
      { kind: "separator" },
      { label: "名前を変更", disabled: true, tag: "v1.0" },
      { label: "空にする", disabled: true, tag: "v1.0" },
      { label: "削除", disabled: true, tag: "v1.0" },
      { label: "エクスポート", disabled: true, tag: "v1.0" },
    ];
  }

  return (
    <aside className="side" aria-label="スキーマ">
      <div className="sh">
        <select
          aria-label="データベース"
          value={database}
          onChange={(e) => onDatabase(e.currentTarget.value)}
        >
          {(databases.includes(database) ? databases : [database, ...databases]).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ibtn"
          onClick={onReload}
          title="スキーマを再読み込み"
          aria-label="スキーマを再読み込み"
        >
          ↻
        </button>
      </div>
      <div className="sf">
        <input
          ref={filterRef}
          type="search"
          aria-label="スキーマを絞り込み"
          placeholder={`絞り込み ${keyLabel("app.filterTree")}`}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setFilter("");
            }
          }}
        />
      </div>
      <div className="tree" role="tree">
        {schemaError && (
          <div className="err tip" style={{ padding: 8 }}>
            {schemaError}
          </div>
        )}
        {!schemas && !schemaError && (
          <div className="tip" style={{ padding: 8 }}>
            読み込み中…
          </div>
        )}
        {tree.map(({ schema, groups }) => {
          if (q && groups.length === 0) {
            return null;
          }
          const schemaOpen = Boolean(q) || Boolean(open[schema.name]);
          return (
            <div key={schema.name}>
              <button
                type="button"
                className="ti"
                style={depth(0)}
                role="treeitem"
                aria-expanded={schemaOpen}
                onClick={() => toggle(schema.name)}
              >
                <span className="car">{schemaOpen ? "▼" : "▶"}</span>
                <span className="ic">S</span>
                <span className="nm">{schema.name}</span>
              </button>
              {schemaOpen &&
                groups.map((g) => {
                  const groupOpen = Boolean(q) || Boolean(open[g.key]);
                  return (
                    <div key={g.key}>
                      <button
                        type="button"
                        className="ti"
                        style={depth(1)}
                        role="treeitem"
                        aria-expanded={groupOpen}
                        onClick={() => toggle(g.key)}
                      >
                        <span className="car">{groupOpen ? "▼" : "▶"}</span>
                        <span className="nm">{g.label}</span>
                        <span className="cnt">{g.items.length}</span>
                      </button>
                      {groupOpen &&
                        g.items.map((item) => {
                          const on =
                            item.relation &&
                            activeTable?.schema === schema.name &&
                            activeTable.table === item.name;
                          return (
                            <button
                              type="button"
                              key={item.name}
                              role="treeitem"
                              className={on ? "ti on" : "ti"}
                              style={depth(2)}
                              title={item.name}
                              onClick={() => item.relation && onOpen(schema.name, item.name, false)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  items: item.relation
                                    ? relationMenu(schema.name, item.name)
                                    : [
                                        {
                                          label: "名前をコピー",
                                          onSelect: () => onCopyName(item.name),
                                        },
                                      ],
                                });
                              }}
                            >
                              <span className="car" />
                              <span className="ic">{g.icon}</span>
                              <span className="nm">{item.name}</span>
                              <span className="cnt">{item.detail}</span>
                            </button>
                          );
                        })}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      <div className="saved" aria-label="保存済みクエリ">
        <div className="side-h">保存済みクエリ</div>
        {savedQueries.length === 0 && (
          <div className="tip" style={{ padding: "0 8px" }}>
            SQLタブの「保存」で追加できます
          </div>
        )}
        {savedQueries.map((s) => (
          <button
            type="button"
            key={s.name}
            className="ti"
            style={depth(0)}
            onClick={() => onOpenSaved(s)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  { label: "開く", onSelect: () => onOpenSaved(s) },
                  { kind: "separator" },
                  { label: "削除", onSelect: () => onDeleteSaved(s) },
                ],
              });
            }}
          >
            <span className="ic">≡</span>
            <span className="nm">{s.name}.sql</span>
          </button>
        ))}
      </div>
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
});
