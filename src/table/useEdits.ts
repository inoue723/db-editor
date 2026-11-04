import { useCallback, useMemo, useRef, useState } from "react";
import { type EditState, NO_EDITS } from "./edits";

/** Undo steps kept per tab. */
const LIMIT = 200;

interface History {
  past: EditState[];
  present: EditState;
  future: EditState[];
}

const EMPTY: History = { past: [], present: NO_EDITS, future: [] };

export interface Edits {
  /** The current edits. Always up to date, even before the next render. */
  current: () => EditState;
  /** Applies one undoable change. */
  apply: (change: (state: EditState) => EditState) => void;
  /** Replaces the edits and forgets the history (after a save). */
  reset: (state?: EditState) => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
  state: EditState;
}

/**
 * Unsaved edits with undo and redo (spec 6.1, the unsaved layer). One `apply` is one
 * undo step, so a paste of many cells is undone at once.
 */
export function useEdits(): Edits {
  // Kept in a ref so that a command run right after a cell editor commits (⌘S while
  // typing) sees the committed value.
  const history = useRef<History>(EMPTY);
  const [shown, setShown] = useState<History>(EMPTY);
  const commit = useCallback((next: History) => {
    history.current = next;
    setShown(next);
  }, []);

  const apply = useCallback(
    (change: (state: EditState) => EditState) => {
      const h = history.current;
      const next = change(h.present);
      if (next === h.present) {
        return;
      }
      commit({ past: [...h.past, h.present].slice(-LIMIT), present: next, future: [] });
    },
    [commit],
  );

  const reset = useCallback(
    (state: EditState = NO_EDITS) => {
      commit({ past: [], present: state, future: [] });
    },
    [commit],
  );

  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past.at(-1);
    if (!prev) {
      return false;
    }
    commit({
      past: h.past.slice(0, -1),
      present: prev,
      future: [h.present, ...h.future],
    });
    return true;
  }, [commit]);

  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future[0];
    if (!next) {
      return false;
    }
    commit({ past: [...h.past, h.present], present: next, future: h.future.slice(1) });
    return true;
  }, [commit]);

  const current = useCallback(() => history.current.present, []);

  return useMemo(
    () => ({
      current,
      apply,
      reset,
      undo,
      redo,
      canUndo: shown.past.length > 0,
      canRedo: shown.future.length > 0,
      state: shown.present,
    }),
    [current, apply, reset, undo, redo, shown],
  );
}
