import { useEffect, useLayoutEffect, useRef } from "react";
import { keyLabel } from "../lib/keys";

export type MenuItem =
  | {
      kind?: "item";
      label: string;
      onSelect?: () => void;
      /** Shortcut written the macOS way, for example `⌘C`. */
      shortcut?: string;
      /** Shortcut already formatted for the platform (from the key bindings). */
      keyText?: string;
      disabled?: boolean;
      /** Shown instead of the shortcut, for example the version that adds the feature. */
      tag?: string;
    }
  | { kind: "separator" }
  | { kind: "heading"; label: string };

interface MenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** A context menu at a point. Closes on Escape, a click elsewhere, or a selection. */
export function Menu({ x, y, items, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const { offsetWidth: w, offsetHeight: h } = el;
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 8))}px`;
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 8))}px`;
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !(e.target instanceof Node && ref.current.contains(e.target))) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const buttons = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
        ];
        const i = buttons.findIndex((b) => b === document.activeElement);
        const next =
          e.key === "ArrowDown"
            ? (i + 1) % buttons.length
            : (i - 1 + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div className="menu" role="menu" ref={ref} style={{ left: x, top: y }}>
      {items.map((item, i) => {
        if (item.kind === "separator") {
          // oxlint-disable-next-line react/no-array-index-key -- separators have no identity; the list is static.
          return <hr key={i} />;
        }
        if (item.kind === "heading") {
          return (
            <div key={`h:${item.label}`} className="subh">
              {item.label}
            </div>
          );
        }
        return (
          <button
            key={`i:${item.label}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            {item.label}
            {item.tag ? (
              <span className="tag">{item.tag}</span>
            ) : item.keyText ? (
              <span className="kbd">{item.keyText}</span>
            ) : (
              item.shortcut && <span className="kbd">{keyLabel(item.shortcut)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
