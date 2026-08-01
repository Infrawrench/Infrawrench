import { useEffect, useState } from "react";
import { apiGet, apiPut } from "@/lib/api";
import type { ExpirySettings } from "@infrawrench/ui";

const inputClass =
  "w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong";

/**
 * Org-level Expiry radar settings: the alert on/off switch and the lead time.
 * The lead time does double duty — it bounds the feed's "upcoming" bucket on
 * the Expiring screen and decides how early the poller may alert. Who hears
 * the alert is the per-channel "Expiry alerts" trigger above, same split as
 * drift.
 */
export function ExpiryAlertsSection({ orgId }: { orgId: string }) {
  const [settings, setSettings] = useState<ExpirySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<ExpirySettings>(`/api/org/${orgId}/expiring/settings`)
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {
        // Non-admins get a 403 — hide the section rather than show an error.
        if (!cancelled) setForbidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  async function save(patch: { enabled?: boolean; leadDays?: number }) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    try {
      const saved = await apiPut<ExpirySettings>(`/api/org/${orgId}/expiring/settings`, patch);
      setSettings(saved);
    } catch (e) {
      setSettings(previous);
      setError(e instanceof Error ? e.message : "Failed to save expiry alert settings");
    }
  }

  if (forbidden || !settings) return null;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">Expiry radar</h2>
        <p className="text-xs text-on-surface-muted mt-1">
          Alerts for certificates, domains, tokens and keys approaching expiry — the deadlines the{" "}
          <a href={`/org/${orgId}/expiring`} className="underline">
            Expiring screen
          </a>{" "}
          tracks. Turn the <strong>Expiry alerts</strong> trigger on for a channel or your phone
          above to route them.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        <span>Send expiry alerts</span>
      </label>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="expiry-lead-days" className="block text-xs text-on-surface-tertiary mb-1">
            Lead time (days)
          </label>
          <input
            id="expiry-lead-days"
            type="number"
            min={1}
            max={365}
            value={settings.leadDays}
            onChange={(e) =>
              setSettings({ ...settings, leadDays: Number(e.target.value) || settings.leadDays })
            }
            onBlur={(e) => {
              const n = Number(e.target.value);
              const clamped = Number.isInteger(n) ? Math.min(Math.max(n, 1), 365) : 60;
              void save({ leadDays: clamped });
            }}
            className={inputClass}
          />
          <p className="text-xs text-on-surface-faint mt-1">
            How early a deadline counts as upcoming and becomes alertable, 1–365.
          </p>
        </div>
      </div>

      {settings.lastNotifiedAt && (
        <p className="text-xs text-on-surface-tertiary">
          Last expiry alert sent {new Date(settings.lastNotifiedAt).toLocaleString()}.
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
