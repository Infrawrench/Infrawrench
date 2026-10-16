import { useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  COST_RANGE_PRESETS,
  COST_RANGE_PRESET_LABELS,
  RESOURCE_REPORT_CORE_FIELDS,
  RESOURCE_REPORT_COST_WINDOWS,
  RESOURCE_REPORT_LIMITS,
  resourceReportColumnId,
  resourceReportConfigError,
  type CostBasis,
  type CostDateRange,
  type ResourceReportConfig,
  type ResourceReportOptions,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import { CostBasisField } from "../cost/CostGraphConfigModal.js";
import { labelClass, selectClass } from "../cost/form-styles.js";
import { useColumnLabel } from "./labels.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";

interface AvailableGroup {
  key: string;
  title: string;
  ids: string[];
  note?: string | undefined;
}

/**
 * Pick and order a report's columns, and set the window its cost columns
 * cover. The available list is the org's own data: the metadata fields the
 * selected resource types expose, the tag keys synced resources carry, the
 * org's virtual tags. Nothing here is a hardcoded field list.
 */
export function ResourceReportColumnsModal({
  config,
  options,
  fieldLabels,
  onApply,
  onClose,
}: {
  config: ResourceReportConfig;
  options: ResourceReportOptions | null;
  fieldLabels: ReadonlyMap<string, string>;
  onApply: (next: ResourceReportConfig) => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const columnLabel = useColumnLabel(fieldLabels);
  const searchId = useId();
  const customId = useId();
  const rangeId = useId();
  const basisId = useId();
  const [columns, setColumns] = useState<string[]>(config.columns);
  const [costRange, setCostRange] = useState<CostDateRange>(config.costRange);
  const [costBasis, setCostBasis] = useState<CostBasis>(config.costBasis);
  const [search, setSearch] = useState("");
  const [customTag, setCustomTag] = useState("");

  const costAvailable = options?.costAvailable ?? false;
  const groups = useMemo<AvailableGroup[]>(() => {
    const out: AvailableGroup[] = [
      {
        key: "core",
        title: gt("Resource"),
        ids: RESOURCE_REPORT_CORE_FIELDS.map((f) => resourceReportColumnId("core", f)),
      },
      {
        key: "cost",
        title: gt("Cost"),
        ids: RESOURCE_REPORT_COST_WINDOWS.map((w) => resourceReportColumnId("cost", w)),
        note: costAvailable
          ? undefined
          : gt("Cost columns stay empty without access to cost data."),
      },
      {
        key: "field",
        title: gt("Metadata"),
        ids: (options?.fields ?? []).map((f) => resourceReportColumnId("field", f.key)),
      },
      {
        key: "tag",
        title: gt("Tags"),
        ids: (options?.tagKeys ?? []).map((k) => resourceReportColumnId("tag", k)),
      },
    ];
    if ((options?.virtualTagKeys ?? []).length > 0) {
      out.push({
        key: "vtag",
        title: gt("Virtual tags"),
        ids: options!.virtualTagKeys.map((k) => resourceReportColumnId("vtag", k)),
        note: gt("A resource's value is the one its own spend carries over the cost range."),
      });
    }
    return out;
  }, [gt, options, costAvailable]);

  const q = search.trim().toLowerCase();
  const shown = new Set(columns);
  const full = columns.length >= RESOURCE_REPORT_LIMITS.maxColumns;
  const draft: ResourceReportConfig = { ...config, columns, costRange, costBasis };
  const problem = resourceReportConfigError(draft);

  function add(id: string) {
    if (shown.has(id) || full) return;
    setColumns([...columns, id]);
  }
  function move(index: number, delta: number) {
    const next = [...columns];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setColumns(next);
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Columns")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[760px] max-w-[95vw] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">{gt("Columns")}</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {gt(
            "Add columns from the left; order them on the right. The first column links to the resource.",
          )}
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="min-w-0">
            <label htmlFor={searchId} className={labelClass}>
              {gt("Available")}
            </label>
            <input
              id={searchId}
              className={inputClass}
              value={search}
              placeholder={gt("Search columns")}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="mt-2 h-80 overflow-y-auto rounded-lg border border-border">
              {groups.map((group) => {
                const ids = group.ids.filter(
                  (id) => !q || columnLabel(id).toLowerCase().includes(q) || id.includes(q),
                );
                if (ids.length === 0) return null;
                return (
                  <section key={group.key} aria-label={group.title}>
                    <h3 className="sticky top-0 bg-surface-raised px-2 py-1 text-xs font-semibold uppercase tracking-wide text-on-surface-faint">
                      {group.title}
                    </h3>
                    {group.note && (
                      <p className="px-2 pb-1 text-xs text-on-surface-faint">{group.note}</p>
                    )}
                    <ul>
                      {ids.map((id) => (
                        <li key={id}>
                          <button
                            type="button"
                            disabled={shown.has(id) || full}
                            onClick={() => add(id)}
                            className="w-full truncate px-2 py-1 text-left text-sm text-on-surface hover:bg-surface-sunken disabled:text-on-surface-faint disabled:hover:bg-transparent"
                          >
                            {shown.has(id) ? "✓ " : "+ "}
                            {columnLabel(id)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
            <div className="mt-2 flex gap-2">
              <label htmlFor={customId} className="sr-only">
                {gt("Tag key")}
              </label>
              <input
                id={customId}
                className={inputClass}
                value={customTag}
                placeholder={gt("Another tag key")}
                onChange={(e) => setCustomTag(e.target.value)}
              />
              <button
                type="button"
                className="shrink-0 rounded-lg border border-border px-3 text-sm text-on-surface-secondary hover:text-on-surface disabled:opacity-50"
                disabled={!customTag.trim() || full}
                onClick={() => {
                  add(resourceReportColumnId("tag", customTag.trim()));
                  setCustomTag("");
                }}
              >
                {gt("Add")}
              </button>
            </div>
          </div>
          <div className="min-w-0">
            <p className={labelClass}>
              {gt("Shown ({count} of {max})", {
                count: columns.length,
                max: RESOURCE_REPORT_LIMITS.maxColumns,
              })}
            </p>
            <ol className="h-80 overflow-y-auto rounded-lg border border-border">
              {columns.map((id, i) => (
                <li
                  key={id}
                  className="flex items-center gap-1 border-b border-border px-2 py-1 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-on-surface">
                    {columnLabel(id)}
                  </span>
                  <button
                    type="button"
                    className="rounded px-1 text-on-surface-faint hover:text-on-surface disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label={gt("Move {column} up", { column: columnLabel(id) })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="rounded px-1 text-on-surface-faint hover:text-on-surface disabled:opacity-30"
                    disabled={i === columns.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={gt("Move {column} down", { column: columnLabel(id) })}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="rounded px-1 text-on-surface-faint hover:text-danger"
                    onClick={() => setColumns(columns.filter((c) => c !== id))}
                    aria-label={gt("Remove {column}", { column: columnLabel(id) })}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <label htmlFor={rangeId} className={labelClass}>
              {gt("Accrued cost over")}
            </label>
            <select
              id={rangeId}
              className={selectClass}
              value={costRange.kind === "relative" ? costRange.preset : "absolute"}
              onChange={(e) => {
                const v = e.target.value;
                if (v !== "absolute") {
                  setCostRange({
                    kind: "relative",
                    preset: v as (typeof COST_RANGE_PRESETS)[number],
                  });
                }
              }}
            >
              {COST_RANGE_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {gtData(COST_RANGE_PRESET_LABELS[p])}
                </option>
              ))}
              {costRange.kind === "absolute" && (
                <option value="absolute">
                  {gt("{from} to {to}", { from: costRange.from, to: costRange.to })}
                </option>
              )}
            </select>
            <p className="mt-1 text-xs text-on-surface-faint">
              {gt("Month to date and previous month are always calendar months.")}
            </p>
          </div>
          <CostBasisField
            id={basisId}
            value={costBasis}
            onChange={setCostBasis}
            available={costAvailable}
            blendingAvailable={costBasis === "blended"}
            hint={gt("Needs access to cost data.")}
          />
        </div>

        {problem && <p className="mt-3 text-sm text-danger">{problem}</p>}
        <div className="mt-5 flex justify-end gap-2">
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
