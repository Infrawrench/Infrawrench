import { useRef, useEffect } from "react";

interface ModalProps {
  /**
   * Dismissal: called for a backdrop click and for Escape.
   *
   * Omit it for a dialog that may only be left through its own controls — a
   * first-run flow, say, where "dismissed" isn't a state the app can be in.
   * Without it the backdrop is inert and Escape is swallowed, which is still a
   * real modal (focus trapped, page behind it inert) rather than an overlay
   * `<div>` pretending to be one.
   */
  onClose?: () => void;
  children: React.ReactNode;
  className?: string;
  /** Accessible name announced by screen readers when the dialog opens. */
  ariaLabel?: string;
  /**
   * Fill the viewport instead of sizing to the content box. For flows that own
   * the whole window (onboarding) rather than floating above it.
   */
  fullScreen?: boolean;
}

/** Which side of the dialog a pointer event landed on. */
type PointerSide = "backdrop" | "content";

export function Modal({ onClose, children, className, ariaLabel, fullScreen }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Where the in-flight pointer interaction began and ended. `null` means no
  // pointer event was seen for the click being handled.
  const pointerStart = useRef<PointerSide | null>(null);
  const pointerEnd = useRef<PointerSide | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !onClose) return;

    // Backdrop click-away: ::backdrop can't take handlers, so events on the
    // dialog element itself (outside the content box) mean the backdrop.
    // Keyboard users get the same dismissal via Escape (the cancel event).
    //
    // The click's target alone is not enough to identify one. Chromium
    // dispatches `click` at the nearest common ancestor of its pointerdown and
    // pointerup targets, so a drag or text selection that starts on a field
    // inside the panel and releases past the panel's edge lands its click on
    // the <dialog> — indistinguishable, by target, from a real backdrop click,
    // and dismissing there discards whatever the user had just typed. Require
    // *both* ends of the interaction to be on the backdrop instead.
    const sideOf = (e: Event): PointerSide => (e.target === dialog ? "backdrop" : "content");

    const handlePointerDown = (e: PointerEvent) => {
      pointerStart.current = sideOf(e);
      pointerEnd.current = null;
    };
    // Pointer capture retargets this to the capturing element, which is the
    // right answer: a captured interaction belongs to the content that took it.
    const handlePointerUp = (e: PointerEvent) => {
      pointerEnd.current = sideOf(e);
    };
    // A cancelled interaction (touch scroll taking over, say) produces no
    // click at all; clear it so it cannot colour the next one.
    const handlePointerCancel = () => {
      pointerStart.current = null;
      pointerEnd.current = null;
    };

    const handleClick = (e: MouseEvent) => {
      const startedInContent = pointerStart.current === "content";
      const endedInContent = pointerEnd.current === "content";
      pointerStart.current = null;
      pointerEnd.current = null;
      if (startedInContent || endedInContent) return;
      // Both null — no pointer interaction was observed, so the target is all
      // there is to go on. That covers a synthetic `.click()`, and a
      // pointerdown that never got its pointerup can only leave a stale value
      // that the next pointerdown overwrites.
      if (e.target === dialog) onClose();
    };

    dialog.addEventListener("pointerdown", handlePointerDown);
    dialog.addEventListener("pointerup", handlePointerUp);
    dialog.addEventListener("pointercancel", handlePointerCancel);
    dialog.addEventListener("click", handleClick);
    return () => {
      dialog.removeEventListener("pointerdown", handlePointerDown);
      dialog.removeEventListener("pointerup", handlePointerUp);
      dialog.removeEventListener("pointercancel", handlePointerCancel);
      dialog.removeEventListener("click", handleClick);
    };
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-label={ariaLabel}
      onCancel={(e) => {
        // Always prevented: the browser's own close would leave the element
        // shut while React still renders it, so dismissal is the host's call.
        e.preventDefault();
        onClose?.();
      }}
      className={`infrawrench-modal ${fullScreen ? "infrawrench-modal--full" : ""} ${className ?? ""}`}
    >
      {children}
      <style>{`
        .infrawrench-modal {
          position: fixed;
          inset: 0;
          margin: auto;
          border: none;
          background: transparent;
          padding: 0;
          max-width: fit-content;
          max-height: fit-content;
        }
        .infrawrench-modal:focus-visible {
          outline: 2px solid var(--color-muted);
          outline-offset: 2px;
        }
        .infrawrench-modal::backdrop {
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(4px);
        }
        .infrawrench-modal--full {
          width: 100%;
          height: 100%;
          max-width: 100%;
          max-height: 100%;
        }
      `}</style>
    </dialog>
  );
}
