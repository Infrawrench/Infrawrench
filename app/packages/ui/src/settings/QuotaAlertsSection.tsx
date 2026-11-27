import { useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import {
  QUOTA_ALERT_LIMITS,
  RUNWAY_ALERT_LIMITS,
  type QuotaSettings,
  type QuotaSettingsPatch,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

const inputClass =
  "w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong";

/** A typed percentage, bounded like the server bounds the fraction; null when unusable. */
function percentToFraction(raw: string, bounds: { min: number; max: number }): number | null {
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n)) return null;
  const fraction = Math.round(n) / 100;
  return Math.min(Math.max(fraction, bounds.min), bounds.max);
}

/**
 * Org-level quota radar and capacity runway alert settings: one switch and
 * three thresholds, because both ride one daily digest under the **Quotas**
 * trigger. The quota threshold also sets the radar's "over threshold" bucket;
 * the runway thresholds set the runway list's "running out" bucket.
 */
export function QuotaAlertsSection() {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [settings, setSettings] = useState<QuotaSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // Raw text while editing so half-typed values don't snap back on every keystroke.
  const [thresholdInput, setThresholdInput] = useState("");
  const [runwayDaysInput, setRunwayDaysInput] = useState("");
  const [allowanceInput, setAllowanceInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get<QuotaSettings>(`/api/org/${orgId}/quotas/settings`)
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {
        // Non-admins get a 403: hide the card rather than show an error.
        if (!cancelled) setForbidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);

  useEffect(() => {
    if (!settings) return;
    setThresholdInput(String(Math.round(settings.threshold * 100)));
    setRunwayDaysInput(String(settings.runwayDays));
    setAllowanceInput(String(Math.round(settings.allowanceThreshold * 100)));
  }, [settings]);

  async function save(patch: QuotaSettingsPatch) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    try {
      const saved = await api.put<QuotaSettings>(`/api/org/${orgId}/quotas/settings`, patch);
      setSettings(saved);
    } catch (e) {
      setSettings(previous);
      setError(e instanceof Error ? e.message : gt("Failed to save quota alert settings"));
    }
  }

  if (forbidden || !settings) return null;

  const { min: thresholdMin, max: thresholdMax } = QUOTA_ALERT_LIMITS.threshold;
  const { min: daysMin, max: daysMax } = RUNWAY_ALERT_LIMITS.runwayDays;
  const allowanceBounds = RUNWAY_ALERT_LIMITS.allowanceThreshold;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">
          {gt("Quotas & capacity runway")}
        </h2>
        <T>
          <p className="text-xs text-on-surface-muted mt-1">
            Routed by the <strong>Quotas</strong> trigger above.
          </p>
        </T>
      </div>

      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        <span>{gt("Send quota and runway alerts")}</span>
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="quota-threshold" className="block text-xs text-on-surface-tertiary mb-1">
            {gt("Quota threshold (%)")}
          </label>
          <input
            id="quota-threshold"
            type="number"
            min={Math.round(thresholdMin * 100)}
            max={Math.round(thresholdMax * 100)}
            value={thresholdInput}
            onChange={(e) => setThresholdInput(e.target.value)}
            onBlur={() => {
              const next = percentToFraction(thresholdInput, QUOTA_ALERT_LIMITS.threshold);
              if (next === null) {
                setThresholdInput(String(Math.round(settings.threshold * 100)));
                return;
              }
              setThresholdInput(String(Math.round(next * 100)));
              if (next !== settings.threshold) void save({ threshold: next });
            }}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="runway-days" className="block text-xs text-on-surface-tertiary mb-1">
            {gt("Runway alert (days)")}
          </label>
          <input
            id="runway-days"
            type="number"
            min={daysMin}
            max={daysMax}
            value={runwayDaysInput}
            onChange={(e) => setRunwayDaysInput(e.target.value)}
            onBlur={() => {
              const raw = runwayDaysInput.trim();
              const n = raw === "" ? Number.NaN : Number(raw);
              if (!Number.isFinite(n)) {
                setRunwayDaysInput(String(settings.runwayDays));
                return;
              }
              const next = Math.min(Math.max(Math.round(n), daysMin), daysMax);
              setRunwayDaysInput(String(next));
              if (next !== settings.runwayDays) void save({ runwayDays: next });
            }}
            className={inputClass}
          />
        </div>
        <div>
          <label
            htmlFor="allowance-threshold"
            className="block text-xs text-on-surface-tertiary mb-1"
          >
            {gt("Monthly allowance (%)")}
          </label>
          <input
            id="allowance-threshold"
            type="number"
            min={Math.round(allowanceBounds.min * 100)}
            max={Math.round(allowanceBounds.max * 100)}
            value={allowanceInput}
            onChange={(e) => setAllowanceInput(e.target.value)}
            onBlur={() => {
              const next = percentToFraction(allowanceInput, allowanceBounds);
              if (next === null) {
                setAllowanceInput(String(Math.round(settings.allowanceThreshold * 100)));
                return;
              }
              setAllowanceInput(String(Math.round(next * 100)));
              if (next !== settings.allowanceThreshold) void save({ allowanceThreshold: next });
            }}
            className={inputClass}
          />
        </div>
      </div>

      {settings.lastNotifiedAt && (
        <p className="text-xs text-on-surface-tertiary">
          {gt("Last quota alert scan {date}.", {
            date: new Date(settings.lastNotifiedAt).toLocaleString(),
          })}
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  );
}
