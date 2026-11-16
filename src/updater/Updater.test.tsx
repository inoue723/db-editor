import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { ToastProvider } from "../ui/Toast";
import { UpdaterProvider, useUpdater } from "./Updater";

afterEach(cleanup);

type Install = (onEvent: (event: DownloadEvent) => void) => Promise<void>;

/** The parts of `Update` the updater uses, with spies to assert on. */
function fakeUpdate(install: Install = async () => {}) {
  const close = vi.fn<() => Promise<void>>(async () => {});
  const downloadAndInstall = vi.fn<Install>(install);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- partial fake of a Tauri resource
  const update = { version: "0.2.0", close, downloadAndInstall } as unknown as Update;
  return { update, close, downloadAndInstall };
}

function CheckButton() {
  const updater = useUpdater();
  return (
    <button type="button" disabled={updater?.checking} onClick={() => void updater?.checkNow()}>
      check
    </button>
  );
}

function renderUpdater(
  checkForUpdate: () => Promise<Update | null>,
  restart: () => Promise<void> = async () => {},
) {
  return render(
    <ToastProvider>
      <UpdaterProvider checkForUpdate={checkForUpdate} restart={restart}>
        <CheckButton />
      </UpdaterProvider>
    </ToastProvider>,
  );
}

const toastQuery = () => screen.queryByRole("status");

test("shows nothing when the startup check finds no update", async () => {
  const checkForUpdate = vi.fn<() => Promise<Update | null>>(async () => null);
  renderUpdater(checkForUpdate);

  await vi.waitFor(() => expect(checkForUpdate).toHaveBeenCalledOnce());
  expect(toastQuery()).toBeNull();
});

test("stays silent when the startup check fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  renderUpdater(async () => Promise.reject(new Error("offline")));

  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  expect(toastQuery()).toBeNull();
});

test("offers an update found at startup in a toast and installs it", async () => {
  const { update, downloadAndInstall } = fakeUpdate(async (onEvent) => {
    onEvent({ event: "Started", data: { contentLength: 100 } });
    onEvent({ event: "Progress", data: { chunkLength: 100 } });
    onEvent({ event: "Finished" });
  });
  const restart = vi.fn<() => Promise<void>>(async () => {});
  const user = userEvent.setup();
  renderUpdater(async () => update, restart);

  expect(await screen.findByText("db editor 0.2.0 が利用できます")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "再起動して更新" }));

  await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
  expect(downloadAndInstall).toHaveBeenCalledOnce();
});

test("Later hides the toast and releases the update", async () => {
  const { update, close, downloadAndInstall } = fakeUpdate();
  const user = userEvent.setup();
  renderUpdater(async () => update);

  await user.click(await screen.findByRole("button", { name: "あとで" }));

  expect(toastQuery()).toBeNull();
  expect(close).toHaveBeenCalledOnce();
  expect(downloadAndInstall).not.toHaveBeenCalled();
});

test("shows why an install failed", async () => {
  const { update } = fakeUpdate(async () => Promise.reject(new Error("signature mismatch")));
  const restart = vi.fn<() => Promise<void>>(async () => {});
  const user = userEvent.setup();
  renderUpdater(async () => update, restart);

  await user.click(await screen.findByRole("button", { name: "再起動して更新" }));

  expect(await screen.findByText("更新に失敗しました: signature mismatch")).toBeTruthy();
  expect(restart).not.toHaveBeenCalled();
});

test("a manual check finds a release published after startup", async () => {
  const { update } = fakeUpdate();
  const checkForUpdate = vi
    .fn<() => Promise<Update | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValue(update);
  const user = userEvent.setup();
  renderUpdater(checkForUpdate);
  await vi.waitFor(() => expect(checkForUpdate).toHaveBeenCalled());

  await user.click(screen.getByRole("button", { name: "check" }));

  expect(await screen.findByText("db editor 0.2.0 が利用できます")).toBeTruthy();
});

test("a manual check reports when the app is up to date", async () => {
  const user = userEvent.setup();
  renderUpdater(async () => null);

  await user.click(screen.getByRole("button", { name: "check" }));

  expect((await screen.findByRole("status")).textContent).toMatch(/^最新バージョンです/);
});

test("a manual check reports a failure", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const user = userEvent.setup();
  renderUpdater(async () => Promise.reject(new Error("offline")));

  await user.click(screen.getByRole("button", { name: "check" }));

  expect(await screen.findByText("更新を確認できませんでした: offline")).toBeTruthy();
});

test("a newer check does not replace an update already on offer", async () => {
  const first = fakeUpdate();
  const second = fakeUpdate();
  const checkForUpdate = vi
    .fn<() => Promise<Update | null>>()
    .mockResolvedValueOnce(first.update)
    .mockResolvedValue(second.update);
  const user = userEvent.setup();
  renderUpdater(checkForUpdate);
  await screen.findByText("db editor 0.2.0 が利用できます");

  await user.click(screen.getByRole("button", { name: "check" }));
  await user.click(screen.getByRole("button", { name: "再起動して更新" }));

  expect(first.downloadAndInstall).toHaveBeenCalledOnce();
  expect(second.downloadAndInstall).not.toHaveBeenCalled();
});
