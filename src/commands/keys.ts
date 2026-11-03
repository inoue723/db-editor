/**
 * Key strings of the command system (spec 5): `mod+shift+n`, or a chord sequence such
 * as `mod+k mod+s`. `mod` is ⌘ on macOS and Ctrl on Linux, so the same bindings work
 * on both; `ctrl` is the real Control key on macOS (⌃).
 */

import { isMac } from "../lib/keys";

const MODIFIERS = ["mod", "ctrl", "alt", "shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** `KeyboardEvent.code` → key name. Codes keep letters layout-independent, as v0.1 did. */
const CODE_NAMES: Record<string, string> = {
  Enter: "enter",
  NumpadEnter: "enter",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "escape",
  Tab: "tab",
  Space: "space",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Period: ".",
  Comma: ",",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
};

const ALIASES: Record<string, string> = {
  cmd: "mod",
  command: "mod",
  meta: "mod",
  "⌘": "mod",
  option: "alt",
  opt: "alt",
  "⌥": "alt",
  control: "ctrl",
  "⌃": "ctrl",
  "⇧": "shift",
  return: "enter",
  esc: "escape",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};

/** The key name of an event, or `null` for a lone modifier. */
function keyName(e: Pick<KeyboardEvent, "code" | "key">): string | null {
  const { code } = e;
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3).toLowerCase();
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return code.slice(6);
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code.toLowerCase();
  }
  const named = CODE_NAMES[code];
  if (named) {
    return named;
  }
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS"].includes(e.key)) {
    return null;
  }
  // Unknown code (some Linux layouts): fall back to the produced character.
  return e.key.length === 1 ? e.key.toLowerCase() : null;
}

type ChordEvent = Pick<
  KeyboardEvent,
  "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/** The chord of a key event, such as `mod+shift+n`; `null` for a lone modifier. */
export function eventChord(e: ChordEvent, mac = isMac): string | null {
  const name = keyName(e);
  if (!name) {
    return null;
  }
  const mods: Modifier[] = [];
  if (mac ? e.metaKey : e.ctrlKey) {
    mods.push("mod");
  }
  if (mac && e.ctrlKey) {
    mods.push("ctrl");
  }
  if (e.altKey) {
    mods.push("alt");
  }
  if (e.shiftKey) {
    mods.push("shift");
  }
  return [...mods, name].join("+");
}

/** Brings one chord into canonical form (`Cmd+Shift+D` → `mod+shift+d`). */
function normalizeChord(chord: string, mac: boolean): string | null {
  const parts = chord
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  // "mod++" means the plus key.
  if (chord.endsWith("++")) {
    parts.splice(-2, 2, "+");
  }
  const key = parts.pop();
  if (!key) {
    return null;
  }
  const mods = new Set<Modifier>();
  for (const raw of parts) {
    let p = ALIASES[raw] ?? raw;
    // On Linux, Ctrl is the primary modifier.
    if (p === "ctrl" && !mac) {
      p = "mod";
    }
    const m = MODIFIERS.find((x) => x === p);
    if (!m) {
      return null;
    }
    mods.add(m);
  }
  const name = ALIASES[key] ?? key;
  return [...MODIFIERS.filter((m) => mods.has(m)), name].join("+");
}

/** Brings a key string into canonical form, or `null` when it cannot be parsed. */
export function normalizeKey(key: string, mac = isMac): string | null {
  const chords = key.trim().split(/\s+/).filter(Boolean);
  if (chords.length === 0 || chords.length > 2) {
    return null;
  }
  const out: string[] = [];
  for (const c of chords) {
    const n = normalizeChord(c, mac);
    if (!n) {
      return null;
    }
    out.push(n);
  }
  return out.join(" ");
}

const MAC_SYMBOLS: Record<string, string> = {
  enter: "↩",
  backspace: "⌫",
  delete: "⌦",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  escape: "⎋",
  tab: "⇥",
  space: "Space",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
};

const LINUX_NAMES: Record<string, string> = {
  enter: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
};

function formatChord(chord: string, mac: boolean): string {
  const parts = chord.split("+");
  // The plus key itself.
  const key = chord.endsWith("++") ? "+" : (parts.pop() ?? "");
  const mods = new Set(parts.filter(Boolean));
  const keyText = (mac ? MAC_SYMBOLS[key] : LINUX_NAMES[key]) ?? key.toUpperCase();
  if (mac) {
    // Apple's order: ⌃⌥⇧⌘.
    return (
      (mods.has("ctrl") ? "⌃" : "") +
      (mods.has("alt") ? "⌥" : "") +
      (mods.has("shift") ? "⇧" : "") +
      (mods.has("mod") ? "⌘" : "") +
      keyText
    );
  }
  const names = [
    mods.has("mod") || mods.has("ctrl") ? "Ctrl" : "",
    mods.has("alt") ? "Alt" : "",
    mods.has("shift") ? "Shift" : "",
  ].filter(Boolean);
  return [...names, keyText].join("+");
}

/** A key string for display: `⇧⌘N` on macOS, `Ctrl+Shift+N` on Linux. */
export function formatKey(key: string, mac = isMac): string {
  return key
    .split(" ")
    .map((c) => formatChord(c, mac))
    .join(" ");
}

/** Keys the OS keeps for itself; binding them would never work or would break the OS. */
export function reservedKey(key: string, mac = isMac): boolean {
  const first = key.split(" ")[0] ?? "";
  const reserved = mac
    ? ["mod+q", "mod+h", "mod+alt+h", "mod+m", "mod+tab", "mod+space", "mod+shift+tab", "mod+`"]
    : ["alt+tab", "alt+f4", "mod+alt+t", "mod+alt+delete", "alt+shift+tab"];
  return reserved.includes(first);
}
