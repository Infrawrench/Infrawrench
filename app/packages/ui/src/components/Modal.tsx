import { useRef, useEffect } from "react";

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}

export function Modal({ onClose, children, className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={className ?? ""}
      style={{
        position: "fixed",
        inset: 0,
        margin: "auto",
        border: "none",
        background: "transparent",
        padding: 0,
        maxWidth: "fit-content",
        maxHeight: "fit-content",
        outline: "none",
      }}
    >
      {children}
      <style>{`
        dialog::backdrop {
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(4px);
        }
      `}</style>
    </dialog>
  );
}
