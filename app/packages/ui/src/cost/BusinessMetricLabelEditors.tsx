import { useEffect, useId, useState } from "react";
import { T, useGT } from "gt-react";

import { useDataString } from "../i18n/data-strings.js";
import { DIMENSION_LABELS } from "./CostFilterEditor.js";
import {
  BUSINESS_METRIC_LIMITS,
  COST_DIMENSIONS,
  DEFAULT_UNIT_COST_THRESHOLD_WINDOW_DAYS,
  UNIT_COST_SCALES,
  UNIT_COST_SCALE_LABELS,
  costDimensionNeedsKey,
  normalizeBusinessMetricLabelKey,
  type BusinessMetricKind,
  type BusinessMetricLabelMapping,
  type CostDimensionOption,
  type UnitCostThreshold,
} from "./config.js";
import type { CostApi } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";
const linkButton = "text-xs text-on-surface-secondary hover:text-on-surface underline";

/** The mapping target as one select value: a dimension id, or "cost_centre". */
function targetValue(mapping: BusinessMetricLabelMapping): string {
  return mapping.target.kind === "cost_centre" ? "cost_centre" : mapping.target.dimension;
}

/**
 * Label → cost dimension mappings. Each row names a label the values carry
 * (picked from the labels already reported, or typed for one not reported
 * yet) and where its values live on the cost side: a cost dimension (with the
 * tag key picked from the org's own tags) or the cost centres.
 */
