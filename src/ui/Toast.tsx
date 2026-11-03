import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

interface ToastState {
  message: string;
  preview: string | undefined;
  error: boolean;
}

type Show = (message: string, options?: { preview?: string | undefined; error?: boolean }) => void;

const ToastContext = createContext<Show>(() => {});

/** Shows short notices at the bottom right ("copied 3 rows", errors). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback<Show>((message, options) => {
    clearTimeout(timer.current);
    const lines = options?.preview?.split("\n");
    const preview =
      lines && lines.length > 6 ? `${lines.slice(0, 6).join("\n")}\n…` : options?.preview;
    setToast({ message, preview, error: options?.error ?? false });
    timer.current = setTimeout(() => setToast(null), options?.error ? 6000 : 3800);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <output className={toast.error ? "toast error" : "toast"}>
          <span className="toast-message">{toast.message}</span>
          {toast.preview && <pre>{toast.preview}</pre>}
        </output>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): Show {
  return useContext(ToastContext);
}
