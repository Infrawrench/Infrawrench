import { useState } from "react";
import { useGT } from "gt-react";
import { SERVICE_LIMITS } from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { CloseIcon } from "../components/icons/ChromeIcons.js";
import { ResourcePicker, type PickerRowState } from "./ResourcePicker.js";
import { errorMessage, primaryButtonClass, secondaryButtonClass } from "./shared.js";
import type { ServiceResourceOption, ServicesClient } from "./types.js";

export interface AddResourcesModalProps {
  client: ServicesClient;
  /** Resources already in the service; offered ticked and locked. */
  memberIds: ReadonlySet<string>;
  onAdd: (resourceIds: string[]) => Promise<void>;
  onClose: () => void;
}

/**
 * Pick resources to add to a service by hand, from the service page. The
 * same picker the service editor shows: a fuzzy search across every account,
 * a provider filter, and picks that survive a new query, so a service
 * spanning three providers is one dialog, not three.
 */
export function AddResourcesModal({ client, memberIds, onAdd, onClose }: AddResourcesModalProps) {
  const gt = useGT();
  const [picked, setPicked] = useState<ReadonlyMap<string, ServiceResourceOption>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stateOf = (row: ServiceResourceOption): PickerRowState =>
    memberIds.has(row.id)
      ? { checked: true, lockedReason: gt("Already a member") }
      : picked.has(row.id)
        ? { checked: true, badge: { text: gt("New"), tone: "accent" } }
        : { checked: false };

  const toggle = (row: ServiceResourceOption) => {
    if (memberIds.has(row.id)) return;
    setPicked((prev) => {
      const next = new Map(prev);
      if (!next.delete(row.id)) next.set(row.id, row);
      return next;
    });
  };

  const selectMany = (rows: ServiceResourceOption[]) => {
    setPicked((prev) => {
      const next = new Map(prev);
      for (const row of rows) if (!memberIds.has(row.id)) next.set(row.id, row);
      return next;
    });
  };

  const add = async () => {
    if (picked.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd([...picked.keys()]);
      onClose();
    } catch (e) {
      setError(errorMessage(e, gt("Failed to add the resources")));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    if (!saving) onClose();
  };

  return (
    <Modal onClose={dismiss} ariaLabel={gt("Add resources")}>
      <div className="flex h-[min(42rem,90vh)] w-[44rem] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl">
        <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
          <h2 className="flex-1 text-sm font-semibold text-on-surface">{gt("Add resources")}</h2>
          <button
            type="button"
            onClick={dismiss}
            disabled={saving}
            className="rounded-lg p-1.5 text-on-surface-faint hover:bg-surface-sunken hover:text-on-surface"
            aria-label={gt("Close")}
          >
            <CloseIcon size={16} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col p-5">
          <ResourcePicker
            client={client}
            stateOf={stateOf}
            onToggle={toggle}
            onSelectMany={selectMany}
            autoFocus
          />
        </div>
        <footer className="flex items-center gap-3 border-t border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : picked.size > SERVICE_LIMITS.maxMembersPerRequest ? (
              <p className="text-xs text-warning">
                {gt("Add at most {max} resources at a time.", {
                  max: SERVICE_LIMITS.maxMembersPerRequest,
                })}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={saving}
            className={secondaryButtonClass}
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            onClick={() => void add()}
            disabled={
              saving || picked.size === 0 || picked.size > SERVICE_LIMITS.maxMembersPerRequest
            }
            className={primaryButtonClass}
          >
            {saving
              ? gt("Adding…")
              : gt("Add {count} resources", {
                  count: picked.size,
                })}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
