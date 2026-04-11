import { useState } from "react";
import { Modal } from "./Modal.js";

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
  const matches = typed === name;

  async function handleConfirm() {
    if (!matches) return;
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-[420px] p-6">
        <h2 className="text-sm font-semibold text-gray-100 mb-1">Delete {kind}</h2>
        <p className="text-xs text-gray-400 mb-4">
          This action cannot be undone. To confirm, type{" "}
          <span className="text-white font-medium select-all">{name}</span> below.
        </p>

        <input
          autoFocus
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches && !deleting) void handleConfirm();
          }}
          placeholder={name}
          spellCheck={false}
          className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder:text-gray-600 outline-none focus:border-red-500/60 focus:ring-1 focus:ring-red-500/30 transition-colors"
        />

        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            disabled={deleting}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors rounded-lg"
          >
            Cancel
          </button>
          <button
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
