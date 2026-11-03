import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";

/** How often a running app looks for a new release, besides the check at startup. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type State =
  | { kind: "idle" }
  | { kind: "available"; update: Update }
  | { kind: "installing"; version: string; downloaded: number; total: number | undefined }
  | { kind: "error"; message: string };

interface Props {
  /** Defaults to the updater plugin's `check`; injectable for tests. */
  checkForUpdate?: () => Promise<Update | null>;
  /** Defaults to the process plugin's `relaunch`; injectable for tests. */
  restart?: () => Promise<void>;
}

/**
 * Looks for a signed update on GitHub Releases and offers to install it.
 *
 * Nothing is downloaded until the user agrees, so a connection or an unsaved edit
 * is never interrupted. A failed check (offline, GitHub down) is logged and not shown:
 * the next check retries.
 */
export function UpdateNotice({ checkForUpdate = check, restart = relaunch }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  // Read by the periodic check, which must not replace a notice or an install in progress.
  const idle = useRef(true);
  useEffect(() => {
    idle.current = state.kind === "idle";
  }, [state]);

  useEffect(() => {
    let disposed = false;

    async function run() {
      try {
        if (!idle.current) {
          return;
        }
        const update = await checkForUpdate();
        if (update === null) {
          return;
        }
        if (disposed || !idle.current) {
          await update.close();
          return;
        }
        setState({ kind: "available", update });
      } catch (error) {
        console.warn("update check failed", error);
      }
    }

    void run();
    const timer = setInterval(() => void run(), CHECK_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [checkForUpdate]);

  async function install(update: Update) {
    setState({ kind: "installing", version: update.version, downloaded: 0, total: undefined });
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          setState((s) =>
            s.kind === "installing" ? { ...s, total: event.data.contentLength } : s,
          );
        } else if (event.event === "Progress") {
          setState((s) =>
            s.kind === "installing"
              ? { ...s, downloaded: s.downloaded + event.data.chunkLength }
              : s,
          );
        }
      });
      await restart();
    } catch (error) {
      setState({ kind: "error", message: String(error) });
    }
  }

  function dismiss() {
    if (state.kind === "available") {
      void state.update.close();
    }
    setState({ kind: "idle" });
  }

  if (state.kind === "idle") {
    return null;
  }

  return (
    <aside aria-label="Update" style={noticeStyle}>
      {state.kind === "available" && (
        <>
          <p>db editor {state.update.version} is available.</p>
          <button type="button" onClick={() => void install(state.update)}>
            Restart to update
          </button>
          <button type="button" onClick={dismiss}>
            Later
          </button>
        </>
      )}
      {state.kind === "installing" && (
        <output>
          Downloading db editor {state.version}
          {state.total ? `… ${Math.floor((state.downloaded / state.total) * 100)}%` : "…"}
        </output>
      )}
      {state.kind === "error" && (
        <>
          <p role="alert">Update failed: {state.message}</p>
          <button type="button" onClick={dismiss}>
            Close
          </button>
        </>
      )}
    </aside>
  );
}

// Bottom-right, so it never covers the red band shown on production connections.
const noticeStyle = {
  position: "fixed",
  right: 16,
  bottom: 16,
  padding: "8px 12px",
  border: "1px solid currentColor",
  borderRadius: 6,
  background: "Canvas",
} as const;
