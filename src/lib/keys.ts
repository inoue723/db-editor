/**
 * Keyboard helpers. Shortcuts are written the macOS way (⌘ ⌥ ⇧ ⌃) and shown with
 * Ctrl / Alt / Shift on Linux, where ⌘ becomes Ctrl (spec 5.2).
 */

export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Whether the platform's primary modifier (⌘ on macOS, Ctrl on Linux) is held. */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

const LINUX_NAMES: Record<string, string> = {
  "⌘": "Ctrl+",
  "⌥": "Alt+",
  "⇧": "Shift+",
  "⌃": "Ctrl+",
  "↩": "Enter",
  "⌫": "Backspace",
};

/** Formats a shortcut such as `⌥⌘F` for the current platform. */
export function keyLabel(mac: string): string {
  if (isMac) {
    return mac;
  }
  let out = "";
  for (const ch of mac) {
    out += LINUX_NAMES[ch] ?? ch;
  }
  // "Ctrl+Ctrl+" can appear for ⌃⌘; keep one.
  return out.replace("Ctrl+Ctrl+", "Ctrl+Alt+");
}
