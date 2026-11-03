import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CommandProvider } from "./commands/CommandProvider";
import { ConnectionWindow } from "./connection/ConnectionWindow";
import { Launcher } from "./launcher/Launcher";
import "./styles.css";
import { ToastProvider } from "./ui/Toast";
import { UpdateNotice } from "./updater/UpdateNotice";

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root element not found");
}

// Connection windows are opened with `?connection=<profile id>`; the main window is the launcher.
const isConnectionWindow = new URLSearchParams(window.location.search).has("connection");

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      {isConnectionWindow ? (
        <CommandProvider>
          <ConnectionWindow />
        </CommandProvider>
      ) : (
        <Launcher />
      )}
    </ToastProvider>
    {/* Dev builds and browser E2E runs have no release to update to. */}
    {import.meta.env.PROD && !isConnectionWindow && <UpdateNotice />}
  </StrictMode>,
);
