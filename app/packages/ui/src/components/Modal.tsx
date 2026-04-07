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
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={`backdrop:bg-black/60 backdrop:backdrop-blur-sm bg-transparent p-0 m-auto outline-none ${className ?? ""}`}
    >
      {children}
    </dialog>
  );
}
