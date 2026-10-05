import { useState } from "react";
import { T, useGT } from "gt-react";
import {
  DISCOUNT_CATEGORIES,
  DISCOUNT_CATEGORY_LABELS,
  DISCOUNT_TREATMENT_MODE_LABELS,
  DISCOUNT_TREATMENT_MODES,
  managedAccountPricingError,
  type CostDimensionOption,
  type DiscountCategory,
  type DiscountTreatmentMode,
  type ManagedAccountPricing,
  type PricingPreviewResult,
  type PricingScopeEntry,
} from "@infrawrench/client-core";
import { useDataString } from "../i18n/data-strings.js";
import { PricingPreviewView } from "../cost/PricingPreview.js";
import { BTN, FIELD } from "./shared.js";

/** `YYYY-MM` of last calendar month, the preview's default. */
function previousMonth(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

function scopeLabel(
  entry: PricingScopeEntry,
  providers: readonly CostDimensionOption[],
  allServices: string,
): string {
  const provider = providers.find((p) => p.value === entry.pluginId)?.label ?? entry.pluginId;
  return `${provider} · ${entry.service || allServices}`;
}

/**
 * A provider + optional service picker with an Add button. The service list is
 * every service with spend, since the cost dimension values do not say which
 * provider a service belongs to; picking none means "every service".
 */
function ScopePicker({
  providers,
  services,
  withPercent,
  onAdd,
}: {
  providers: readonly CostDimensionOption[];
  services: readonly CostDimensionOption[];
  withPercent: boolean;
  onAdd: (entry: PricingScopeEntry & { percent: number }) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [pluginId, setPluginId] = useState("");
  const [service, setService] = useState("");
  const [percent, setPercent] = useState("10");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={FIELD}
        value={pluginId}
        onChange={(e) => setPluginId(e.target.value)}
        aria-label={gt("Provider")}
      >
        <option value="">{gt("Pick a provider…")}</option>
        {providers.map((p) => (
          <option key={p.value} value={p.value}>
            {gtData(p.label)}
          </option>
        ))}
      </select>
      <select
        className={FIELD}
        value={service}
        onChange={(e) => setService(e.target.value)}
        aria-label={gt("Service")}
      >
        <option value="">{gt("All services")}</option>
        {services.map((s) => (
          <option key={s.value} value={s.value}>
            {gtData(s.label)}
          </option>
        ))}
      </select>
      {withPercent && (
        <input
          type="number"
          className={`${FIELD} w-20`}
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
          aria-label={gt("Uplift percent")}
        />
      )}
      <button
        type="button"
        className={BTN}
        disabled={!pluginId}
        onClick={() => {
          onAdd({ pluginId, service: service || null, percent: Number(percent) });
          setService("");
        }}
      >
        {gt("Add")}
      </button>
    </div>
  );
}

/**
 * The managed-account pricing controls: re-rating to public pricing and what
 * happens to provider discounts, credits and commitment benefits. Everything
 * here is applied when an invoice is computed and never written into collected
 * spend.
 */
export function PricingEditor({
  value,
  onChange,
  providers,
  services,
  onPreview,
}: {
  value: ManagedAccountPricing;
  onChange: (next: ManagedAccountPricing) => void;
  providers: readonly CostDimensionOption[];
  services: readonly CostDimensionOption[];
  /** Price a month with these settings; absent hides the preview. */
  onPreview?:
    ((pricing: ManagedAccountPricing, month: string) => Promise<PricingPreviewResult>) | undefined;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [month, setMonth] = useState(previousMonth);
  const [preview, setPreview] = useState<PricingPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const rerate = value.rerate;
  const setRerate = (patch: Partial<ManagedAccountPricing["rerate"]>) =>
    onChange({ ...value, rerate: { ...rerate, ...patch } });
  const setTreatment = (
    category: DiscountCategory,
    mode: DiscountTreatmentMode,
    passThroughPercent?: number,
  ) =>
    onChange({
      ...value,
      [category]: {
        mode,
        passThroughPercent: mode === "partial" ? (passThroughPercent ?? 50) : null,
      },
    });

  const blocker = managedAccountPricingError(value);
  const allServices = gt("all services");

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-on-surface">{gt("Pricing")}</span>
        <T>
          <p className="text-xs text-on-surface-faint">
            Applied to this customer&rsquo;s invoices. Collected spend is never changed.
          </p>
        </T>
      </div>

      <label className="flex items-center gap-2 text-xs text-on-surface">
        <input
          type="checkbox"
          checked={rerate.enabled}
          onChange={(e) => setRerate({ enabled: e.target.checked })}
        />
        {gt("Re-rate usage to the providers’ public on-demand list prices")}
      </label>

      {rerate.enabled && (
        <div className="flex flex-col gap-2 pl-5">
          <T>
            <p className="text-xs text-on-surface-faint">
              Usage is billed at the provider&rsquo;s list price instead of what you paid. Lines
              with no list price get the collected amount plus the fallback uplift.
            </p>
          </T>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-on-surface-faint">
              {gt("Providers and services to re-rate (none listed means all)")}
            </span>
            {rerate.scope.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {rerate.scope.map((entry, i) => (
                  <span
                    key={`${entry.pluginId}/${entry.service ?? ""}`}
                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs"
                  >
                    {gtData(scopeLabel(entry, providers, allServices))}
                    <button
                      type="button"
                      aria-label={gt("Remove")}
                      onClick={() => setRerate({ scope: rerate.scope.filter((_, j) => j !== i) })}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <ScopePicker
              providers={providers}
              services={services}
              withPercent={false}
              onAdd={({ pluginId, service }) =>
                setRerate({ scope: [...rerate.scope, { pluginId, service }] })
              }
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-on-surface-faint">
            {gt("Fallback uplift where no list price exists (%)")}
            <input
              type="number"
              className={`${FIELD} w-20`}
              value={rerate.fallbackUpliftPercent}
              onChange={(e) => setRerate({ fallbackUpliftPercent: Number(e.target.value) })}
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-on-surface-faint">
              {gt("Per-provider or per-service fallback uplifts (the most specific wins)")}
            </span>
            {rerate.uplifts.map((u, i) => (
              <div
                key={`${u.pluginId}/${u.service ?? ""}`}
                className="flex items-center gap-2 text-xs"
              >
                <span className="text-on-surface">
                  {gtData(scopeLabel(u, providers, allServices))}
                </span>
                <input
                  type="number"
                  className={`${FIELD} w-20`}
                  value={u.percent}
                  aria-label={gt("Uplift percent")}
                  onChange={(e) =>
                    setRerate({
                      uplifts: rerate.uplifts.map((x, j) =>
                        j === i ? { ...x, percent: Number(e.target.value) } : x,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className="text-danger"
                  onClick={() => setRerate({ uplifts: rerate.uplifts.filter((_, j) => j !== i) })}
                >
                  {gt("Remove")}
                </button>
              </div>
            ))}
            <ScopePicker
              providers={providers}
              services={services}
              withPercent
              onAdd={(entry) => setRerate({ uplifts: [...rerate.uplifts, entry] })}
            />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-xs text-on-surface-faint">
          {gt("Provider discounts and credits on this customer’s invoices")}
        </span>
        {DISCOUNT_CATEGORIES.map((category) => {
          const t = value[category];
          return (
            <div key={category} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 text-on-surface">
                {gtData(DISCOUNT_CATEGORY_LABELS[category])}
              </span>
              <select
                className={FIELD}
                value={t.mode}
                aria-label={gtData(DISCOUNT_CATEGORY_LABELS[category])}
                onChange={(e) => setTreatment(category, e.target.value as DiscountTreatmentMode)}
              >
                {DISCOUNT_TREATMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {gtData(DISCOUNT_TREATMENT_MODE_LABELS[m])}
                  </option>
                ))}
              </select>
              {t.mode === "partial" && (
                <label className="flex items-center gap-1 text-on-surface-faint">
                  <input
                    type="number"
                    className={`${FIELD} w-20`}
                    value={t.passThroughPercent ?? 50}
                    onChange={(e) => setTreatment(category, "partial", Number(e.target.value))}
                  />
                  {gt("% to the customer")}
                </label>
              )}
            </div>
          );
        })}
      </div>

      {blocker !== null && <p className="text-xs text-warning">{blocker}</p>}

      {onPreview && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              type="month"
              className={FIELD}
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              aria-label={gt("Preview month")}
            />
            <button
              type="button"
              className={BTN}
              disabled={previewing || blocker !== null || !month}
              onClick={() => {
                setPreviewing(true);
                setPreviewError(null);
                onPreview(value, month)
                  .then(setPreview)
                  .catch((e: unknown) =>
                    setPreviewError(e instanceof Error ? e.message : String(e)),
                  )
                  .finally(() => setPreviewing(false));
              }}
            >
              {previewing ? gt("Pricing…") : gt("Preview against that month")}
            </button>
          </div>
          {previewError !== null && (
            <p role="alert" className="text-xs text-danger">
              {previewError}
            </p>
          )}
          {preview && <PricingPreviewView result={preview} />}
        </div>
      )}
    </div>
  );
}
