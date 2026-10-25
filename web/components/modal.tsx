import React, { useEffect, useId, useRef } from "react";
import { CloseIcon } from "./icons.js";

const focusable =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

// Escape and a backdrop click can be accidental, so they ask before discarding
// unsaved input. The explicit 关闭 button always closes.
export function Modal({
  title,
  onClose,
  children,
  busy = false,
  wide = false,
  dirty = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  busy?: boolean;
  wide?: boolean;
  dirty?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Start in the first form field; the close button is the fallback.
    const first =
      ref.current?.querySelector<HTMLElement>(
        "form input:not(:disabled):not([type=checkbox]), form select:not(:disabled), form textarea:not(:disabled)",
      ) ?? ref.current?.querySelector<HTMLElement>(focusable);
    first?.focus();
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
      previous?.focus();
    };
  }, []);
  const dismiss = () => {
    if (busy) return;
    if (dirty && !confirm("放弃未保存的修改？")) return;
    onClose();
  };
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        ref={ref}
        className={`dialog${wide ? " dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            dismiss();
          }
          if (event.key !== "Tab") return;
          const controls = ref.current?.querySelectorAll<HTMLElement>(focusable);
          if (!controls?.length) return;
          const first = controls[0],
            last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="dialog-heading">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            title="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
