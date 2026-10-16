import { useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  EMPTY_RESOURCE_REPORT_FILTERS,
  RESOURCE_REPORT_LIMITS,
  RESOURCE_REPORT_TAG_OPS,
  resourceReportConfigError,
  type ResourceReportConfig,
  type ResourceReportFilters,
  type ResourceReportOptions,
  type ResourceReportTagFilter,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { MultiSelect, type MultiSelectStatus } from "../components/MultiSelect.js";
import { labelClass, selectClass } from "../cost/form-styles.js";
import { useDataString } from "../i18n/data-strings.js";
import { tagOpLabel } from "./labels.js";
import type { ResourceReportsClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";

/** `pluginId/resourceTypeId`, the MultiSelect value for a type. */
function typeValue(t: { pluginId: string; resourceTypeId: string }): string {
  return `${t.pluginId}/${t.resourceTypeId}`;
}

function TagConditionRow({
  client,
  filter,
  options,
  onChange,
  onRemove,
}: {
  client: ResourceReportsClient;
  filter: ResourceReportTagFilter;
  options: ResourceReportOptions | null;
  onChange: (next: ResourceReportTagFilter) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const keyId = useId();
  const listId = useId();
  const [values, setValues] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const needsValues = filter.op === "in" || filter.op === "not_in";
  const keys = filter.source === "tag" ? (options?.tagKeys ?? []) : (options?.virtualTagKeys ?? []);

  useEffect(() => {
    if (!needsValues || !filter.key.trim()) {
      setValues(null);
      return;
    }
    let live = true;
    setValues(null);
    setError(null);
    const timer = setTimeout(() => {
      client
        .getTagValues(filter.source, filter.key.trim())
        .then((v) => live && setValues(v))
        .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, filter.source, filter.key, needsValues]);

  const status: MultiSelectStatus | undefined = error
    ? { kind: "error", message: error }
    : values === null
      ? { kind: "loading" }
      : values.length === 0
        ? { kind: "empty", message: gt("No values seen for this key yet.") }
        : undefined;
  // Keep a saved value the current list no longer offers, so editing never
  // silently drops part of a condition.
  const valueOptions = [...new Set([...(values ?? []), ...filter.values])].map((v) => ({
    value: v,
    label: v,
  }));

  return (
    <li className="rounded-lg border border-border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={`${selectClass} !w-auto`}
          value={filter.source}
          aria-label={gt("Tag source")}
          onChange={(e) =>
            onChange({
              ...filter,
              source: e.target.value as ResourceReportTagFilter["source"],
              key: "",
              values: [],
            })
          }
        >
          <option value="tag">{gt("Tag")}</option>
          {(options?.virtualTagKeys ?? []).length > 0 && (
            <option value="virtual_tag">{gt("Virtual tag")}</option>
          )}
        </select>
        <label htmlFor={keyId} className="sr-only">
          {gt("Tag key")}
        </label>
        <input
          id={keyId}
          list={listId}
          className={`${inputClass} !w-48`}
          value={filter.key}
          placeholder={gt("Key")}
          onChange={(e) => onChange({ ...filter, key: e.target.value, values: [] })}
        />
        <datalist id={listId}>
          {keys.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <select
          className={`${selectClass} !w-auto`}
          value={filter.op}
          aria-label={gt("Condition")}
          onChange={(e) => {
            const op = e.target.value as ResourceReportTagFilter["op"];
            onChange({
              ...filter,
              op,
              values: op === "in" || op === "not_in" ? filter.values : [],
            });
          }}
        >
          {RESOURCE_REPORT_TAG_OPS.map((op) => (
            <option key={op} value={op}>
              {tagOpLabel(op, gt)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto text-xs text-on-surface-faint hover:text-danger"
        >
          {gt("Remove")}
        </button>
      </div>
      {needsValues && (
        <MultiSelect
          className="mt-2"
          label={gt("Values")}
          placeholder={gt("Pick values")}
          options={valueOptions}
          value={filter.values}
          status={valueOptions.length > 0 ? undefined : status}
          onChange={(v) => onChange({ ...filter, values: v })}
        />
      )}
    </li>
  );
}

/**
 * Edit what a report selects. Every picker is filled from the org's own
 * synced inventory (with resource counts in the options call), so nobody
 * types an account id or a region code.
 */
export function ResourceReportFiltersModal({
  client,
  config,
  options,
  onApply,
  onClose,
}: {
  client: ResourceReportsClient;
  config: ResourceReportConfig;
  options: ResourceReportOptions | null;
  onApply: (next: ResourceReportConfig) => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const nameId = useId();
  const fromId = useId();
  const toId = useId();
  const [filters, setFilters] = useState<ResourceReportFilters>(config.filters);
  const set = (patch: Partial<ResourceReportFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const loading: MultiSelectStatus | undefined = options ? undefined : { kind: "loading" };

  const providerOptions = useMemo(
    () =>
      (options?.providers ?? []).map((p) => ({
        value: p.value,
        label: `${gtData(p.label)} (${p.count})`,
      })),
    [options, gtData],
  );
  const inProviders = (pluginId: string) =>
    filters.pluginIds.length === 0 || filters.pluginIds.includes(pluginId);
  const accountOptions = (options?.accounts ?? [])
    .filter((a) => inProviders(a.pluginId))
    .map((a) => ({ value: a.value, label: `${a.label} (${a.count})` }));
  const typeOptions = (options?.resourceTypes ?? [])
    .filter((t) => inProviders(t.pluginId))
    .map((t) => ({ value: typeValue(t), label: `${gtData(t.label)} (${t.count})` }));
  const regionOptions = (options?.regions ?? []).map((r) => ({
    value: r.value,
    label: `${r.label} (${r.count})`,
  }));
  const statusOptions = (options?.statuses ?? []).map((s) => ({
    value: s.value,
    label: `${s.label} (${s.count})`,
  }));

  const draft: ResourceReportConfig = { ...config, filters };
  const problem = resourceReportConfigError(draft);

  return (
    <Modal onClose={onClose} ariaLabel={gt("Filters")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[640px] max-w-[95vw] max-h-[90vh] overflow-y-auto p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">{gt("Filters")}</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {gt(
            "A resource is in the report when it matches every filter you set. An empty filter matches everything.",
          )}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className={labelClass}>{gt("Providers")}</p>
            <MultiSelect
              label={gt("Providers")}
              options={providerOptions}
              value={filters.pluginIds}
              status={loading}
              onChange={(v) => set({ pluginIds: v })}
            />
          </div>
          <div>
            <p className={labelClass}>{gt("Accounts")}</p>
            <MultiSelect
              label={gt("Accounts")}
              options={accountOptions}
              value={filters.accountIds}
              status={loading}
              onChange={(v) => set({ accountIds: v })}
            />
          </div>
          <div className="col-span-2">
            <p className={labelClass}>{gt("Resource types")}</p>
            <MultiSelect
              label={gt("Resource types")}
              options={typeOptions}
              value={filters.resourceTypes.map(typeValue)}
              status={loading}
              onChange={(v) =>
                set({
                  resourceTypes: v.flatMap((s) => {
                    const idx = s.indexOf("/");
                    return idx > 0
                      ? [{ pluginId: s.slice(0, idx), resourceTypeId: s.slice(idx + 1) }]
                      : [];
                  }),
                })
              }
            />
          </div>
          <div>
            <p className={labelClass}>{gt("Regions")}</p>
            <MultiSelect
              label={gt("Regions")}
              options={regionOptions}
              value={filters.regions}
              status={loading}
              onChange={(v) => set({ regions: v })}
            />
          </div>
          <div>
            <p className={labelClass}>{gt("Statuses")}</p>
            <MultiSelect
              label={gt("Statuses")}
              options={statusOptions}
              value={filters.statuses}
              status={loading}
              onChange={(v) => set({ statuses: v })}
            />
          </div>
          <div className="col-span-2">
            <label htmlFor={nameId} className={labelClass}>
              {gt("Name contains")}
            </label>
            <input
              id={nameId}
              className={inputClass}
              value={filters.nameContains ?? ""}
              maxLength={RESOURCE_REPORT_LIMITS.maxNameContainsLength}
              onChange={(e) => set({ nameContains: e.target.value || null })}
            />
          </div>
          <div>
            <label htmlFor={fromId} className={labelClass}>
              {gt("Created on or after")}
            </label>
            <input
              id={fromId}
              type="date"
              className={inputClass}
              value={filters.createdFrom ?? ""}
              onChange={(e) => set({ createdFrom: e.target.value || null })}
            />
          </div>
          <div>
            <label htmlFor={toId} className={labelClass}>
              {gt("Created on or before")}
            </label>
            <input
              id={toId}
              type="date"
              className={inputClass}
              value={filters.createdTo ?? ""}
              onChange={(e) => set({ createdTo: e.target.value || null })}
            />
          </div>
        </div>
        <p className="mt-1 text-xs text-on-surface-faint">
          {gt(
            "Created is the provider's creation time when the resource reports one, otherwise when it was first synced.",
          )}
        </p>

        <div className="mt-4">
          <p className={labelClass}>{gt("Tags")}</p>
          <ul className="space-y-2">
            {filters.tags.map((t, i) => (
              <TagConditionRow
                // Conditions have no id; position is their identity while editing.
                key={i}
                client={client}
                filter={t}
                options={options}
                onChange={(next) => set({ tags: filters.tags.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => set({ tags: filters.tags.filter((_, j) => j !== i) })}
              />
            ))}
          </ul>
          <button
            type="button"
            disabled={filters.tags.length >= RESOURCE_REPORT_LIMITS.maxTagFilters}
            onClick={() =>
              set({ tags: [...filters.tags, { source: "tag", key: "", op: "in", values: [] }] })
            }
            className="mt-2 text-sm text-info hover:underline disabled:opacity-50"
          >
            {gt("Add tag condition")}
          </button>
        </div>

        {problem && <p className="mt-3 text-sm text-danger">{problem}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setFilters(EMPTY_RESOURCE_REPORT_FILTERS)}
            className="mr-auto rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface"
          >
            {gt("Clear all")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={problem !== null}
            onClick={() => onApply(draft)}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {gt("Apply")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
