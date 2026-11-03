import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  clearMocks();
});

test("shows the size of the parsed grid", async () => {
  const calls: unknown[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    return [["a", "b"]];
  });
  const user = userEvent.setup();
  render(<App />);

  await user.type(screen.getByLabelText("Paste TSV"), "a\tb");
  await user.click(screen.getByRole("button", { name: "Parse" }));

  expect(await screen.findByRole("status")).toHaveProperty("textContent", "1 rows × 2 columns");
  expect(calls).toEqual([{ cmd: "parse_tsv", args: { text: "a\tb" } }]);
});

test("shows the error returned by Rust", async () => {
  mockIPC(() => {
    // tauri-specta passes rejected values that are not Error instances through as typed errors.
    throw { kind: "InvalidInput", message: "unterminated quoted field starting on line 1" };
  });
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "Parse" }));

  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Error: unterminated quoted field starting on line 1",
  );
});
