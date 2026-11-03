import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import type { KeyBinding_Deserialize } from "../bindings";
import { errorMessage } from "../lib/api";
import { Modal } from "../ui/Modal";
import { useCommandApi } from "./CommandProvider";
import {
  addBinding,
  type Binding,
  conflicts,
  isCustomized,
  removeBinding,
  resetCommand,
} from "./keymap";
import { eventChord, formatKey, normalizeKey, reservedKey } from "./keys";
import { COMMAND_BY_ID, COMMANDS, type CommandInfo } from "./registry";
import { matchScore } from "./CommandPalette";

/** After the first chord, wait this long for a second one (a chord sequence). */
const SECOND_CHORD_MS = 1200;

interface Pending {
  command: string;
  key: string;
  conflicts: Binding[];
}

function KeyRecorder({
  onDone,
  onCancel,
}: {
  onDone: (key: string) => void;
  onCancel: () => void;
}) {
  const [chords, setChords] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function onKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && chords.length === 0) {
      onCancel();
      return;
    }
    const chord = eventChord(e.nativeEvent);
    if (!chord) {
      return;
    }
    clearTimeout(timer.current);
    if (chords.length === 1) {
      onDone(`${chords[0]} ${chord}`);
      return;
    }
    setChords([chord]);
    timer.current = setTimeout(() => onDone(chord), SECOND_CHORD_MS);
  }

  return (
    <button
      type="button"
      className="recorder"
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- recording starts at once.
      autoFocus
      onKeyDown={onKeyDown}
      onBlur={onCancel}
    >
      {chords.length === 0
        ? "キーを押してください(Escでやめる)"
        : `${formatKey(chords[0] ?? "")} …続けて押すとコードキー`}
    </button>
  );
}

/** Parses `keybindings.json` text, or `null` when it is not an array of bindings. */
export function parseBindings(text: string): KeyBinding_Deserialize[] | null {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: KeyBinding_Deserialize[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const key: unknown = Reflect.get(item, "key");
    const command: unknown = Reflect.get(item, "command");
    const when: unknown = Reflect.get(item, "when");
    if (typeof key !== "string" || typeof command !== "string") {
      return null;
    }
    out.push(typeof when === "string" ? { key, command, when } : { key, command });
  }
  return out;
}

function sameWhen(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").replace(/\s+/g, "") === (b ?? "").replace(/\s+/g, "");
}

