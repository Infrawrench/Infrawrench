import { useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import {
  PRICE_CHANGE_LIMITS,
  type PriceChangeSettings,
  type PriceChangeSettingsPatch,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

const inputClass =
  "w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong";

const { minMonthlyImpactCents: CENTS, minPercent: PERCENT } = PRICE_CHANGE_LIMITS;

/**
 * Org-level price-change watch settings: the daily scan's switch, the two
 * thresholds under which a change is listed but not alerted, and whether an
 * alerted increase is registered as expected for anomaly detection. Who hears
 * the alert is the "Price changes" routing trigger above.
 */
export function PriceChangeAlertsSection() {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [settings, setSettings] = useState<PriceChangeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [amountInput, setAmountInput] = useState("");
  const [percentInput, setPercentInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get<PriceChangeSettings>(`/api/org/${orgId}/price-changes/settings`)
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        setAmountInput(String(s.minMonthlyImpactCents / 100));
        setPercentInput(String(s.minPercent));
      })
      .catch(() => {
        // Non-admins get a 403: hide the section rather than show an error.
        if (!cancelled) setForbidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);

  async function save(patch: PriceChangeSettingsPatch) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    try {
      const saved = await api.put<PriceChangeSettings>(
        `/api/org/${orgId}/price-changes/settings`,
        patch,
      );
      setSettings(saved);
      setAmountInput(String(saved.minMonthlyImpactCents / 100));
      setPercentInput(String(saved.minPercent));
    } catch (e) {
      setSettings(previous);
      setAmountInput(String(previous.minMonthlyImpactCents / 100));
      setPercentInput(String(previous.minPercent));
      setError(e instanceof Error ? e.message : gt("Failed to save price change settings"));
    }
  }

  if (forbidden || !settings) return null;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">{gt("Price changes")}</h2>
        <T>
          <p className="text-xs text-on-surface-muted mt-1">
            One alert per list-price change on an instance type you run. Turn the{" "}
            <strong>Price changes</strong> trigger on for a channel or your phone above to route it.
          </p>
        </T>
      </div>

      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        <span>{gt("Watch list prices of what we run")}</span>
      </label>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="price-change-min-amount"
            className="block text-xs text-on-surface-tertiary mb-1"
          >
            {gt("Ignore changes under (USD a month)")}
          </label>
          <input
            id="price-change-min-amount"
            type="number"
            min={CENTS.min / 100}
            max={CENTS.max / 100}
            step="0.01"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            onBlur={() => {
              const n = Number(amountInput.trim());
              const cents = Math.round(n * 100);
              if (!Number.isFinite(n) || cents < CENTS.min || cents > CENTS.max) {
                setError(gt("Enter an amount from 0 to 1,000,000."));
                return;
              }
              if (cents !== settings.minMonthlyImpactCents) {
                void save({ minMonthlyImpactCents: cents });
              }
            }}
            className={inputClass}
          />
        </div>
        <div>
          <label
            htmlFor="price-change-min-percent"
            className="block text-xs text-on-surface-tertiary mb-1"
          >
            {gt("Ignore changes under (percent)")}
          </label>
          <input
            id="price-change-min-percent"
            type="number"
            min={PERCENT.min}
            max={PERCENT.max}
            step="0.1"
            value={percentInput}
            onChange={(e) => setPercentInput(e.target.value)}
            onBlur={() => {
              const n = Number(percentInput.trim());
              if (!Number.isFinite(n) || n < PERCENT.min || n > PERCENT.max) {
                setError(gt("Enter a percentage from 0 to 100."));
                return;
              }
              if (n !== settings.minPercent) void save({ minPercent: n });
            }}
            className={inputClass}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={settings.registerExpected}
          onChange={(e) => void save({ registerExpected: e.target.checked })}
        />
        <span>{gt("Mark price increases as expected for anomaly detection")}</span>
      </label>

      {settings.lastNotifiedAt && (
        <p className="text-xs text-on-surface-tertiary">
          {gt("Last price change scan {date}.", {
            date: new Date(settings.lastNotifiedAt).toLocaleString(),
          })}
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  );
}
