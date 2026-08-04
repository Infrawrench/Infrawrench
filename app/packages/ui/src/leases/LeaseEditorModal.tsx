import { useState } from "react";
import { validateLeaseInput } from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import type { LeasesClient, ResourceLease } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

/** The resource the editor attaches a lease to. */
export interface LeaseEditorTarget {
  resourceId: string;
  accountId: string;
  resourceName: string;
}

export interface LeaseEditorModalProps {
  client: LeasesClient;
  target: LeaseEditorTarget;
  /** Existing (active) lease to edit, or null to create one. */
  existing: ResourceLease | null;
  onSaved: (lease: ResourceLease) => void;
  onClose: () => void;
}

const DAY_MS = 86_400_000;

/** Quick presets, in days; "custom" opens the datetime field. */
const PRESETS: Array<{ label: string; days: number }> = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "30 days", days: 30 },
];

/** Epoch ms → the value a `datetime-local` input wants (local wall time). */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The lease editor: quick duration presets or a custom deadline, an optional
 * note, and the auto-delete opt-in with its warning copy spelled out.
 */
export function LeaseEditorModal({
  client,
  target,
  existing,
  onSaved,
  onClose,
}: LeaseEditorModalProps) {
  const [expiresLocal, setExpiresLocal] = useState<string>(() =>
    toLocalInputValue(existing ? Date.parse(existing.expiresAt) : Date.now() + 3 * DAY_MS),
  );
  const [note, setNote] = useState(existing?.note ?? "");
  const [autoDelete, setAutoDelete] = useState(existing?.autoDelete ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expiresMs = Date.parse(expiresLocal);
  const expiresIso = Number.isNaN(expiresMs) ? "" : new Date(expiresMs).toISOString();
  const inputProblem = validateLeaseInput({ expiresAt: expiresIso, note });

  const applyPreset = (days: number) => {
    setExpiresLocal(toLocalInputValue(Date.now() + days * DAY_MS));
  };

  const save = async () => {
    if (inputProblem) {
      setError(inputProblem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const trimmedNote = note.trim();
      const saved = existing
        ? await client.updateLease(existing.id, {
            expiresAt: expiresIso,
            autoDelete,
            note: trimmedNote === "" ? null : trimmedNote,
          })
        : await client.createLease({
            resourceId: target.resourceId,
            accountId: target.accountId,
            expiresAt: expiresIso,
            autoDelete,
            ...(trimmedNote !== "" ? { note: trimmedNote } : {}),
          });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save lease");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} ariaLabel={existing ? "Edit lease" : "New lease"}>
      <div className="w-[28rem] max-w-[90vw] rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">
          {existing ? "Edit lease" : "New lease"}
        </h2>
        <p className="mt-1 text-xs text-on-surface-secondary">
          {target.resourceName} gets an expiry date and shows up on the Expiring radar as the
          deadline approaches.
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <div>
            <span className={labelClass}>Lease length</span>
            <div className="flex gap-1" role="group" aria-label="Lease length presets">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => applyPreset(preset.days)}
                  className="flex-1 rounded-lg border border-border bg-surface-sunken px-1 py-1.5 text-xs text-on-surface-tertiary hover:border-border-strong hover:text-on-surface"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="lease-expires-at">
              Expires at
            </label>
            <input
              id="lease-expires-at"
              type="datetime-local"
              className={inputClass}
              value={expiresLocal}
              onChange={(e) => setExpiresLocal(e.target.value)}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="lease-note">
              Note <span className="font-normal text-on-surface-faint">(why / who for)</span>
            </label>
            <input
              id="lease-note"
              type="text"
              className={inputClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Load-test cluster for the Q3 launch"
            />
          </div>

          <label className="flex items-start gap-2 rounded-xl border border-border bg-surface-sunken px-3 py-2.5 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={autoDelete}
              onChange={(e) => setAutoDelete(e.target.checked)}
            />
            <span>
              <span className="font-medium text-on-surface">Auto-delete at expiry</span>
              <span className="mt-0.5 block text-on-surface-secondary">
                The resource will be deleted when the lease expires. You&apos;ll be warned twice
                first. Freezes pause deletion.
              </span>
            </span>
          </label>

          {error !== null && (
            <div role="alert" className="text-sm text-red-500">
              {error}
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || inputProblem !== null}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? "Saving…" : existing ? "Save changes" : "Create lease"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
