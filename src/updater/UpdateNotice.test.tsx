import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { UpdateNotice } from "./UpdateNotice";

afterEach(cleanup);

type Install = (onEvent: (event: DownloadEvent) => void) => Promise<void>;

/** The parts of `Update` the notice uses, with spies to assert on. */
function fakeUpdate(install: Install) {
  const close = vi.fn<() => Promise<void>>(async () => {});
  const downloadAndInstall = vi.fn<Install>(install);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- partial fake of a Tauri resource
  const update = { version: "0.2.0", close, downloadAndInstall } as unknown as Update;
  return { update, close, downloadAndInstall };
}

const noticeQuery = () => screen.queryByRole("complementary", { name: "Update" });

test("shows nothing when there is no update", async () => {
  const checkForUpdate = vi.fn<() => Promise<Update | null>>(async () => null);
  render(<UpdateNotice checkForUpdate={checkForUpdate} />);

  await vi.waitFor(() => expect(checkForUpdate).toHaveBeenCalledOnce());
  expect(noticeQuery()).toBeNull();
});

test("stays silent when the check fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  render(<UpdateNotice checkForUpdate={async () => Promise.reject(new Error("offline"))} />);

  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  expect(noticeQuery()).toBeNull();
});

test("installs the update and restarts when the user agrees", async () => {
  const { update, downloadAndInstall } = fakeUpdate(async (onEvent) => {
    onEvent({ event: "Started", data: { contentLength: 100 } });
    onEvent({ event: "Progress", data: { chunkLength: 100 } });
    onEvent({ event: "Finished" });
  });
  const restart = vi.fn<() => Promise<void>>(async () => {});
  const user = userEvent.setup();
  render(<UpdateNotice checkForUpdate={async () => update} restart={restart} />);

  expect(await screen.findByText("db editor 0.2.0 is available.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Restart to update" }));

  await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
  expect(downloadAndInstall).toHaveBeenCalledOnce();
});

test("Later hides the notice and releases the update", async () => {
  const { update, close, downloadAndInstall } = fakeUpdate(async () => {});
  const user = userEvent.setup();
  render(<UpdateNotice checkForUpdate={async () => update} />);

  await user.click(await screen.findByRole("button", { name: "Later" }));

  expect(noticeQuery()).toBeNull();
  expect(close).toHaveBeenCalledOnce();
  expect(downloadAndInstall).not.toHaveBeenCalled();
});

test("shows why an install failed", async () => {
  const { update } = fakeUpdate(async () => Promise.reject(new Error("signature mismatch")));
  const restart = vi.fn<() => Promise<void>>(async () => {});
  const user = userEvent.setup();
  render(<UpdateNotice checkForUpdate={async () => update} restart={restart} />);

  await user.click(await screen.findByRole("button", { name: "Restart to update" }));

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Update failed: Error: signature mismatch",
  );
  expect(restart).not.toHaveBeenCalled();
});
