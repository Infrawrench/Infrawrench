import { useEffect, useId, useState } from "react";
import { useGT } from "gt-react";
import { SERVICE_LIMITS } from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import {
  errorMessage,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "./shared.js";
import type { ServiceResourceOption, ServicesClient } from "./types.js";

export interface AddResourcesModalProps {
  client: ServicesClient;
  /** Resources already in the service; offered greyed out. */
  memberIds: ReadonlySet<string>;
  onAdd: (resourceIds: string[]) => Promise<void>;
  onClose: () => void;
}

/**
 * Pick resources to add to a service by hand. Searches the same index the
 * spotlight uses (name, account, provider and type), across every account,
 * and keeps the picks while the query changes so a service spanning three
 * providers is one dialog, not three.
 */
export function AddResourcesModal({ client, memberIds, onAdd, onClose }: AddResourcesModalProps) {
  const gt = useGT();
  const dataString = useDataString();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ServiceResourceOption[] | null>(null);
  const [picked, setPicked] = useState<Map<string, ServiceResourceOption>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResults(null);
    const timer = setTimeout(() => {
      client.searchResources(query.trim()).then(
        (rows) => {
          if (!cancelled) setResults(rows);
        },
        (e) => {
          if (!cancelled) {
            setResults([]);
            setError(errorMessage(e, gt("Search failed")));
          }
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, query, gt]);

  const toggle = (row: ServiceResourceOption) => {
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
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

  const describe = (row: ServiceResourceOption) =>
    [
      row.pluginDisplayName ?? row.pluginId,
      row.resourceTypeLabel ? dataString(row.resourceTypeLabel) : row.resourceTypeId,
      row.accountName,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <Modal onClose={() => (saving ? undefined : onClose())} ariaLabel={gt("Add resources")}>
      <div className="w-[36rem] max-w-[94vw] max-h-[90vh] flex flex-col rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">{gt("Add resources")}</h2>
        <p className="mt-1 text-xs text-on-surface-secondary">
          {gt(
            "Hand-picked members stay until you remove them, whatever the membership rules say.",
          )}
        </p>
        <div className="mt-3">
          <label className={labelClass} htmlFor={searchId}>
            {gt("Search resources")}
          </label>
          <input
            id={searchId}
            type="search"
            className={inputClass}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={gt("Name, account, provider or type")}
          />
        </div>
        {picked.size > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[...picked.values()].map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => toggle(row)}
                className="rounded-full border border-border bg-surface-raised px-2 py-0.5 text-xs text-on-surface hover:border-border-strong"
                aria-label={gt("Remove {name} from the selection", { name: row.displayName })}
              >
                {row.displayName} ×
              </button>
            ))}
          </div>
        )}
        <div className="mt-2 min-h-[10rem] flex-1 overflow-y-auto rounded-lg border border-border">
          {results === null ? (
            <p role="status" className="p-3 text-sm text-on-surface-faint">
              {gt("Searching…")}
            </p>
          ) : results.length === 0 ? (
            <p role="status" className="p-3 text-sm text-on-surface-faint">
              {gt("No resources match.")}
            </p>
          ) : (
            <ul>
              {results.map((row) => {
                const already = memberIds.has(row.id);
                return (
                  <li key={row.id} className="border-b border-border last:border-b-0">
                    <label
                      className={`flex items-start gap-2 px-3 py-2 text-sm ${already ? "opacity-60" : "hover:bg-surface-sunken cursor-pointer"}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        disabled={already}
                        checked={already || picked.has(row.id)}
                        onChange={() => toggle(row)}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-on-surface">{row.displayName}</span>
                        <span className="block truncate text-xs text-on-surface-faint">
                          {already
                            ? gt("{details} · already a member", { details: describe(row) })
                            : describe(row)}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {results !== null && results.length >= 50 && (
          <p className="mt-1 text-xs text-on-surface-faint">
            {gt("Showing the first 50 matches; refine the search to find more.")}
          </p>
        )}
        {error && (
          <div role="alert" className="mt-2 text-sm text-danger">
            {error}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className={secondaryButtonClass}>
            {gt("Cancel")}
          </button>
          <button
            type="button"
            onClick={() => void add()}
            disabled={saving || picked.size === 0 || picked.size > SERVICE_LIMITS.maxMembersPerRequest}
            className={primaryButtonClass}
          >
            {saving
              ? gt("Adding…")
              : gt("Add {count} resources", {
                  count: picked.size,
                })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
