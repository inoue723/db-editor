import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { errorMessage } from "../lib/api";
import { useToast } from "../ui/Toast";

/** How often a running app looks for a new release, besides the check at startup. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Coming back to the window checks again once this much time has passed. Timers do not
 * run while the machine sleeps, so this is what catches a release after a long break.
 */
const FOCUS_RECHECK_MS = 15 * 60 * 1000;
const TOAST_ID = "update";

interface Updater {
  /** Checks now and reports the result, including "up to date" and failures. */
  checkNow: () => Promise<void>;
  /** A check started by {@link Updater.checkNow} is running. */
  checking: boolean;
}

const UpdaterContext = createContext<Updater | null>(null);

/** The updater, or null where updates are not checked (dev builds, connection windows). */
export function useUpdater(): Updater | null {
  return useContext(UpdaterContext);
}

interface Props {
  children: ReactNode;
  /** Defaults to the updater plugin's `check`; injectable for tests. */
  checkForUpdate?: () => Promise<Update | null>;
  /** Defaults to the process plugin's `relaunch`; injectable for tests. */
  restart?: () => Promise<void>;
}

/**
 * Looks for a signed update on GitHub Releases and offers it in a toast.
 *
 * Checks at startup, every hour, when the window regains focus after a while, and on demand.
 * Nothing is downloaded until the user agrees, so a connection or an unsaved edit is never
 * interrupted. A failed background check (offline, GitHub down) is only logged: the next
 * check retries. A check the user asked for reports every outcome.
 */
export function UpdaterProvider({ children, checkForUpdate = check, restart = relaunch }: Props) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  // The update on offer, if any; background checks leave it alone.
  const offered = useRef<Update | null>(null);
  const installing = useRef(false);
  const lastCheck = useRef(0);
  const disposed = useRef(false);

  const install = useCallback(
    async (update: Update) => {
      offered.current = null;
      installing.current = true;
      const { version } = update;
      let downloaded = 0;
      let total: number | undefined;
      let shown = -1;
      const progress = () => {
        const percent = total ? Math.floor((downloaded / total) * 100) : 0;
        if (percent !== shown) {
          shown = percent;
          toast(`db editor ${version} をダウンロード中…${total ? ` ${percent}%` : ""}`, {
            id: TOAST_ID,
            sticky: true,
          });
        }
      };
      progress();
      try {
        await update.downloadAndInstall((event: DownloadEvent) => {
          if (event.event === "Started") {
            total = event.data.contentLength;
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
          }
          progress();
        });
        await restart();
      } catch (error) {
        installing.current = false;
        toast(`更新に失敗しました: ${errorMessage(error)}`, { id: TOAST_ID, error: true });
      }
    },
    [restart, toast],
  );

  const offer = useCallback(
    (update: Update) => {
      toast(`db editor ${update.version} が利用できます`, {
        id: TOAST_ID,
        sticky: true,
        actions: [
          { label: "再起動して更新", onClick: () => void install(update) },
          {
            label: "あとで",
            onClick: () => {
              offered.current = null;
              void update.close();
            },
          },
        ],
      });
    },
    [install, toast],
  );

  const run = useCallback(
    async (manual: boolean) => {
      if (installing.current) {
        return;
      }
      if (offered.current) {
        if (manual) {
          offer(offered.current);
        }
        return;
      }
      lastCheck.current = Date.now();
      if (manual) {
        setChecking(true);
      }
      try {
        const update = await checkForUpdate();
        if (update === null) {
          if (manual && !disposed.current) {
            toast(`最新バージョンです (v${import.meta.env.APP_VERSION})`, { id: TOAST_ID });
          }
          return;
        }
        if (disposed.current || installing.current || offered.current) {
          // Another check got there first; keep its offer.
          await update.close();
          if (manual && offered.current) {
            offer(offered.current);
          }
          return;
        }
        offered.current = update;
        offer(update);
      } catch (error) {
        if (manual && !disposed.current) {
          toast(`更新を確認できませんでした: ${errorMessage(error)}`, {
            id: TOAST_ID,
            error: true,
          });
        } else {
          console.warn("update check failed", error);
        }
      } finally {
        if (manual && !disposed.current) {
          setChecking(false);
        }
      }
    },
    [checkForUpdate, offer, toast],
  );

  useEffect(() => {
    disposed.current = false;
    // oxlint-disable-next-line react/set-state-in-effect -- checks the release server.
    void run(false);
    const timer = setInterval(() => void run(false), CHECK_INTERVAL_MS);
    const onFocus = () => {
      if (Date.now() - lastCheck.current >= FOCUS_RECHECK_MS) {
        void run(false);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed.current = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [run]);

  const value = useMemo(() => ({ checkNow: () => run(true), checking }), [run, checking]);

  return <UpdaterContext.Provider value={value}>{children}</UpdaterContext.Provider>;
}
