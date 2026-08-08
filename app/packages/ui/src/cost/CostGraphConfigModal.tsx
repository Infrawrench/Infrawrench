import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  COST_BASES,
  COST_BASIS_LABELS,
  COST_BINNING_LABELS as BINNING_LABELS,
  COST_BINNINGS,
  COST_CHART_TYPE_LABELS as CHART_TYPE_LABELS,
  COST_CHART_TYPES,
  COST_DIMENSION_LABELS,
  COST_DIMENSIONS,
  COST_QUERY_MAX_LENGTH,
  COST_RANGE_PRESET_LABELS as PRESET_LABELS,
  COST_RANGE_PRESETS,
  CostQueryFormatError,
  CostQueryParseError,
  costGraphConfigSchema,
  formatCostQuery,
  parseCostQuery,
  type CostBasis,
  type CostFilter,
  type CostGraphConfig,
} from "./config.js";
import type { CostDimensionOption } from "./config.js";
import type { CostApi } from "./types.js";
import { MultiSelect, type MultiSelectStatus } from "../components/MultiSelect.js";

// The labels and the new-widget defaults live in client-core: mobile authors
// the same widgets and can't import this package.
export { DEFAULT_COST_GRAPH_CONFIG } from "./config.js";
export const DIMENSION_LABELS = COST_DIMENSION_LABELS;

const selectBaseClass =
  "rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const selectClass = `w-full ${selectBaseClass}`;
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

interface FilterRowEditorProps {
  filters: CostFilter[];
  onChange: (filters: CostFilter[]) => void;
  api: CostApi;
}

/**
 * Whether the amortized cost basis is worth offering: true once any connected
 * account's plugin declares `amortization`.
 *
 * Offering it unconditionally would be a lie by omission. Without a provider
 * that reports an amortized number, every row falls back to its cash amount and
 * the two options draw the identical graph — a user who switched and saw
 * nothing change would reasonably conclude the feature is broken rather than
 * that their providers don't report it.
 *
 * A failed status load reads as "unavailable" rather than blocking the editor.
 * The one thing that always keeps the control visible is an already-selected
 * amortized basis (`force`): a widget must never lose a setting because the
 * status call happened to fail while it was being edited.
 */
export function useCostBasisChoice(
  api: CostApi,
  force = false,
): { available: boolean; loading: boolean } {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .loadCostStatus()
      .then((statuses) => {
        if (!cancelled) setAvailable(statuses.some((s) => s.supportsCosts && s.amortization));
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return { available: force || available === true, loading: available === null };
}

/** The Cost basis select, shared by the graph and budget editors. */
export function CostBasisField({
  id,
  value,
  onChange,
  available,
  hint,
}: {
  id: string;
  value: CostBasis | undefined;
  onChange: (basis: CostBasis) => void;
  available: boolean;
  hint: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        Cost basis
      </label>
      <select
        id={id}
        className={selectClass}
        value={value ?? "cash"}
        disabled={!available}
        onChange={(e) => onChange(e.target.value as CostBasis)}
      >
        {COST_BASES.map((b) => (
          <option key={b} value={b}>
            {COST_BASIS_LABELS[b]}
          </option>
        ))}
      </select>
      {!available && <p className="mt-1 text-xs text-on-surface-faint">{hint}</p>}
    </div>
  );
}

/** Why the basis select is disabled — one sentence, same words everywhere. */
export const COST_BASIS_UNAVAILABLE_HINT =
  "No connected provider reports amortized cost, so every amount here is what was charged.";

/**
 * Options plus any selected value the load didn't return, so a filter saved
 * against a service that has since stopped appearing in cost data still shows
 * its chip (and can still be deselected) instead of disappearing.
 */
function mergeSelected(options: CostDimensionOption[], values: string[]): CostDimensionOption[] {
  const known = new Set(options.map((o) => o.value));
  const extra = values.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v }));
  return extra.length === 0 ? options : [...options, ...extra];
}

/**
 * Translate the three load states — in flight (`undefined`), failed (`null`),
 * loaded-but-empty — into what the picker shows in place of a list.
 */