/** Settings › Keyboard Shortcuts (spec 5.3). */
export function KeybindingsEditor({ onClose }: { onClose: () => void }) {
  const api = useCommandApi();
  const [query, setQuery] = useState("");
  const [keyQuery, setKeyQuery] = useState<string | null>(null);
  const [recordingSearch, setRecordingSearch] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [json, setJson] = useState<string | null>(null);

  async function save(next: KeyBinding_Deserialize[]) {
    try {
      await api.saveUser(next);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function bind(command: string, key: string) {
    setRecording(null);
    const normalized = normalizeKey(key);
    if (!normalized) {
      setError(`キー「${key}」を解釈できません`);
      return;
    }
    if (reservedKey(normalized)) {
      setError(`${formatKey(normalized)} はOSが使うため割り当てられません`);
      return;
    }
    const found = conflicts(api.bindings, normalized, command);
    if (found.length > 0) {
      setPending({ command, key: normalized, conflicts: found });
      return;
    }
    void save(addBinding(api.user, api.bindings, command, normalized, false));
  }

  const rows: CommandInfo[] = COMMANDS.filter((c) => {
    if (keyQuery) {
      return api.bindings.some((b) => b.command === c.id && b.key.split(" ").includes(keyQuery));
    }
    if (!query.trim()) {
      return true;
    }
    const keyText = api.bindings
      .filter((b) => b.command === c.id)
      .map((b) => formatKey(b.key))
      .join(" ");
    return [c.title, c.titleEn, c.id, c.category, keyText].some((h) => matchScore(query, h) > 0);
  });

  const pendingWhen = pending && COMMAND_BY_ID.get(pending.command)?.when;
  const canKeepBoth =
    pending !== null && pending.conflicts.every((b) => !sameWhen(b.when, pendingWhen ?? undefined));

  return (
    <Modal
      title="キーボードショートカット"
      onClose={onClose}
      escape={recording === null && !recordingSearch}
      wide
      header={
        <span className="tip mono" title="このファイルを直接編集しても反映されます">
          {api.userPath}
        </span>
      }
      footer={
        <>
          <span className="res">
            {error && (
              <span className="err" role="alert">
                {error}
              </span>
            )}
          </span>
          <button
            type="button"
            className="sbtn"
            onClick={() => setJson(json === null ? JSON.stringify(api.user, null, 2) : null)}
          >
            {json === null ? "JSONで編集" : "一覧に戻る"}
          </button>
          <button
            type="button"
            className="sbtn"
            disabled={api.user.length === 0}
            onClick={() => void save([])}
          >
            すべて既定に戻す
          </button>
          <button type="button" className="pbtn" onClick={onClose}>
            閉じる
          </button>
        </>
      }
    >
      <div className="mblock">
        {api.loadError && (
          <p className="warn" role="alert">
            keybindings.json を読めなかったため既定のキーを使っています: {api.loadError}
          </p>
        )}
        {json !== null ? (
          <>
            <p className="tip">
              keybindings.json
              の内容です。他の環境からのインポートやエクスポートは、ここにコピー&ペーストしてください。
              <code>{'{ "key": "mod+d", "command": "-table.duplicateRow" }'}</code> のように -
              を付けると既定の割り当てを外します。
            </p>
            <textarea
              className="mono kbjson"
              aria-label="keybindings.json"
              value={json}
              spellCheck={false}
              onChange={(e) => setJson(e.currentTarget.value)}
            />
            <div>
              <button
                type="button"
                className="pbtn small"
                onClick={() => {
                  try {
                    const parsed = parseBindings(json);
                    if (!parsed) {
                      setError("key と command を持つオブジェクトの配列にしてください");
                      return;
                    }
                    void save(parsed).then(() => setJson(null));
                  } catch (e) {
                    setError(`JSONとして読めません: ${errorMessage(e)}`);
                  }
                }}
              >
                適用
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="kbsearch">
              <input
                type="search"
                aria-label="コマンドを検索"
                placeholder="コマンド名・キーで検索"
                value={keyQuery ? formatKey(keyQuery) : query}
                readOnly={keyQuery !== null}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              {recordingSearch ? (
                <KeyRecorder
                  onDone={(k) => {
                    setRecordingSearch(false);
                    setKeyQuery(normalizeKey(k)?.split(" ")[0] ?? null);
                  }}
                  onCancel={() => setRecordingSearch(false)}
                />
              ) : (
                <button
                  type="button"
                  className="sbtn small"
                  onClick={() => (keyQuery ? setKeyQuery(null) : setRecordingSearch(true))}
                >
                  {keyQuery ? "キー検索を解除" : "キーを押して検索"}
                </button>
              )}
            </div>
            {pending && (
              <div className="conflict" role="alert">
                <p>
                  {formatKey(pending.key)} は次のコマンドに割り当て済みです:{" "}
                  {pending.conflicts
                    .map((b) => COMMAND_BY_ID.get(b.command)?.title ?? b.command)
                    .join("、")}
                </p>
                <button
                  type="button"
                  className="pbtn small"
                  onClick={() => {
                    const p = pending;
                    setPending(null);
                    void save(addBinding(api.user, api.bindings, p.command, p.key, true));
                  }}
                >
                  置き換える
                </button>
                <button
                  type="button"
                  className="sbtn small"
                  disabled={!canKeepBoth}
                  title={canKeepBoth ? undefined : "条件(when)が同じため両方は使えません"}
                  onClick={() => {
                    const p = pending;
                    setPending(null);
                    void save(addBinding(api.user, api.bindings, p.command, p.key, false));
                  }}
                >
                  両方残す
                </button>
                <button type="button" className="sbtn small" onClick={() => setPending(null)}>
                  やめる
                </button>
              </div>
            )}
            <table className="kbt">
              <thead>
                <tr>
                  <th>コマンド</th>
                  <th>キー</th>
                  <th>条件</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const mine = api.bindings.filter((b) => b.command === c.id);
                  const custom = isCustomized(api.user, c.id);
                  return (
                    <tr key={c.id}>
                      <td>
                        <span className={custom ? "kbn custom" : "kbn"}>{c.title}</span>
                        <span className="tip"> {c.titleEn}</span>
                        <div className="tip mono">{c.id}</div>
                      </td>
                      <td>
                        {recording === c.id ? (
                          <KeyRecorder
                            onDone={(k) => bind(c.id, k)}
                            onCancel={() => setRecording(null)}
                          />
                        ) : (
                          <span className="chips">
                            {mine.length === 0 && <span className="tip">なし</span>}
                            {mine.map((b) => (
                              <span
                                key={`${b.key}|${b.when ?? ""}`}
                                className={b.user ? "chip custom" : "chip"}
                              >
                                <span className="kbd">{formatKey(b.key)}</span>
                                <button
                                  type="button"
                                  aria-label={`${formatKey(b.key)} を外す`}
                                  onClick={() => void save(removeBinding(api.user, b))}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="tip mono">{mine[0]?.when ?? c.when ?? ""}</td>
                      <td className="acts">
                        <button
                          type="button"
                          className="mini"
                          aria-label={`${c.title} にキーを追加`}
                          onClick={() => {
                            setError(null);
                            setRecording(c.id);
                          }}
                        >
                          ＋
                        </button>
                        {custom && (
                          <button
                            type="button"
                            className="mini"
                            onClick={() => void save(resetCommand(api.user, c.id))}
                          >
                            既定に戻す
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Modal>
  );
}
