import { useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  ALERT_TRIGGERS,
  SEVERITY_LABELS,
  type AlertCondition,
  type AlertRulesResponse,
  type AlertSeverity,
} from "@infrawrench/client-core";
import { useDataString } from "../../i18n/data-strings.js";

import { INPUT } from "./shared.js";

/* -------------------------------------------------------------------------- */
/* Conditions                                                                 */
/* -------------------------------------------------------------------------- */

export function newCondition(field: AlertCondition["field"]): AlertCondition {
  switch (field) {
    case "trigger":
      return { field: "trigger", op: "in", values: [] };
    case "severity":
      return { field: "severity", op: "gte", severity: "warning" };
    case "accountId":
      return { field: "accountId", op: "in", values: [] };
    case "pluginId":
      return { field: "pluginId", op: "in", values: [] };
    case "resourceTypeId":
      return { field: "resourceTypeId", op: "in", values: [] };
    case "amountCents":
      return { field: "amountCents", op: "gte", cents: 50_000 };
    case "key":
      return { field: "key", op: "contains", value: "" };
    case "text":
      return { field: "text", op: "contains", value: "" };
  }
}

export const CONDITION_FIELDS: Array<AlertCondition["field"]> = [
  "trigger",
  "severity",
  "accountId",
  "pluginId",
  "resourceTypeId",
  "amountCents",
  "key",
  "text",
];

export function useConditionLabels(): Record<AlertCondition["field"], string> {
  const gt = useGT();
  return {
    trigger: gt("Trigger"),
    severity: gt("Severity"),
    accountId: gt("Account"),
    pluginId: gt("Provider"),
    resourceTypeId: gt("Resource type"),
    amountCents: gt("Amount"),
    key: gt("Name"),
    text: gt("Message text"),
  };
}

export function ConditionRow({
  condition,
  data,
  onChange,
  onRemove,
}: {
  condition: AlertCondition;
  data: AlertRulesResponse;
  onChange: (next: AlertCondition) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const conditionLabels = useConditionLabels();
  const providers = useMemo(
    () => [...new Set(data.accounts.map((a) => a.pluginId))].sort(),
    [data.accounts],
  );

  // Every control in the row is labelled off the field name in the leading
  // span. The span is visible text, but it sits beside the controls rather than
  // wrapping them, so a screen reader has nothing to tie the two together
  // without these — and "at least / exactly" on its own says nothing about what
  // is being compared.
  const fieldLabel = conditionLabels[condition.field];

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-on-surface-tertiary w-28 shrink-0">{fieldLabel}</span>

      {condition.field === "severity" ? (
        <>
          <select
            className={INPUT}
            aria-label={gt("{field} comparison", { field: fieldLabel })}
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.target.value as "gte" | "eq" })}
          >
            <option value="gte">{gt("at least")}</option>
            <option value="eq">{gt("exactly")}</option>
          </select>
          <select
            className={INPUT}
            aria-label={fieldLabel}
            value={condition.severity}
            onChange={(e) => onChange({ ...condition, severity: e.target.value as AlertSeverity })}
          >
            {(Object.keys(SEVERITY_LABELS) as AlertSeverity[]).map((s) => (
              <option key={s} value={s}>
                {gtData(SEVERITY_LABELS[s])}
              </option>
            ))}
          </select>
        </>
      ) : condition.field === "amountCents" ? (
        <>
          <select
            className={INPUT}
            aria-label={gt("{field} comparison", { field: fieldLabel })}
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.target.value as "gte" | "lt" })}
          >
            <option value="gte">{gt("at least")}</option>
            <option value="lt">{gt("under")}</option>
          </select>
          <span className="text-on-surface-faint">$</span>
          <AmountInput
            cents={condition.cents}
            label={fieldLabel}
            onChange={(cents) => onChange({ ...condition, cents })}
          />
        </>
      ) : condition.field === "key" || condition.field === "text" ? (
        <>
          <select
            className={INPUT}
            aria-label={gt("{field} comparison", { field: fieldLabel })}
            value={condition.op}
            onChange={(e) => {
              // Narrowed per field rather than shared: `key` also accepts an
              // exact match and `text` does not, so a single cast across both
              // would let the editor build a `text`/`eq` condition the matcher
              // has no case for.
              const op = e.target.value;
              onChange(
                condition.field === "key"
                  ? { ...condition, op: op as "contains" | "notContains" | "eq" }
                  : { ...condition, op: op as "contains" | "notContains" },
              );
            }}
          >
            <option value="contains">{gt("contains")}</option>
            <option value="notContains">{gt("does not contain")}</option>
            {condition.field === "key" && <option value="eq">{gt("is exactly")}</option>}
          </select>
          <input
            className={`${INPUT} flex-1 min-w-40`}
            aria-label={gt("{field} to match", { field: fieldLabel })}
            value={condition.value}
            placeholder={
              condition.field === "key" ? gt("service or rule name") : gt("text in the alert")
            }
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
          />
        </>
      ) : (
        <>
          <select
            className={INPUT}
            aria-label={gt("{field} comparison", { field: fieldLabel })}
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.target.value as "in" | "notIn" })}
          >
            <option value="in">{gt("is one of")}</option>
            <option value="notIn">{gt("is not one of")}</option>
          </select>
          <MultiSelect
            label={fieldLabel}
            values={condition.values}
            options={
              condition.field === "trigger"
                ? ALERT_TRIGGERS.map((t) => ({ value: t.id as string, label: gtData(t.label) }))
                : condition.field === "accountId"
                  ? data.accounts.map((a) => ({ value: a.id, label: a.displayName }))
                  : condition.field === "pluginId"
                    ? providers.map((p) => ({ value: p, label: p }))
                    : []
            }
            freeText={condition.field === "resourceTypeId"}
            onChange={(values) => onChange({ ...condition, values })}
          />
        </>
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label={gt("Remove the {field} condition", { field: fieldLabel })}
        className="ml-auto text-xs text-danger hover:text-danger-strong"
      >
        {gt("Remove")}
      </button>
    </div>
  );
}