function dimensionStatus(
  state: CostDimensionOption[] | null | undefined,
  onRetry: () => void,
): MultiSelectStatus {
  if (state === undefined) return { kind: "loading" };
  if (state === null) {
    return { kind: "error", message: "Couldn’t load values.", onRetry };
  }
  return { kind: "empty", message: "No values in cost data yet" };
}

/** Filter rule rows shared by the graph and budget editors. */
export function CostFilterRows({ filters, onChange, api }: FilterRowEditorProps) {
  // Loaded options per "dimension" / "dimension:tagKey" key. Missing = load
  // not finished (in flight or not started), null = load failed (focus
  // retries via loadOptions).
  const [optionsByKey, setOptionsByKey] = useState<Record<string, CostDimensionOption[] | null>>(
    {},
  );
  const requestedKeys = useRef(new Set<string>());

  const loadOptions = useCallback(
    (dimension: string, tagKey?: string) => {
      const key = tagKey ? `${dimension}:${tagKey}` : dimension;
      if (requestedKeys.current.has(key)) return;
      requestedKeys.current.add(key);
      void api
        .loadDimensionValues(dimension, tagKey)
        .then((values) => setOptionsByKey((prev) => ({ ...prev, [key]: values })))
        .catch(() => {
          requestedKeys.current.delete(key);
          setOptionsByKey((prev) => ({ ...prev, [key]: null }));
        });
    },
    [api],
  );

  // Load each row's options as soon as the row exists — waiting for focus
  // leaves the values box looking dead right after "+ Add filter".
  useEffect(() => {
    for (const f of filters) {
      if (f.dimension === "tag") {
        if (f.tagKey) loadOptions("tag", f.tagKey);
      } else {
        loadOptions(f.dimension);
      }
    }
  }, [filters, loadOptions]);

  const update = (index: number, patch: Partial<CostFilter>) => {
    onChange(filters.map((f, i) => (i === index ? ({ ...f, ...patch } as CostFilter) : f)));
  };

  /** Re-request a row's values; a no-op unless the previous load failed. */
  const retryOptions = (filter: CostFilter) => {
    if (filter.dimension === "tag") {
      if (filter.tagKey) loadOptions("tag", filter.tagKey);
    } else {
      loadOptions(filter.dimension);
    }
  };

  return (
    <div className="space-y-2">
      {filters.map((filter, i) => {
        const optKey = filter.tagKey ? `${filter.dimension}:${filter.tagKey}` : filter.dimension;
        const optionsState = optionsByKey[optKey];
        const options = Array.isArray(optionsState) ? optionsState : [];
        return (
          <div key={i} className="flex items-start gap-2">
            <select
              aria-label="Filter dimension"
              className={`${selectBaseClass} w-28 flex-shrink-0`}
              value={filter.dimension}
              onChange={(e) => {
                const dimension = e.target.value as CostFilter["dimension"];
                update(i, {
                  dimension,
                  values: [],
                  ...(dimension !== "tag" ? { tagKey: undefined } : {}),
                });
                if (dimension !== "tag") loadOptions(dimension);
              }}
            >
              {COST_DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {DIMENSION_LABELS[d]}
                </option>
              ))}
            </select>
            {filter.dimension === "tag" && (
              <input
                aria-label="Tag key"
                className={`${selectBaseClass} w-24 flex-shrink-0`}
                placeholder="tag key"
                value={filter.tagKey ?? ""}
                onChange={(e) => update(i, { tagKey: e.target.value })}
                onBlur={() => filter.tagKey && loadOptions("tag", filter.tagKey)}
              />
            )}
            <select
              aria-label="Filter operator"
              className={`${selectBaseClass} w-24 flex-shrink-0`}
              value={filter.op}
              onChange={(e) => update(i, { op: e.target.value as CostFilter["op"] })}
            >
              <option value="in">is</option>
              <option value="not_in">is not</option>
            </select>
            <MultiSelect
              className="flex-1"
              label="Filter values"
              placeholder="Any value"
              // A saved filter can reference values the current load hasn't
              // returned (or hasn't finished returning); surface them as
              // options so they stay selectable rather than silently vanishing.
              options={mergeSelected(options, filter.values)}
              value={filter.values}
              onChange={(values) => update(i, { values })}
              status={dimensionStatus(optionsState, () => retryOptions(filter))}
              onOpen={() => retryOptions(filter)}
            />
            <button
              type="button"
              onClick={() => onChange(filters.filter((_, j) => j !== i))}
              className="mt-1.5 text-on-surface-faint hover:text-on-surface-secondary text-xs"
              title="Remove filter"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...filters, { dimension: "provider", op: "in", values: [] }])}
        className="text-xs text-blue-400 hover:text-blue-300"
      >
        + Add filter
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Text mode — the same filter, written in the cost query language.
 * ------------------------------------------------------------------ */

export interface CostFilterEditorProps extends FilterRowEditorProps {
  /**
   * Called whenever the text box's validity changes, so the host can refuse to
   * save a half-typed query. Null means "nothing wrong right now".
   *
   * The editor never propagates an unparseable query through `onChange` — the
   * last *valid* filter stays in the config — which is what makes this callback
   * necessary: without it, Save would quietly store the previous filter while
   * the user was looking at their new one.
   */
  onErrorChange?: (error: string | null) => void;
}

/**
 * The filter editor with a rows/text toggle.
 *
 * Both modes are views onto the same `CostFilter[]`, so switching is lossless
 * in both directions: entering text mode renders the current rows through
 * `formatCostQuery`, and every accepted keystroke in text mode compiles back
 * through `parseCostQuery`. The rows stay the default and are never removed —
 * they are the discoverable path, with the dimension list and the value pickers
 * that tell a new user what is even filterable. Text mode is for the people who
 * already know, and for pasting a filter out of a ticket.
 *
 * Two switches are deliberately blocked rather than made lossy:
 *
 * - to text, when a row is a tag with no key — there is nowhere in the language
 *   to put the missing key, and inventing one would round-trip to a different
 *   filter;
 * - to rows, while the query does not parse — the rows can only show the last
 *   valid filter, so switching would silently discard what was typed.
 */
export function CostFilterEditor({ filters, onChange, api, onErrorChange }: CostFilterEditorProps) {
  const uid = useId();
  const [mode, setMode] = useState<"rows" | "text">("rows");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const report = useCallback(
    (next: string | null) => {
      setError(next);
      onErrorChange?.(next);
    },
    [onErrorChange],
  );

  // A mode the host never sees an error from: leaving text mode clears it.
  useEffect(() => {
    if (mode === "rows") report(null);
  }, [mode, report]);

  const toText = () => {
    try {
      setText(formatCostQuery(filters));
      report(null);
      setMode("text");
    } catch (e) {
      report(
        e instanceof CostQueryFormatError
          ? `${e.message} (filter ${e.index + 1})`
          : "This filter can’t be written as text.",
      );
    }
  };

  const onTextChange = (next: string) => {
    setText(next);
    try {
      onChange(parseCostQuery(next));
      report(null);
    } catch (e) {
      report(e instanceof CostQueryParseError ? e.annotated() : "Invalid query.");
    }
  };

  const tabClass = (active: boolean) =>
    `rounded-md px-2 py-0.5 text-xs transition-colors ${
      active
        ? "bg-surface-sunken text-on-surface"
        : "text-on-surface-faint hover:text-on-surface-secondary"
    }`;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-pressed={mode === "rows"}
          // Blocked, not lossy: the rows can only show the last query that
          // parsed, so switching now would throw away what is in the box.
          disabled={mode === "text" && error !== null}
          className={`${tabClass(mode === "rows")} disabled:opacity-40`}
          onClick={() => setMode("rows")}
          title={
            mode === "text" && error !== null
              ? "Fix the query first — switching now would discard it"
              : undefined
          }
        >
          Rows
        </button>
        <button
          type="button"
          aria-pressed={mode === "text"}
          className={tabClass(mode === "text")}
          onClick={toText}
        >
          Query
        </button>
      </div>

      {mode === "rows" ? (
        <CostFilterRows filters={filters} onChange={onChange} api={api} />
      ) : (
        <div className="space-y-1">
          <textarea
            id={`${uid}-query`}
            aria-label="Cost filter query"
            aria-invalid={error !== null}
            spellCheck={false}
            rows={2}
            maxLength={COST_QUERY_MAX_LENGTH}
            className={`${selectClass} font-mono`}
            placeholder="provider = 'aws' AND tag['env'] != 'dev'"
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
          />
          <p className="text-xs text-on-surface-faint">
            Terms joined by AND: <code>= &apos;value&apos;</code>, <code>!= &apos;value&apos;</code>
            , <code>IN (&apos;a&apos;, &apos;b&apos;)</code>,{" "}
            <code>NOT IN (&apos;a&apos;, &apos;b&apos;)</code>,{" "}
            <code>tag[&apos;owner&apos;] = &apos;platform&apos;</code>.
          </p>
        </div>
      )}

      {error && (
        <pre className="whitespace-pre-wrap break-words text-xs text-red-400 font-mono">
          {error}
        </pre>
      )}
    </div>
  );
}

