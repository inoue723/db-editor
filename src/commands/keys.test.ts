import { expect, test } from "vitest";
import { eventChord, formatKey, normalizeKey, reservedKey } from "./keys";

const ev = (
  code: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
) => ({
  code,
  key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

test("events become chords with ⌘ on macOS and Ctrl on Linux as mod", () => {
  expect(eventChord(ev("KeyN", { meta: true, shift: true }), true)).toBe("mod+shift+n");
  expect(eventChord(ev("KeyN", { ctrl: true, shift: true }), false)).toBe("mod+shift+n");
  expect(eventChord(ev("ArrowLeft", { meta: true, ctrl: true }), true)).toBe("mod+ctrl+left");
  expect(eventChord(ev("Backspace", { alt: true }), true)).toBe("alt+backspace");
  expect(eventChord(ev("Digit1", { meta: true }), true)).toBe("mod+1");
  expect(eventChord({ ...ev("ShiftLeft"), key: "Shift" }, true)).toBeNull();
});

test("key strings are normalized from VS Code style names", () => {
  expect(normalizeKey("Cmd+Shift+D", true)).toBe("mod+shift+d");
  expect(normalizeKey("shift+cmd+d", true)).toBe("mod+shift+d");
  expect(normalizeKey("ctrl+shift+d", false)).toBe("mod+shift+d");
  expect(normalizeKey("ctrl+shift+d", true)).toBe("ctrl+shift+d");
  expect(normalizeKey("cmd+k  cmd+s", true)).toBe("mod+k mod+s");
  expect(normalizeKey("hyper+x", true)).toBeNull();
  expect(normalizeKey("a b c", true)).toBeNull();
});

test("keys are shown the platform's way", () => {
  expect(formatKey("mod+shift+n", true)).toBe("⇧⌘N");
  expect(formatKey("mod+alt+enter", true)).toBe("⌥⌘↩");
  expect(formatKey("mod+ctrl+left", true)).toBe("⌃⌘←");
  expect(formatKey("mod+shift+n", false)).toBe("Ctrl+Shift+N");
  expect(formatKey("alt+backspace", false)).toBe("Alt+Backspace");
  expect(formatKey("mod+k mod+s", true)).toBe("⌘K ⌘S");
});

test("OS keys are reserved", () => {
  expect(reservedKey("mod+q", true)).toBe(true);
  expect(reservedKey("mod+tab", true)).toBe(true);
  expect(reservedKey("alt+f4", false)).toBe(true);
  expect(reservedKey("mod+d", true)).toBe(false);
});
