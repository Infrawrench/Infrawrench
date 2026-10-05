import { useCallback, useEffect, useId, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import {
  COST_DIMENSION_LABELS,
  COST_DIMENSIONS,
  COST_QUERY_MAX_LENGTH,
  CostQueryFormatError,
  CostQueryParseError,
  formatCostQuery,
  parseCostQuery,
  type CostFilter,
  type SavedCostFilter,
} from "./config.js";
import { isKeyedCostDimension, type CostDimensionId } from "@infrawrench/client-core";
import type { CostDimensionOption } from "./config.js";
import type { CostApi } from "./types.js";
import { MultiSelect, type MultiSelectStatus } from "../components/MultiSelect.js";

import { selectBaseClass, selectClass, tabClass } from "./form-styles.js";
import { CloseIcon } from "../components/icons/ChromeIcons.js";
import { TagKeyInput } from "./TagKeyPicker.js";

export const DIMENSION_LABELS = COST_DIMENSION_LABELS;

interface FilterRowEditorProps {
  filters: CostFilter[];
  onChange: (filters: CostFilter[]) => void;
  api: CostApi;
  /**
   * Dimensions this host cannot accept. The virtual tag rule editor passes
   * `["virtual_tag"]`: a virtual tag rule may not filter on another one.
   */
  excludeDimensions?: readonly CostDimensionId[] | undefined;
}

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
 * Translate the three load states: in flight (`undefined`), failed (`null`),
 * loaded-but-empty; into what the picker shows in place of a list.
 */
function dimensionStatus(
  state: CostDimensionOption[] | null | undefined,
  onRetry: () => void,
  gt: (message: string) => string,
): MultiSelectStatus {
  if (state === undefined) return { kind: "loading" };
  if (state === null) {
    return { kind: "error", message: gt("Couldn’t load values."), onRetry };
  }
  return { kind: "empty", message: gt("No values in cost data yet") };
}

/** Filter rule rows shared by the graph and budget editors. */
export function CostFilterRows({
  filters,
  onChange,
  api,
  excludeDimensions,
}: FilterRowEditorProps) {
  const gt = useGT();
  const gtData = useDataString();
  const dimensions = excludeDimensions
    ? COST_DIMENSIONS.filter((d) => !excludeDimensions.includes(d))
    : COST_DIMENSIONS;
  // The org's virtual tag keys, for the key picker on a virtual_tag row. Loaded
  // only once a row actually uses the dimension.
  const [virtualTagKeys, setVirtualTagKeys] = useState<CostDimensionOption[] | null>(null);
  const usesVirtualTags = filters.some((f) => f.dimension === "virtual_tag");
  useEffect(() => {
    if (!usesVirtualTags || virtualTagKeys !== null) return;
    let cancelled = false;
    void api
      .loadDimensionValues("virtual-tag-keys")
      .then((keys) => {
        if (!cancelled) setVirtualTagKeys(keys);
      })
      .catch(() => {
        if (!cancelled) setVirtualTagKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, usesVirtualTags, virtualTagKeys]);
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

  // Load each row's options as soon as the row exists: waiting for focus
  // leaves the values box looking dead right after "+ Add filter".
  useEffect(() => {
    // The tag-key suggestions, once any row is a tag row.
    if (filters.some((f) => f.dimension === "tag")) loadOptions("tag-keys");
    for (const f of filters) {
      if (isKeyedCostDimension(f.dimension)) {
        // A tag row's key field suggests the org's tag keys, preferred first
        // and hidden ones left out by the server.
        if (f.dimension === "tag") loadOptions("tag-keys");
        if (f.tagKey) loadOptions(f.dimension, f.tagKey);
      } else {
        loadOptions(f.dimension);
      }
    }
  }, [filters, loadOptions]);

  const update = (index: number, patch: Partial<CostFilter>) => {
    onChange(filters.map((f, i) => (i === index ? ({ ...f, ...patch } as CostFilter) : f)));
  };
  const tagKeyOptions = optionsByKey["tag-keys"];

  /** Re-request a row's values; a no-op unless the previous load failed. */
  const retryOptions = (filter: CostFilter) => {
    if (isKeyedCostDimension(filter.dimension)) {
      if (filter.tagKey) loadOptions(filter.dimension, filter.tagKey);
    } else {
      loadOptions(filter.dimension);
    }
  };

  const tagKeys = Array.isArray(optionsByKey["tag-keys"]) ? optionsByKey["tag-keys"] : [];

  return (
    <div className="space-y-2">
      {filters.map((filter, i) => {
        const optKey = filter.tagKey ? `${filter.dimension}:${filter.tagKey}` : filter.dimension;
        const optionsState = optionsByKey[optKey];
        const options = Array.isArray(optionsState) ? optionsState : [];
        return (
          <div key={i} className="flex items-start gap-2">
            <select
              aria-label={gt("Filter dimension")}
              className={`${selectBaseClass} w-28 flex-shrink-0`}
              value={filter.dimension}
              onChange={(e) => {
                const dimension = e.target.value as CostFilter["dimension"];
                update(i, { dimension, values: [], tagKey: undefined });
                if (!isKeyedCostDimension(dimension)) loadOptions(dimension);
              }}
            >
              {dimensions.map((d) => (
                <option key={d} value={d}>
                  {gtData(DIMENSION_LABELS[d])}
                </option>
              ))}
            </select>
            {filter.dimension === "tag" && (
              <TagKeyInput
                aria-label={gt("Tag key")}
                className={`${selectBaseClass} w-24 flex-shrink-0`}
                placeholder={gt("tag key")}
                options={Array.isArray(tagKeyOptions) ? tagKeyOptions : null}
                value={filter.tagKey ?? ""}
                onChange={(tagKey) => update(i, { tagKey })}
                onBlur={() => filter.tagKey && loadOptions("tag", filter.tagKey)}
              />
            )}
            {filter.dimension === "virtual_tag" && (
              <select
                aria-label={gt("Virtual tag")}
                className={`${selectBaseClass} w-32 flex-shrink-0`}
                value={filter.tagKey ?? ""}
                onChange={(e) => {
                  const tagKey = e.target.value || undefined;
                  update(i, { tagKey, values: [] });
                  if (tagKey) loadOptions("virtual_tag", tagKey);
                }}
              >
                <option value="">
                  {virtualTagKeys === null ? gt("Loading…") : gt("Choose a virtual tag")}
                </option>
                {mergeSelected(virtualTagKeys ?? [], filter.tagKey ? [filter.tagKey] : []).map(
                  (o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ),
                )}
              </select>
            )}
            <select
              aria-label={gt("Filter operator")}
              className={`${selectBaseClass} w-24 flex-shrink-0`}
              value={filter.op}
              onChange={(e) => update(i, { op: e.target.value as CostFilter["op"] })}
            >
              <option value="in">{gt("is")}</option>
              <option value="not_in">{gt("is not")}</option>
            </select>
            <MultiSelect
              className="flex-1"
              label={gt("Filter values")}
              placeholder={gt("Any value")}
              // A saved filter can reference values the current load hasn't
              // returned (or hasn't finished returning); surface them as
              // options so they stay selectable rather than silently vanishing.
              options={mergeSelected(options, filter.values)}
              value={filter.values}
              onChange={(values) => update(i, { values })}
              status={dimensionStatus(optionsState, () => retryOptions(filter), gt)}
              onOpen={() => retryOptions(filter)}
            />
            <button
              type="button"
              onClick={() => onChange(filters.filter((_, j) => j !== i))}
              className="mt-1.5 text-on-surface-faint hover:text-on-surface-secondary text-xs"
              title={gt("Remove filter")}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...filters, { dimension: "provider", op: "in", values: [] }])}
        className="text-xs text-info hover:text-info-strong"
      >
        {gt("+ Add filter")}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Text mode: the same filter, written in the cost query language.
 * ------------------------------------------------------------------ */

export interface CostFilterEditorProps extends FilterRowEditorProps {
  /**
   * Called whenever the text box's validity changes, so the host can refuse to
   * save a half-typed query. Null means "nothing wrong right now".
   *
   * The editor never propagates an unparseable query through `onChange` (the
   * last *valid* filter stays in the config) which is what makes this callback
   * necessary: without it, Save would quietly store the previous filter while
   * the user was looking at their new one.
   */
  onErrorChange?: (error: string | null) => void;
  /**
   * The saved filter this config references (AND-composed with the inline
   * rows, server-side, at query time). Supplying `onSavedFilterChange` is what
   * turns the saved-filter UI on; hosts whose config has no such field simply
   * don't pass it and the editor renders exactly as before.
   */
  savedFilterId?: string | undefined;
  onSavedFilterChange?: ((savedFilterId: string | undefined) => void) | undefined;
}

/**
 * The saved-filter half of the editor: the chip naming the applied filter, the
 * picker to apply one, and "Save these rows as a filter…".
 *
 * The chip is a *reference*, deliberately never expanded into rows here:
 * expanding would invite editing a copy, and the whole point of the object is
 * that the rows live in one place. Editing goes through the Costs panel's
 * Saved filters section, where the referents are visible.
 */
function SavedFilterPicker({
  api,
  filters,
  onChange,
  savedFilterId,
  onSavedFilterChange,
  rowsMode,
}: {
  api: CostApi;
  filters: CostFilter[];
  onChange: (filters: CostFilter[]) => void;
  savedFilterId: string | undefined;
  onSavedFilterChange: (savedFilterId: string | undefined) => void;
  /** "Save these rows…" only makes sense while the rows are on screen. */
  rowsMode: boolean;
}) {
  const gt = useGT();
  const gtData = useDataString();
  // undefined = loading, null = load failed.
  const [saved, setSaved] = useState<SavedCostFilter[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .listSavedFilters?.()
      .then((rows) => {
        if (!cancelled) setSaved(rows);
      })
      .catch(() => {
        if (!cancelled) setSaved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const applied = savedFilterId ? saved?.find((f) => f.id === savedFilterId) : undefined;
  const savableRows = filters.filter((f) => f.values.length > 0);

  const saveRowsAsFilter = async () => {
    if (!api.createSavedFilter) return;
    const name = window.prompt(gt("Save these rows as a filter named…"));
    if (name === null || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSavedFilter({ name: name.trim(), filters: savableRows });
      // The rows now live in the saved filter; keeping them inline too would
      // apply them twice (harmless under AND, but it reads as duplication and
      // future edits to the saved filter would no longer cover them).
      onSavedFilterChange(created.id);
      onChange([]);
      setSaved((prev) => (Array.isArray(prev) ? [...prev, created] : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Couldn’t save the filter."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      {savedFilterId && (
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-sunken px-2.5 py-1 text-xs text-on-surface"
            title={gt(
              "Applied by reference and combined (AND) with the rows below. Edit it in the Costs panel to change every graph, report and budget using it.",
            )}
          >
            <span className="text-on-surface-faint">{gt("Saved filter")}</span>
            <span className="font-medium">
              {applied ? gtData(applied.name) : saved === undefined ? "…" : savedFilterId}
            </span>
            <button
              type="button"
              onClick={() => onSavedFilterChange(undefined)}
              className="text-on-surface-faint hover:text-on-surface-secondary"
              title={gt(
                "Remove the saved filter from this config (the filter itself is untouched)",
              )}
              aria-label={gt("Remove saved filter")}
            >
              <CloseIcon size={12} />
            </button>
          </span>
        </div>
      )}
      {savedFilterId && Array.isArray(saved) && !applied && (
        <p className="text-xs text-warning">
          {gt(
            "This saved filter no longer resolves — queries will fail until it is removed here or restored.",
          )}
        </p>
      )}
      <div className="flex items-center gap-3">
        {!savedFilterId && Array.isArray(saved) && saved.length > 0 && (
          <select
            aria-label={gt("Apply saved filter")}
            className={`${selectBaseClass} max-w-56 text-xs`}
            value=""
            onChange={(e) => {
              if (e.target.value) onSavedFilterChange(e.target.value);
            }}
          >
            <option value="">{gt("Apply saved filter…")}</option>
            {saved.map((f) => (
              <option key={f.id} value={f.id}>
                {gtData(f.name)}
              </option>
            ))}
          </select>
        )}
        {rowsMode && api.createSavedFilter && savableRows.length > 0 && !savedFilterId && (
          <button
            type="button"
            onClick={() => void saveRowsAsFilter()}
            disabled={busy}
            className="text-xs text-info hover:text-info-strong disabled:opacity-50"
          >
            {gt("Save these rows as a filter…")}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/**
 * The filter editor with a rows/text toggle.
 *
 * Both modes are views onto the same `CostFilter[]`, so switching is lossless
 * in both directions: entering text mode renders the current rows through
 * `formatCostQuery`, and every accepted keystroke in text mode compiles back
 * through `parseCostQuery`. The rows stay the default and are never removed:
 * they are the discoverable path, with the dimension list and the value pickers
 * that tell a new user what is even filterable. Text mode is for the people who
 * already know, and for pasting a filter out of a ticket.
 *
 * Two switches are deliberately blocked rather than made lossy:
 *
 * - to text, when a row is a tag with no key: there is nowhere in the language
 *   to put the missing key, and inventing one would round-trip to a different
 *   filter;
 * - to rows, while the query does not parse: the rows can only show the last
 *   valid filter, so switching would silently discard what was typed.
 */
export function CostFilterEditor({
  filters,
  onChange,
  api,
  onErrorChange,
  savedFilterId,
  onSavedFilterChange,
  excludeDimensions,
}: CostFilterEditorProps) {
  const gt = useGT();
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
  // Done in the click that changes the mode rather than in an effect: an
  // effect would tell the host about the change one render late (and would fire
  // once on mount, for an error that cannot exist yet).
  const toRows = () => {
    if (mode === "text") report(null);
    setMode("rows");
  };

  const toText = () => {
    try {
      setText(formatCostQuery(filters));
      report(null);
      setMode("text");
    } catch (e) {
      report(
        e instanceof CostQueryFormatError
          ? gt("{message} (filter {index})", { message: e.message, index: e.index + 1 })
          : gt("This filter can’t be written as text."),
      );
    }
  };

  const onTextChange = (next: string) => {
    setText(next);
    try {
      onChange(parseCostQuery(next));
      report(null);
    } catch (e) {
      report(e instanceof CostQueryParseError ? e.annotated() : gt("Invalid query."));
    }
  };

  // The saved-filter UI needs both a place to write the reference and a host
  // API that can list filters: absent either, this editor is exactly the
  // pre-saved-filters one.
  const savedFilterUi = Boolean(onSavedFilterChange && api.listSavedFilters);

  return (
    <div className="space-y-2">
      {savedFilterUi && (
        <SavedFilterPicker
          api={api}
          filters={filters}
          onChange={onChange}
          savedFilterId={savedFilterId}
          onSavedFilterChange={onSavedFilterChange!}
          rowsMode={mode === "rows"}
        />
      )}
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-pressed={mode === "rows"}
          // Blocked, not lossy: the rows can only show the last query that
          // parsed, so switching now would throw away what is in the box.
          disabled={mode === "text" && error !== null}
          className={`${tabClass(mode === "rows")} disabled:opacity-40`}
          onClick={toRows}
          title={
            mode === "text" && error !== null
              ? gt("Fix the query first — switching now would discard it")
              : undefined
          }
        >
          {gt("Rows")}
        </button>
        <button
          type="button"
          aria-pressed={mode === "text"}
          className={tabClass(mode === "text")}
          onClick={toText}
        >
          {gt("Query")}
        </button>
      </div>

      {mode === "rows" ? (
        <CostFilterRows
          filters={filters}
          onChange={onChange}
          api={api}
          excludeDimensions={excludeDimensions}
        />
      ) : (
        <div className="space-y-1">
          <textarea
            id={`${uid}-query`}
            aria-label={gt("Cost filter query")}
            aria-invalid={error !== null}
            spellCheck={false}
            rows={2}
            maxLength={COST_QUERY_MAX_LENGTH}
            className={`${selectClass} font-mono`}
            // i18n-ignore: cost query filter syntax example
            placeholder="provider = 'aws' AND tag['env'] != 'dev'"
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
          />
          <T>
            <p className="text-xs text-on-surface-faint">
              Terms joined by AND: <code>= &apos;value&apos;</code>,{" "}
              <code>!= &apos;value&apos;</code>, <code>IN (&apos;a&apos;, &apos;b&apos;)</code>,{" "}
              <code>NOT IN (&apos;a&apos;, &apos;b&apos;)</code>,{" "}
              <code>tag[&apos;owner&apos;] = &apos;platform&apos;</code>.
            </p>
          </T>
        </div>
      )}

      {error && (
        <pre className="whitespace-pre-wrap break-words text-xs text-danger font-mono">{error}</pre>
      )}
    </div>
  );
}
