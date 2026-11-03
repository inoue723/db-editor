import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { UpdateNotice } from "./updater/UpdateNotice";

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root element not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
    {/* Dev builds and browser E2E runs have no release to update to. */}
    {import.meta.env.PROD && <UpdateNotice />}
  </StrictMode>,
);
