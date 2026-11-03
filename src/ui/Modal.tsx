import { type ReactNode, useEffect } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  header?: ReactNode;
  /** Whether Escape closes the dialog (off while a field records key presses). */
  escape?: boolean;
  /** A wider dialog, for tables and SQL. */
  wide?: boolean;
}

/** A dialog over the window. Escape and a click outside close it. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  header,
  escape = true,
  wide = false,
}: ModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && escape) {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, escape]);

  return (
    <div
      className="scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <dialog open className={wide ? "modal wide" : "modal"} aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          {header}
        </header>
        {children}
        <footer>{footer}</footer>
      </dialog>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A yes/no question. */
export function Confirm({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <span className="res" />
          <button type="button" className="sbtn" onClick={onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            className={danger ? "pbtn danger" : "pbtn"}
            onClick={onConfirm}
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the confirm button is the only action.
            autoFocus
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="mtext">{message}</div>
    </Modal>
  );
}
