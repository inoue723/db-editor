import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ToastProvider, type ToastOptions, useToast } from "./Toast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Show = ReturnType<typeof useToast>;
let show: Show = () => () => {};

function Capture({ onShow }: { onShow: (show: Show) => void }) {
  const toastFn = useToast();
  useEffect(() => onShow(toastFn), [onShow, toastFn]);
  return null;
}

function renderToasts() {
  render(
    <ToastProvider>
      <Capture
        onShow={(fn) => {
          show = fn;
        }}
      />
    </ToastProvider>,
  );
}

const messages = () => screen.queryAllByRole("status").map((t) => t.textContent);

function toast(message: string, options?: ToastOptions) {
  let dismiss: (() => void) | undefined;
  act(() => {
    dismiss = show(message, options);
  });
  return () => dismiss?.();
}

test("ordinary toasts replace each other and disappear on their own", () => {
  vi.useFakeTimers();
  renderToasts();

  toast("one");
  toast("two");
  expect(messages()).toEqual(["two"]);

  act(() => {
    vi.advanceTimersByTime(5000);
  });
  expect(messages()).toEqual([]);
});

test("a sticky toast stays alongside ordinary ones until an action is clicked", () => {
  vi.useFakeTimers();
  renderToasts();
  const onClick = vi.fn<() => void>();

  toast("update", { id: "update", sticky: true, actions: [{ label: "OK", onClick }] });
  toast("copied");
  expect(messages()).toEqual(["updateOK", "copied"]);

  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(messages()).toEqual(["updateOK"]);

  act(() => screen.getByRole("button", { name: "OK" }).click());
  expect(onClick).toHaveBeenCalledOnce();
  expect(messages()).toEqual([]);
});

test("dismissing a replaced toast leaves its replacement", () => {
  renderToasts();

  const dismissOld = toast("old", { id: "x", sticky: true });
  toast("new", { id: "x", sticky: true });
  act(() => dismissOld());

  expect(messages()).toEqual(["new"]);
});
