import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

interface ToastAction {
  label: string;
  /** Runs after the toast is dismissed; it may show a new toast with the same id. */
  onClick: () => void;
}

export interface ToastOptions {
  preview?: string | undefined;
  error?: boolean;
  /**
   * Toasts with the same id replace each other in place; toasts with different ids stack.
   * Ordinary notices share one slot, so a new one replaces the last.
   */
  id?: string;
  /** Keeps the toast until an action is clicked or it is replaced. */
  sticky?: boolean;
  actions?: ToastAction[];
}

/** Shows a toast and returns a function that dismisses it (if it is still shown). */
type Show = (message: string, options?: ToastOptions) => () => void;

interface Entry {
  key: number;
  id: string;
  message: string;
  preview: string | undefined;
  error: boolean;
  actions: ToastAction[];
}

const DEFAULT_ID = "notice";

const ToastContext = createContext<Show>(() => () => {});

/** Shows short notices at the bottom right ("copied 3 rows", errors, available updates). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Entry[]>([]);
  // Per id: the key of the toast shown under it, and its auto-dismiss timer.
  const current = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nextKey = useRef(0);

  const dismiss = useCallback((id: string, key: number) => {
    if (current.current.get(id) !== key) {
      return;
    }
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    current.current.delete(id);
    setToasts((ts) => ts.filter((t) => t.key !== key));
  }, []);

  const show = useCallback<Show>(
    (message, options) => {
      const id = options?.id ?? DEFAULT_ID;
      nextKey.current += 1;
      const key = nextKey.current;
      const lines = options?.preview?.split("\n");
      const preview =
        lines && lines.length > 6 ? `${lines.slice(0, 6).join("\n")}\n…` : options?.preview;
      const entry: Entry = {
        key,
        id,
        message,
        preview,
        error: options?.error ?? false,
        actions: options?.actions ?? [],
      };

      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      current.current.set(id, key);
      setToasts((ts) =>
        ts.some((t) => t.id === id) ? ts.map((t) => (t.id === id ? entry : t)) : [...ts, entry],
      );
      if (!options?.sticky) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id, key), options?.error ? 6000 : 3800),
        );
      }
      return () => dismiss(id, key);
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <output key={t.id} className={t.error ? "toast error" : "toast"}>
              <span className="toast-message">{t.message}</span>
              {t.preview && <pre>{t.preview}</pre>}
              {t.actions.length > 0 && (
                <span className="toast-actions">
                  {t.actions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={() => {
                        dismiss(t.id, t.key);
                        action.onClick();
                      }}
                    >
                      {action.label}
                    </button>
                  ))}
                </span>
              )}
            </output>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): Show {
  return useContext(ToastContext);
}