export interface CostGraphConfigModalProps {
  /** Initial values; pass DEFAULT_COST_GRAPH_CONFIG for a new widget. */
  initialConfig: CostGraphConfig;
  initialTitle: string;
  api: CostApi;
  onSave: (title: string, config: CostGraphConfig) => Promise<void> | void;
  onClose: () => void;
}

export function CostGraphConfigModal({
  initialConfig,
  initialTitle,
  api,
  onSave,
  onClose,
}: CostGraphConfigModalProps) {
  const uid = useId();
  const [title, setTitle] = useState(initialTitle);
  const [config, setConfig] = useState<CostGraphConfig>(initialConfig);
  const [tagKeys, setTagKeys] = useState<CostDimensionOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A filter the text editor could not compile. Saving is blocked while it is
   * set: the config still holds the last query that parsed, so saving now would
   * silently store a different filter from the one on screen.
   */
  const [filterError, setFilterError] = useState<string | null>(null);
  const basis = useCostBasisChoice(api, initialConfig.costBasis === "amortized");

  useEffect(() => {
    if (config.groupBy === "tag" && tagKeys.length === 0) {
      void api
        .loadDimensionValues("tag-keys")
        .then(setTagKeys)
        .catch(() => setTagKeys([]));
    }
  }, [api, config.groupBy, tagKeys.length]);

  const set = (patch: Partial<CostGraphConfig>) =>
    setConfig((prev) => ({ ...prev, ...patch }) as CostGraphConfig);

  const save = async () => {
    if (filterError) {
      setError("Fix the filter query before saving.");
      return;
    }
    const cleaned = {
      ...config,
      filters: config.filters.filter((f) => f.values.length > 0),
    };
    const parsed = costGraphConfigSchema.safeParse(cleaned);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid configuration");
      return;
    }
    if (parsed.data.groupBy === "tag" && !parsed.data.groupByTagKey) {
      setError("Choose a tag key to group by");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(title, parsed.data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-surface-raised p-5 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-on-surface mb-4">Cost graph</h2>

        <div className="space-y-4">
          <div>
            <label htmlFor={`${uid}-title`} className={labelClass}>
              Title
            </label>
            <input
              id={`${uid}-title`}
              className={selectClass}
              placeholder="e.g. Cloud spend by provider"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-chart-type`} className={labelClass}>
                Chart type
              </label>
              <select
                id={`${uid}-chart-type`}
                className={selectClass}
                value={config.chartType}
                onChange={(e) => set({ chartType: e.target.value as CostGraphConfig["chartType"] })}
              >
                {COST_CHART_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CHART_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-binning`} className={labelClass}>
                Binning
              </label>
              <select
                id={`${uid}-binning`}
                className={selectClass}
                value={config.binning}
                onChange={(e) => set({ binning: e.target.value as CostGraphConfig["binning"] })}
              >
                {COST_BINNINGS.map((b) => (
                  <option key={b} value={b}>
                    {BINNING_LABELS[b]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-date-range`} className={labelClass}>
                Date range
              </label>
              <select
                id={`${uid}-date-range`}
                className={selectClass}
                value={config.dateRange.kind === "relative" ? config.dateRange.preset : "custom"}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v !== "custom") {
                    set({
                      dateRange: {
                        kind: "relative",
                        preset: v as (typeof COST_RANGE_PRESETS)[number],
                      },
                    });
                  } else {
                    const today = new Date().toISOString().slice(0, 10);
                    set({ dateRange: { kind: "absolute", from: today, to: today } });
                  }
                }}
              >
                {COST_RANGE_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {PRESET_LABELS[p]}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-group-by`} className={labelClass}>
                Group by
              </label>
              <select
                id={`${uid}-group-by`}
                className={selectClass}
                value={config.groupBy}
                onChange={(e) => set({ groupBy: e.target.value as CostGraphConfig["groupBy"] })}
              >
                <option value="none">None</option>
                {COST_DIMENSIONS.map((d) => (
                  <option key={d} value={d}>
                    {DIMENSION_LABELS[d]}
                  </option>
                ))}
              </select>
            </div>
            <CostBasisField
              id={`${uid}-cost-basis`}
              value={config.costBasis}
              onChange={(costBasis) => set({ costBasis })}
              available={basis.available}
              hint={COST_BASIS_UNAVAILABLE_HINT}
            />
          </div>

          {config.dateRange.kind === "absolute" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${uid}-from`} className={labelClass}>
                  From
                </label>
                <input
                  id={`${uid}-from`}
                  type="date"
                  className={selectClass}
                  value={config.dateRange.from}
                  onChange={(e) =>
                    set({
                      dateRange: {
                        kind: "absolute",
                        from: e.target.value,
                        to:
                          config.dateRange.kind === "absolute"
                            ? config.dateRange.to
                            : e.target.value,
                      },
                    })
                  }
                />
              </div>
              <div>
                <label htmlFor={`${uid}-to`} className={labelClass}>
                  To
                </label>
                <input
                  id={`${uid}-to`}
                  type="date"
                  className={selectClass}
                  value={config.dateRange.to}
                  onChange={(e) =>
                    set({
                      dateRange: {
                        kind: "absolute",
                        from:
                          config.dateRange.kind === "absolute"
                            ? config.dateRange.from
                            : e.target.value,
                        to: e.target.value,
                      },
                    })
                  }
                />
              </div>
            </div>
          )}

          {config.groupBy === "tag" && (
            <div>
              <label htmlFor={`${uid}-tag-key`} className={labelClass}>
                Tag key
              </label>
              <select
                id={`${uid}-tag-key`}
                className={selectClass}
                value={config.groupByTagKey ?? ""}
                onChange={(e) => set({ groupByTagKey: e.target.value })}
              >
                <option value="">Choose a tag key…</option>
                {tagKeys.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div role="group" aria-labelledby={`${uid}-filters-label`}>
            <span id={`${uid}-filters-label`} className={labelClass}>
              Filters
            </span>
            <CostFilterEditor
              filters={config.filters}
              onChange={(filters) => set({ filters })}
              api={api}
              onErrorChange={setFilterError}
            />
          </div>

          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2">
              <label htmlFor={`${uid}-top-n`} className="text-xs text-on-surface-secondary">
                Top groups
              </label>
              <input
                id={`${uid}-top-n`}
                type="number"
                min={1}
                max={15}
                className={`${selectBaseClass} w-16`}
                value={config.topN}
                onChange={(e) =>
                  set({ topN: Math.max(1, Math.min(15, Number(e.target.value) || 5)) })
                }
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-on-surface-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={config.comparePreviousPeriod}
                onChange={(e) => set({ comparePreviousPeriod: e.target.checked })}
              />
              Compare previous period
            </label>
            <label className="flex items-center gap-2 text-xs text-on-surface-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={config.showForecast}
                onChange={(e) => set({ showForecast: e.target.checked })}
              />
              Forecast
            </label>
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
    </div>
  );
}
