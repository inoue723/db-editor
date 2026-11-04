import { useMemo, useRef, useState } from "react";
import { useCommandApi } from "./CommandProvider";
import { keysFor } from "./keymap";
import { formatKey } from "./keys";
import { COMMANDS } from "./registry";
import { evaluateWhen, type WhenContext } from "./when";

/** A destination of "Open Quickly" (⌘P): a table or a saved query. */
export interface GotoItem {
  id: string;
  title: string;
  detail: string;
  run: () => void;
}

interface Item {
  id: string;
  title: string;
  detail: string;
  keyText: string;
  haystack: string[];
  run: () => void;
}

const RECENT_KEY = "db-editor.recentCommands";
const RECENT_LIMIT = 12;

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function remember(id: string) {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; recent commands are a convenience.
  }
}

/**
 * How well `query` matches `text`: a substring scores by its position, a scattered
 * subsequence (`dup row` → "Duplicate Row") scores lower, no match is 0.
 */
export function matchScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (!q) {
    return 1;
  }
  const flat = t.replace(/\s+/g, "");
  const at = flat.indexOf(q);
  if (at >= 0) {
    return 100 - Math.min(at, 50);
  }
  let i = 0;
  for (const ch of flat) {
    if (ch === q[i]) {
      i++;
      if (i === q.length) {
        return 10;
      }
    }
  }
  return 0;
}

interface Props {
  mode: "commands" | "goto";
  goto: GotoItem[];
  /** `when` context from before the palette took the focus. */
  context: WhenContext;
  onClose: () => void;
  /** Runs a command after the palette has closed and the focus is back. */
  onRun: (command: string) => void;
}

/** The command palette (⌘⇧P) and "Open Quickly" (⌘P), spec 5.4. Type `>` for commands. */
export function CommandPalette({ mode, goto, context, onClose, onRun }: Props) {
  const api = useCommandApi();
  const [query, setQuery] = useState(mode === "commands" ? ">" : "");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const commandMode = query.startsWith(">");
  const q = commandMode ? query.slice(1).trim() : query.trim();

  const items: Item[] = useMemo(() => {
    if (!commandMode) {
      return goto.map((g) => ({
        id: g.id,
        title: g.title,
        detail: g.detail,
        keyText: "",
        haystack: [g.title, g.detail],
        run: g.run,
      }));
    }
    return COMMANDS.filter(
      (c) =>
        !c.hidden &&
        c.id !== "app.commandPalette" &&
        api.available(c.id) &&
        evaluateWhen(c.when, context),
    ).map((c) => {
      const key = keysFor(api.bindings, c.id)[0];
      return {
        id: c.id,
        title: c.title,
        detail: `${c.category} · ${c.titleEn}`,
        keyText: key ? formatKey(key) : "",
        haystack: [c.title, c.titleEn, c.id, c.category],
        run: () => {
          remember(c.id);
          onRun(c.id);
        },
      };
    });
  }, [commandMode, goto, api, context, onRun]);

  const filtered = useMemo(() => {
    const recent = commandMode ? readRecent() : [];
    return items
      .map((item) => ({ item, score: Math.max(...item.haystack.map((h) => matchScore(q, h))) }))
      .filter((x) => x.score > 0)
      .toSorted((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        const ra = recent.indexOf(a.item.id);
        const rb = recent.indexOf(b.item.id);
        return (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb);
      })
      .slice(0, 200)
      .map((x) => x.item);
  }, [items, q, commandMode]);

  const current = Math.min(index, Math.max(0, filtered.length - 1));

  function choose(item: Item | undefined) {
    if (!item) {
      return;
    }
    onClose();
    item.run();
  }

  function move(delta: number) {
    const next = Math.max(0, Math.min(filtered.length - 1, current + delta));
    setIndex(next);
    list.current?.querySelectorAll(".pitem")[next]?.scrollIntoView({ block: "nearest" });
  }

  return (
    <div
      className="scrim top"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <dialog
        open
        className="palette"
        aria-modal="true"
        aria-label={commandMode ? "コマンドパレット" : "テーブル・クエリへジャンプ"}
      >
        <input
          type="text"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the palette exists to be typed into.
          autoFocus
          value={query}
          placeholder={
            commandMode ? "コマンド名で検索" : "テーブル名・クエリ名で検索(> でコマンド)"
          }
          aria-label="検索"
          aria-controls="palette-list"
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              choose(filtered[current]);
            }
          }}
        />
        <div className="plist" id="palette-list" ref={list}>
          {filtered.length === 0 && <div className="pempty">一致するものはありません</div>}
          {filtered.map((item, i) => (
            <button
              type="button"
              key={item.id}
              tabIndex={-1}
              aria-current={i === current}
              className={i === current ? "pitem on" : "pitem"}
              onMouseMove={() => setIndex(i)}
              // Keep the focus in the search field.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(item)}
            >
              <span className="pt">{item.title}</span>
              <span className="pd">{item.detail}</span>
              {item.keyText && <span className="kbd">{item.keyText}</span>}
            </button>
          ))}
        </div>
      </dialog>
    </div>
  );
}