export function LabelMappingsEditor({
  api,
  mappings,
  onChange,
  knownLabels,
}: {
  api: CostApi;
  mappings: BusinessMetricLabelMapping[];
  onChange: (next: BusinessMetricLabelMapping[]) => void;
  /** Label keys already seen on this metric's values, for the picker. */
  knownLabels: string[];
}) {
  const gt = useGT();
  const gtData = useDataString();
  const uid = useId();
  const [tagKeys, setTagKeys] = useState<CostDimensionOption[] | null>(null);

  const needsTagKeys = mappings.some(
    (m) => m.target.kind === "dimension" && costDimensionNeedsKey(m.target.dimension),
  );
  useEffect(() => {
    if (!needsTagKeys || tagKeys !== null) return;
    let cancelled = false;
    api
      .loadDimensionValues("tag-keys")
      .then((next) => {
        if (!cancelled) setTagKeys(next);
      })
      .catch(() => {
        if (!cancelled) setTagKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, needsTagKeys, tagKeys]);

  const update = (index: number, next: BusinessMetricLabelMapping) =>
    onChange(mappings.map((m, i) => (i === index ? next : m)));

  const unmappedKnown = knownLabels.filter((k) => !mappings.some((m) => m.label === k));

  return (
    <div>
      <span className={labelClass}>{gt("Label mappings")}</span>
      <T>
        <p className="text-[11px] text-on-surface-faint mb-2">
          Map a label to a cost dimension to compute unit cost and margin per value, e.g. customer
          to the customer tag for a cost per customer.
        </p>
      </T>
      <datalist id={`${uid}-labels`}>
        {knownLabels.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <div className="flex flex-col gap-2">
        {mappings.map((mapping, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
            <input
              className={inputClass}
              list={`${uid}-labels`}
              aria-label={gt("Label")}
              placeholder="customer"
              value={mapping.label}
              onChange={(e) =>
                update(index, {
                  ...mapping,
                  label: normalizeBusinessMetricLabelKey(e.target.value),
                })
              }
            />
            <select
              className={inputClass}
              aria-label={gt("Maps to")}
              value={targetValue(mapping)}
              onChange={(e) =>
                update(index, {
                  label: mapping.label,
                  target:
                    e.target.value === "cost_centre"
                      ? { kind: "cost_centre" }
                      : {
                          kind: "dimension",
                          dimension: e.target.value as (typeof COST_DIMENSIONS)[number],
                        },
                })
              }
            >
              {COST_DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {gtData(DIMENSION_LABELS[d])}
                </option>
              ))}
              <option value="cost_centre">{gt("Cost centre")}</option>
            </select>
            {mapping.target.kind === "dimension" &&
            costDimensionNeedsKey(mapping.target.dimension) ? (
              <select
                className={inputClass}
                aria-label={gt("Tag key")}
                value={mapping.target.tagKey ?? ""}
                onChange={(e) =>
                  mapping.target.kind === "dimension" &&
                  update(index, {
                    label: mapping.label,
                    target: { ...mapping.target, tagKey: e.target.value || undefined },
                  })
                }
              >
                <option value="">{tagKeys === null ? gt("Loading…") : gt("Choose a key")}</option>
                {(tagKeys ?? []).map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
                {(() => {
                  const current = mapping.target.tagKey;
                  return current && !(tagKeys ?? []).some((k) => k.value === current) ? (
                    <option value={current}>{current}</option>
                  ) : null;
                })()}
              </select>
            ) : (
              <span className="text-[11px] text-on-surface-faint">
                {mapping.target.kind === "cost_centre"
                  ? gt("Matched by centre name or id")
                  : gt("Matched by value")}
              </span>
            )}
            <button
              type="button"
              className={linkButton}
              onClick={() => onChange(mappings.filter((_, i) => i !== index))}
            >
              {gt("Remove")}
            </button>
          </div>
        ))}
      </div>
      {mappings.length < BUSINESS_METRIC_LIMITS.maxLabelMappings && (
        <button
          type="button"
          className={`${linkButton} mt-2`}
          onClick={() =>
            onChange([
              ...mappings,
              {
                label: unmappedKnown[0] ?? "",
                target: { kind: "dimension", dimension: "tag" },
              },
            ])
          }
        >
          {gt("Add a mapping")}
        </button>
      )}
    </div>
  );
}

/**
 * Standing limits on the metric's unit cost or margin. Each one is evaluated
 * daily over its trailing window and routed under the unit-cost alert trigger.
 */
export function ThresholdsEditor({
  thresholds,
  onChange,
  kind,
  currency,
  unit,
  mappedLabels,
}: {
  thresholds: UnitCostThreshold[];
  onChange: (next: UnitCostThreshold[]) => void;
  kind: BusinessMetricKind;
  currency: string | undefined;
  unit: string;
  mappedLabels: string[];
}) {
  const gt = useGT();
  const gtData = useDataString();
  const update = (index: number, patch: Partial<UnitCostThreshold>) =>
    onChange(thresholds.map((t, i) => (i === index ? { ...t, ...patch } : t)));

  return (
    <div>
      <span className={labelClass}>{gt("Alert thresholds")}</span>
      <T>
        <p className="text-[11px] text-on-surface-faint mb-2">
          Alert when unit cost or margin over a trailing window crosses a limit. Windows with under
          half their days reported are skipped.
        </p>
      </T>
      <div className="flex flex-col gap-2">
        {thresholds.map((t, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2 text-xs text-on-surface">
            <select
              className={`${inputClass} w-auto`}
              aria-label={gt("Calculation")}
              value={t.mode}
              onChange={(e) =>
                update(index, {
                  mode: e.target.value === "margin" ? "margin" : "unit_cost",
                  scale: undefined,
                })
              }
            >
              <option value="unit_cost">
                {gt("Cost per {unit}", { unit: unit || gt("unit") })}
              </option>
              <option value="margin" disabled={kind !== "currency"}>
                {gt("Margin")}
              </option>
            </select>
            <select
              className={`${inputClass} w-auto`}
              aria-label={gt("Direction")}
              value={t.direction}
              onChange={(e) =>
                update(index, { direction: e.target.value === "below" ? "below" : "above" })
              }
            >
              <option value="above">{gt("above")}</option>
              <option value="below">{gt("below")}</option>
            </select>
            <input
              className={`${inputClass} w-24`}
              aria-label={gt("Limit")}
              inputMode="decimal"
              value={Number.isFinite(t.value) ? String(t.value) : ""}
              onChange={(e) => update(index, { value: Number(e.target.value) })}
            />
            <span className="text-on-surface-faint">
              {t.mode === "margin" ? "%" : (currency ?? gt("in spend currency"))}
            </span>
            {t.mode === "unit_cost" && (
              <select
                className={`${inputClass} w-auto`}
                aria-label={gt("Scale")}
                value={String(t.scale ?? 1)}
                onChange={(e) => {
                  const scale = Number(e.target.value) as UnitCostThreshold["scale"];
                  update(index, { scale: scale === 1 ? undefined : scale });
                }}
              >
                {UNIT_COST_SCALES.map((s) => (
                  <option key={s} value={String(s)}>
                    {gtData(UNIT_COST_SCALE_LABELS[`${s}`])}
                  </option>
                ))}
              </select>
            )}
            <span className="text-on-surface-faint">{gt("over")}</span>
            <input
              className={`${inputClass} w-16`}
              aria-label={gt("Window in days")}
              inputMode="numeric"
              value={String(t.windowDays ?? DEFAULT_UNIT_COST_THRESHOLD_WINDOW_DAYS)}
              onChange={(e) => update(index, { windowDays: Math.round(Number(e.target.value)) })}
            />
            <span className="text-on-surface-faint">{gt("days")}</span>
            {mappedLabels.length > 0 && (
              <select
                className={`${inputClass} w-auto`}
                aria-label={gt("Per label")}
                value={t.groupByLabel ?? ""}
                onChange={(e) => update(index, { groupByLabel: e.target.value || undefined })}
              >
                <option value="">{gt("for the whole metric")}</option>
                {mappedLabels.map((l) => (
                  <option key={l} value={l}>
                    {gt("per {label}", { label: l })}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className={linkButton}
              onClick={() => onChange(thresholds.filter((_, i) => i !== index))}
            >
              {gt("Remove")}
            </button>
          </div>
        ))}
      </div>
      {thresholds.length < BUSINESS_METRIC_LIMITS.maxThresholds && (
        <button
          type="button"
          className={`${linkButton} mt-2`}
          onClick={() =>
            onChange([
              ...thresholds,
              kind === "currency"
                ? { mode: "margin", direction: "below", value: 30 }
                : { mode: "unit_cost", direction: "above", value: 1 },
            ])
          }
        >
          {gt("Add a threshold")}
        </button>
      )}
    </div>
  );
}
