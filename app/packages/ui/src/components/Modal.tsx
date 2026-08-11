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

export function Modal({ onClose, children, className, ariaLabel, fullScreen }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

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
    // Backdrop click-away: ::backdrop can't take handlers, so clicks on the
    // dialog element itself (outside the content box) mean the backdrop.
    // Keyboard users get the same dismissal via Escape (the cancel event).
    const handleClick = (e: MouseEvent) => {
      if (e.target === dialog) onClose();
    };
    dialog.addEventListener("click", handleClick);
    return () => dialog.removeEventListener("click", handleClick);
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
