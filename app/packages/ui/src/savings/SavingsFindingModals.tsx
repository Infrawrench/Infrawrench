import { useEffect, useRef, useState } from "react";
import { useGT } from "gt-react";
import {
  SAVINGS_FINDING_LIMITS,
  SAVINGS_VIEW_LIMITS,
  type SavingsFindingStatus,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";

const INPUT =
  "rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const PRIMARY =
  "rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white transition-colors disabled:opacity-50";
const SECONDARY =
  "rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong";

/** The status names, translated. Literal `gt` calls so the extractor sees each one. */
export function useSavingsStatusLabel(): (status: SavingsFindingStatus) => string {
  const gt = useGT();
  return (status) => {
    switch (status) {
      case "ready":
        return gt("Ready for review");
      case "in_progress":
        return gt("In progress");
      case "completed":
        return gt("Completed");
      case "archived":
        return gt("Archived");
    }
  };
}

/**
 * Confirm a status change for one or many findings, with an optional note.
 * The note is recorded on every finding changed and shown beside its status.
 */
export function SavingsStatusModal({
  count,
  status,
  onSave,
  onClose,
}: {
  count: number;
  status: SavingsFindingStatus;
  onSave: (note: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const gt = useGT();
  const statusLabel = useSavingsStatusLabel();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(note.trim() === "" ? null : note.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const title = gt("Move {count} finding(s) to {status}", { count, status: statusLabel(status) });
  return (
    <Modal onClose={onClose} ariaLabel={title}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[460px] max-w-full p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">{title}</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {status === "archived"
            ? gt(
                "Archived findings leave the open list and stop counting as potential savings for everyone in the organization.",
              )
            : status === "completed"
              ? gt(
                  "Completed by hand. Findings a scan stops reporting are completed automatically.",
                )
              : gt("Everyone in the organization sees the new status, who set it and the note.")}
        </p>
        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-on-surface-secondary">{gt("Note (optional)")}</span>
          <textarea
            ref={ref}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={SAVINGS_FINDING_LIMITS.maxNoteLength}
            placeholder={gt("Why, or what happens next")}
            className={INPUT}
          />
        </label>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={SECONDARY}>
            {gt("Cancel")}
          </button>
          <button type="button" disabled={busy} onClick={() => void save()} className={PRIMARY}>
            {busy ? gt("Saving…") : gt("Change status")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Name (and describe) a saved view. Used for both create and rename. */
export function SavingsViewModal({
  initialName,
  initialDescription,
  editing,
  onSave,
  onClose,
}: {
  initialName: string;
  initialDescription: string;
  /** Updating an existing view rather than creating one. */
  editing: boolean;
  onSave: (name: string, description: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const gt = useGT();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim(), description.trim() === "" ? null : description.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const title = editing ? gt("Update saved view") : gt("Save view");
  return (
    <Modal onClose={onClose} ariaLabel={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== "") void save();
        }}
        className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[460px] max-w-full p-6 flex flex-col gap-3"
      >
        <h2 className="text-base font-semibold text-on-surface">{title}</h2>
        <p className="text-xs text-on-surface-faint">
          {gt(
            "A view keeps the current status tab, filters and sort. Share it from the Share button once saved.",
          )}
        </p>
        {error !== null && (
          <div role="alert" className="text-sm text-danger">
            {error}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-on-surface-secondary">{gt("Name")}</span>
          <input
            ref={ref}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={SAVINGS_VIEW_LIMITS.maxNameLength}
            placeholder={gt("Big waste in production")}
            className={INPUT}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-on-surface-secondary">{gt("Description (optional)")}</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={SAVINGS_VIEW_LIMITS.maxDescriptionLength}
            className={INPUT}
          />
        </label>
        <div className="mt-2 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={SECONDARY}>
            {gt("Cancel")}
          </button>
          <button type="submit" disabled={busy || name.trim() === ""} className={PRIMARY}>
            {busy ? gt("Saving…") : editing ? gt("Update view") : gt("Save view")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
