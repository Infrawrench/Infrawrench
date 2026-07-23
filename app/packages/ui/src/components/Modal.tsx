import { useRef, useEffect } from "react";

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  /** Accessible name announced by screen readers when the dialog opens. */
  ariaLabel?: string;
}

export function Modal({ onClose, children, className, ariaLabel }: ModalProps) {
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
    if (!dialog) return;
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
        e.preventDefault();
        onClose();
      }}
      className={`infrawrench-modal ${className ?? ""}`}
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
      `}</style>
    </dialog>
  );
}
