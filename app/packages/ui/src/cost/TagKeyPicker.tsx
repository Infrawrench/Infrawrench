import { useEffect, useId, useState } from "react";
import { useGT } from "gt-react";
import { groupTagKeyOptions } from "@infrawrench/client-core";
import type { CostDimensionOption } from "./config.js";

/**
 * Tag key pickers, shared by every surface that asks for one: the graph
 * editor's group-by, filter rows (and so budgets, saved filters, change-alert
 * scopes), the change-alert group-by, cost export columns and the metric
 * alert selector.
 *
 * The org's tag key settings are applied by the server: the options arrive
 * with hidden keys already left out and preferred keys first and flagged.
 * All these components add is the presentation: a "Preferred" group above
 * the rest, and keeping a value the list no longer offers (a key hidden after
 * a report was saved against it) selectable, because hiding a key must never
 * silently re-scope something that already uses it.
 */

/**
 * The org's tag keys for a picker, loaded once while `enabled`. `null` while
 * loading or when the load failed: a picker then still works as free text.
 */
export function useTagKeyOptions(
  load: (() => Promise<CostDimensionOption[]>) | null | undefined,
  enabled = true,
): CostDimensionOption[] | null {
  const [options, setOptions] = useState<CostDimensionOption[] | null>(null);
  useEffect(() => {
    if (!enabled || !load || options !== null) return;
    let cancelled = false;
    load().then(
      (loaded) => {
        if (!cancelled) setOptions(loaded);
      },
      () => {
        if (!cancelled) setOptions([]);
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` is usually an inline arrow; loading once per mount is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, options]);
  return options;
}

export interface TagKeySelectProps {
  options: readonly CostDimensionOption[];
  value: string;
  onChange: (key: string) => void;
  /** Label of the empty option ("Choose a tag key…", "Any tag"). */
  emptyLabel: string;
  id?: string | undefined;
  className?: string | undefined;
  "aria-label"?: string | undefined;
}

/** A `<select>` of tag keys with the org's preferred keys in their own group. */
export function TagKeySelect({
  options,
  value,
  onChange,
  emptyLabel,
  id,
  className,
  "aria-label": ariaLabel,
}: TagKeySelectProps) {
  const gt = useGT();
  const { preferred, others } = groupTagKeyOptions(options);
  const missing = value !== "" && !options.some((o) => o.value === value);
  const render = (o: CostDimensionOption) => (
    <option key={o.value} value={o.value}>
      {o.hidden ? gt("{key} (hidden)", { key: o.label }) : o.label}
    </option>
  );
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{emptyLabel}</option>
      {missing && <option value={value}>{gt("{key} (not in the list)", { key: value })}</option>}
      {preferred.length > 0 ? (
        <>
          <optgroup label={gt("Preferred")}>{preferred.map(render)}</optgroup>
          {others.length > 0 && (
            <optgroup label={gt("All tag keys")}>{others.map(render)}</optgroup>
          )}
        </>
      ) : (
        others.map(render)
      )}
    </select>
  );
}

export interface TagKeyInputProps {
  options: readonly CostDimensionOption[] | null;
  value: string;
  onChange: (key: string) => void;
  onBlur?: (() => void) | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
  "aria-label"?: string | undefined;
}

/**
 * A free-text tag key field with the org's keys as suggestions, preferred
 * first. Free text on purpose where a field always was: a hidden key is still
 * a valid filter, so the field must accept one, and a picker that only
 * offered the visible keys would take that away.
 */
export function TagKeyInput({
  options,
  value,
  onChange,
  onBlur,
  placeholder,
  className,
  "aria-label": ariaLabel,
}: TagKeyInputProps) {
  const gt = useGT();
  const listId = useId();
  return (
    <>
      <input
        aria-label={ariaLabel}
        className={className}
        placeholder={placeholder}
        value={value}
        list={options && options.length > 0 ? listId : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {options && options.length > 0 && (
        <datalist id={listId}>
          {options.map((o) => (
            <option
              key={o.value}
              value={o.value}
              label={o.preferred ? gt("Preferred") : undefined}
            />
          ))}
        </datalist>
      )}
    </>
  );
}