/**
 * A dollars field over a cents value.
 *
 * The text is held locally while the field has focus, because deriving it from
 * `cents` on every keystroke fights the user: `12.` round-trips to `12` the
 * instant the decimal point is typed, and `12.50` loses its trailing zero. The
 * committed value still updates on each change — only the *rendering* is
 * deferred — so nothing has to be saved for the rule to be valid. On blur the
 * field re-syncs to the canonical value, which is what normalizes `12.005` and
 * an empty box.
 */
function AmountInput({
  cents,
  label,
  onChange,
}: {
  cents: number;
  label: string;
  onChange: (cents: number) => void;
}) {
  const gt = useGT();
  const [text, setText] = useState<string | null>(null);

  return (
    <input
      className={`${INPUT} w-28`}
      type="number"
      min={0}
      step="0.01"
      aria-label={gt("{field} in dollars", { field: label })}
      value={text ?? (cents / 100).toString()}
      onChange={(e) => {
        setText(e.target.value);
        onChange(Math.max(0, Math.round(Number(e.target.value) * 100)) || 0);
      }}
      onBlur={() => setText(null)}
    />
  );
}

/**
 * A checkbox list for the enumerable fields, and a comma-separated text input
 * for resource type ids — there are hundreds of those across 49 plugins, and a
 * picker over all of them is worse than typing the one you mean.
 */
function MultiSelect({
  label,
  values,
  options,
  freeText,
  onChange,
}: {
  /** The condition's field name, so each control can name what it selects. */
  label: string;
  values: string[];
  options: Array<{ value: string; label: string }>;
  freeText?: boolean;
  onChange: (next: string[]) => void;
}) {
  const gt = useGT();
  // A Set rather than `values.includes` in the map below: the checkbox list can
  // run to every trigger or every account, and `includes` rescans the selection
  // for each one.
  const selected = useMemo(() => new Set(values), [values]);

  if (freeText || options.length === 0) {
    return (
      <input
        className={`${INPUT} flex-1 min-w-40`}
        aria-label={gt("{field} ids, comma-separated", { field: label })}
        value={values.join(", ")}
        placeholder={gt("comma-separated ids")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-tertiary"
    >
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-1.5 whitespace-nowrap">
          <input
            type="checkbox"
            checked={selected.has(o.value)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...values, o.value] : values.filter((v) => v !== o.value),
              )
            }
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}
