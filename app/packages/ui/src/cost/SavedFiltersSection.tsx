import { useCallback, useEffect, useId, useState } from "react";

import { Modal } from "../components/Modal.js";
import { CostFilterEditor } from "./CostGraphConfigModal.js";
import {
  describeSavedCostFilterReferents,
  type CostFilter,
  type SavedCostFilter,
  type SavedCostFilterInput,
  type SavedCostFilterReferent,
} from "./config.js";
import type { CostsClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

/**
 * Saved filters — the org's named, reusable cost filter sets.
 *
 * Lives on the Costs panel rather than in Settings because a saved filter is a
 * cost object, not a preference: it scopes the budgets listed just above this
 * section, and editing one here re-scopes every graph, report and budget
 * referencing it. That leverage is why the edit modal names the referents
 * before anything is saved, and why Delete surfaces the server's refusal (a
 * 409 listing referents) instead of pretending the operation is local.
 */
export function SavedFiltersSection({ client }: { client: CostsClient }) {
  const [filters, setFilters] = useState<SavedCostFilter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ filter: SavedCostFilter | null } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const canWrite = Boolean(
    client.createSavedFilter && client.updateSavedFilter && client.deleteSavedFilter,
  );

  const refresh = useCallback(async () => {
    try {
      setFilters((await client.listSavedFilters?.()) ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function deleteFilter(filter: SavedCostFilter) {
    if (!window.confirm(`Delete the saved filter "${filter.name}"?`)) return;
    setRowError(null);
    try {
      await client.deleteSavedFilter?.(filter.id);
      await refresh();
    } catch (e: unknown) {
      // The interesting failure is the deliberate one: the server refuses while
      // budgets, reports or dashboard graphs still reference the filter, and
      // its message names them. Show it on the row it belongs to.
      setRowError({
        id: filter.id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">Saved filters</h2>
          <p className="text-xs text-on-surface-faint mt-0.5">
            A named filter that graphs, reports and budgets apply by reference — edit it once and
            everything using it changes.
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setEditing({ filter: null })}
            className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            New filter
          </button>
        )}
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-red-500">
          Couldn&rsquo;t load saved filters — {error}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            Retry
          </button>
        </div>
      )}

      {filters === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Loading saved filters…
        </p>
      )}

      {filters?.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          No saved filters yet. Build filter rows in any cost editor and choose &ldquo;Save these
          rows as a filter&rdquo;, or create one here.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {(filters ?? []).map((filter) => (
          <li
            key={filter.id}
            className="rounded-xl border border-border bg-surface-raised px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium text-on-surface">
                  {filter.name}
                </span>
                {filter.description && (
                  <span className="block truncate text-xs text-on-surface-faint mt-0.5">
                    {filter.description}
                  </span>
                )}
                <code className="mt-1 block truncate text-xs text-on-surface-secondary font-mono">
                  {filter.query}
                </code>
              </div>
              {canWrite && (
                <div className="flex shrink-0 items-center gap-2 text-xs text-on-surface-faint">
                  <button
                    type="button"
                    onClick={() => setEditing({ filter })}
                    className="hover:text-on-surface-secondary underline"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteFilter(filter)}
                    className="hover:text-red-500 underline"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
            {rowError?.id === filter.id && (
              <p role="alert" className="mt-1.5 text-xs text-red-400">
                {rowError.message}
              </p>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <SavedFilterEditModal
          filter={editing.filter}
          client={client}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

/**
 * Create/edit one saved filter. On edit, the referents are loaded and named up
 * front: saving here re-scopes every one of them on their next query, and that
 * should be stated where the Save button is, not discovered afterwards.
 */
function SavedFilterEditModal({
  filter,
  client,
  onClose,
  onSaved,
}: {
  filter: SavedCostFilter | null;
  client: CostsClient;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const uid = useId();
  const [name, setName] = useState(filter?.name ?? "");
  const [description, setDescription] = useState(filter?.description ?? "");
  const [rows, setRows] = useState<CostFilter[]>(filter?.filters ?? []);
  const [referents, setReferents] = useState<SavedCostFilterReferent[] | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!filter) return;
    let cancelled = false;
    void client
      .getSavedFilterReferents?.(filter.id)
      .then((rows) => {
        if (!cancelled) setReferents(rows);
      })
      .catch(() => {
        // Advisory only — the edit still works; the caveat is just unnamed.
        if (!cancelled) setReferents(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, filter]);

  const save = async () => {
    if (filterError) {
      setError("Fix the filter query before saving.");
      return;
    }
    const input: SavedCostFilterInput = {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      filters: rows.filter((f) => f.values.length > 0),
    };
    if (!input.name) {
      setError("A saved filter needs a name.");
      return;
    }
    if (input.filters.length === 0) {
      setError("Add at least one filter row — an empty filter matches everything.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (filter) await client.updateSavedFilter?.(filter.id, input);
      else await client.createSavedFilter?.(input);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} ariaLabel={filter ? `Edit ${filter.name}` : "New saved filter"}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[560px] max-w-full p-6 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {filter ? "Edit saved filter" : "New saved filter"}
        </h2>
        {filter && referents !== null && referents.length > 0 && (
          <p className="text-xs text-amber-500 mb-3">
            Saving changes {describeSavedCostFilterReferents(referents)} — everything referencing
            this filter runs the new rows on its next query.
          </p>
        )}

        <div className="space-y-4">
          <div>
            <label htmlFor={`${uid}-name`} className={labelClass}>
              Name
            </label>
            <input
              id={`${uid}-name`}
              className={inputClass}
              placeholder="e.g. Prod only"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-description`} className={labelClass}>
              Description (optional)
            </label>
            <input
              id={`${uid}-description`}
              className={inputClass}
              placeholder="What this filter scopes to"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div role="group" aria-labelledby={`${uid}-rows-label`}>
            <span id={`${uid}-rows-label`} className={labelClass}>
              Filter
            </span>
            {/* No savedFilterId props on purpose: a saved filter referencing
                another saved filter would make resolution recursive for no
                expressible gain — AND-composition already covers the use. */}
            <CostFilterEditor
              filters={rows}
              onChange={setRows}
              api={client}
              onErrorChange={setFilterError}
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-sm text-on-surface-secondary hover:bg-surface-sunken transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || filterError !== null}
              className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
