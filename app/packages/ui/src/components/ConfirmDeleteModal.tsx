import { useState, useEffect, useRef } from "react";
import { Modal } from "./Modal.js";
import { formatErrorMessage } from "../utils.js";

interface ConfirmDeleteModalProps {
  /** Human-readable label for the kind of thing being deleted, e.g. "account" or "server" */
  kind: string;
  /** The display name the user must type to confirm */
  name: string;
  /** Called when the user confirms deletion */
  onConfirm: () => void | Promise<void>;
  /** Called when the modal is dismissed */
  onClose: () => void;
}

export function ConfirmDeleteModal({ kind, name, onConfirm, onClose }: ConfirmDeleteModalProps) {
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = typed === name;

  // Move focus to the confirmation input when the modal opens (intentional focus management).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleConfirm() {
    if (!matches) return;
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(formatErrorMessage(e));
      setDeleting(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={`Delete ${kind}`}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[420px] p-6">
        <h2 className="text-sm font-semibold text-on-surface mb-1">Delete {kind}</h2>
        <p className="text-xs text-on-surface-tertiary mb-4">
          This action cannot be undone. To confirm, type{" "}
          <span className="text-white font-medium select-all">{name}</span> below.
        </p>

        <label htmlFor="confirm-delete-input" className="sr-only">
          Type {name} to confirm
        </label>
        <input
          id="confirm-delete-input"
          ref={inputRef}
          aria-label={`Type ${name} to confirm`}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches && !deleting) void handleConfirm();
          }}
          placeholder={name}
          spellCheck={false}
          className="w-full px-3 py-2 text-sm bg-surface-overlay border border-border-strong rounded-lg text-on-surface placeholder:text-on-surface-faint outline-none focus:border-red-500/60 focus:ring-1 focus:ring-red-500/30 transition-colors"
        />

        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary transition-colors rounded-lg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!matches || deleting}
            className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:hover:bg-red-600 text-white rounded-lg transition-colors"
          >
            {deleting ? "Deleting…" : `Delete ${kind}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
