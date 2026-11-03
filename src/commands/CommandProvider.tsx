import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { commands as api, type KeyBinding } from "../bindings";
import { call, errorMessage } from "../lib/api";
import { type Binding, effectiveBindings, keysFor, matchKey } from "./keymap";
import { eventChord, formatKey } from "./keys";
import type { WhenContext } from "./when";

type Handler = () => void;

interface Registration {
  id: number;
  get: () => Handler | undefined;
}

interface CommandApi {
  bindings: Binding[];
  /** The user's entries of `keybindings.json`. */
  user: KeyBinding[];
  userPath: string;
  /** Set when `keybindings.json` could not be read; the defaults are used. */
  loadError: string | null;
  saveUser: (next: KeyBinding[]) => Promise<void>;
  /** Runs a command; returns false when nothing handles it right now. */
  run: (id: string) => boolean;
  available: (id: string) => boolean;
  register: (command: string, get: () => Handler | undefined) => () => void;
  setContext: (values: WhenContext) => void;
  /** The current `when` context, including the focus. */
  context: () => WhenContext;
  /** While true (recording a key), key presses are not dispatched. */
  suspend: (value: boolean) => void;
}

const Ctx = createContext<CommandApi | null>(null);

/** Where the keyboard focus is, for `focus == ...` clauses. */
export function focusContext(el: Element | null = document.activeElement): string {
  if (!el || el === document.body) {
    return "other";
  }
  if (el.closest(".cm-editor")) {
    return "editor";
  }
  if (el.matches("input, textarea, select, [contenteditable='true']")) {
    return "input";
  }
  if (el.closest(".gridwrap")) {
    return "grid";
  }
  return "other";
}

/** A chord sequence must be finished within this time. */
const CHORD_TIMEOUT_MS = 1500;

/** Dispatches key presses to commands and holds the key bindings (spec 5). */
export function CommandProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<KeyBinding[]>([]);
  const [userPath, setUserPath] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const handlers = useRef(new Map<string, Registration[]>());
  const nextId = useRef(1);
  const extra = useRef<WhenContext>({});
  const suspended = useRef(false);
  const pending = useRef<{ seq: string; at: number } | null>(null);

  const bindings = useMemo(() => effectiveBindings(user), [user]);
  const bindingsRef = useRef(bindings);
  useLayoutEffect(() => {
    bindingsRef.current = bindings;
  }, [bindings]);

  const load = useCallback(async () => {
    try {
      const file = await call(api.loadKeybindings());
      setUser(file.bindings);
      setUserPath(file.path);
      setLoadError(null);
    } catch (e) {
      setUser([]);
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- reads keybindings.json.
    void load();
    // The file may have been edited by hand or in another window.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const saveUser = useCallback(async (next: KeyBinding[]) => {
    await call(api.saveKeybindings(next));
    setUser(next);
    setLoadError(null);
  }, []);

  const handlerFor = useCallback((id: string): Handler | undefined => {
    const list = handlers.current.get(id) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i]?.get();
      if (h) {
        return h;
      }
    }
    return undefined;
  }, []);

  const available = useCallback((id: string) => handlerFor(id) !== undefined, [handlerFor]);

  const run = useCallback(
    (id: string) => {
      const h = handlerFor(id);
      if (!h) {
        return false;
      }
      // Commit an open cell editor first (its blur handler saves the value).
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("[data-cell-editor]")) {
        active.blur();
      }
      h();
      return true;
    },
    [handlerFor],
  );

  const register = useCallback((command: string, get: () => Handler | undefined) => {
    const id = nextId.current++;
    const list = handlers.current.get(command) ?? [];
    list.push({ id, get });
    handlers.current.set(command, list);
    return () => {
      const l = handlers.current.get(command) ?? [];
      handlers.current.set(
        command,
        l.filter((r) => r.id !== id),
      );
    };
  }, []);

  const context = useCallback((): WhenContext => ({ ...extra.current, focus: focusContext() }), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (suspended.current || e.defaultPrevented || e.isComposing) {
        return;
      }
      // Dialogs handle their own keys.
      if (document.querySelector(".scrim")) {
        return;
      }
      const chord = eventChord(e);
      if (!chord) {
        return;
      }
      const now = Date.now();
      const p = pending.current;
      pending.current = null;
      const ctx = context();
      const tryMatch = (seq: string) => matchKey(bindingsRef.current, seq, ctx, available);
      let seq = p && now - p.at < CHORD_TIMEOUT_MS ? `${p.seq} ${chord}` : chord;
      let match = tryMatch(seq);
      if (!match && seq !== chord) {
        seq = chord;
        match = tryMatch(seq);
      }
      if (!match) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (match.kind === "prefix") {
        pending.current = { seq, at: now };
        return;
      }
      run(match.command);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [available, context, run]);

  const value = useMemo<CommandApi>(
    () => ({
      bindings,
      user,
      userPath,
      loadError,
      saveUser,
      run,
      available,
      register,
      setContext: (values) => {
        extra.current = values;
      },
      context,
      suspend: (v) => {
        suspended.current = v;
      },
    }),
    [bindings, user, userPath, loadError, saveUser, run, available, register, context],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const noop = () => undefined;

/** Outside a provider (the launcher, unit tests) commands do nothing. */
const FALLBACK: CommandApi = {
  bindings: effectiveBindings([]),
  user: [],
  userPath: "",
  loadError: null,
  saveUser: async () => undefined,
  run: () => false,
  available: () => false,
  register: () => noop,
  setContext: noop,
  context: () => ({}),
  suspend: noop,
};

export function useCommandApi(): CommandApi {
  return useContext(Ctx) ?? FALLBACK;
}

/**
 * Handles commands while `enabled`. The latest handler functions are called, so they
 * may change on every render.
 */
export function useCommands(
  handlers: Record<string, Handler | false | null | undefined>,
  enabled = true,
): void {
  const { register } = useCommandApi();
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  const ids = Object.keys(handlers).join(",");
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const offs = ids
      .split(",")
      .filter(Boolean)
      .map((id) => register(id, () => latest.current[id] || undefined));
    return () => {
      for (const off of offs) {
        off();
      }
    };
  }, [ids, enabled, register]);
}

/** Sets `when` context keys (such as `tab` and `readOnly`). */
export function useCommandContext(values: WhenContext): void {
  const { setContext } = useCommandApi();
  // Set during render so that a key pressed right after a tab switch sees the new tab.
  setContext(values);
}

/** The display label of a command's first key, or an empty string. */
export function useKeyLabel(): (command: string) => string {
  const { bindings } = useCommandApi();
  return useCallback(
    (command: string) => {
      const key = keysFor(bindings, command)[0];
      return key ? formatKey(key) : "";
    },
    [bindings],
  );
}
