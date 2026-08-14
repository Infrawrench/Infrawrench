import { useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import type { ExpirySettings } from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

const inputClass =
  "w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong";

/**
 * Org-level Expiry radar settings: the alert on/off switch and the lead time.
 * The lead time does double duty — it bounds the feed's "upcoming" bucket on
 * the Expiring screen and decides how early the poller may alert. Who hears
 * the alert is the per-channel "Expiry alerts" trigger above, same split as
 * drift.
 */
export function ExpiryAlertsSection() {
  const gt = useGT();
  const { orgId, api, openWorkspace } = useSettingsHost();
  const [settings, setSettings] = useState<ExpirySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // Raw text while editing so empty / intermediate values don't snap back
  // to the saved integer on every keystroke.
  const [leadDaysInput, setLeadDaysInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get<ExpirySettings>(`/api/org/${orgId}/expiring/settings`)
      .then((s) => {
        if (!cancelled) {
          setSettings(s);
          setLeadDaysInput(String(s.leadDays));
        }
      })
      .catch(() => {
        // Non-admins get a 403 — hide the section rather than show an error.
        if (!cancelled) setForbidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);

  useEffect(() => {
    if (settings) setLeadDaysInput(String(settings.leadDays));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.leadDays]);

  async function save(patch: { enabled?: boolean; leadDays?: number }) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    try {
      const saved = await api.put<ExpirySettings>(`/api/org/${orgId}/expiring/settings`, patch);
      setSettings(saved);
    } catch (e) {
      setSettings(previous);
      setError(e instanceof Error ? e.message : gt("Failed to save expiry alert settings"));
    }
  }

  if (forbidden || !settings) return null;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">{gt("Expiry radar")}</h2>
        <T>
          <p className="text-xs text-on-surface-muted mt-1">
            Alerts for certificates, domains, tokens and keys approaching expiry — the deadlines the{" "}
            <button type="button" onClick={() => openWorkspace("expiring")} className="underline">
              Expiring screen
            </button>{" "}
            tracks. Turn the <strong>Expiry alerts</strong> trigger on for a channel or your phone
            above to route them.
          </p>
        </T>
      </div>

      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        <span>{gt("Send expiry alerts")}</span>
      </label>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="expiry-lead-days" className="block text-xs text-on-surface-tertiary mb-1">
            {gt("Lead time (days)")}
          </label>
          <input
            id="expiry-lead-days"
            type="number"
            min={1}
            max={365}
            value={leadDaysInput}
            onChange={(e) => setLeadDaysInput(e.target.value)}
            onBlur={() => {
              const raw = leadDaysInput.trim();
              const n = raw === "" ? Number.NaN : Number(raw);
              const clamped = Number.isInteger(n) ? Math.min(Math.max(n, 1), 365) : 60;
              setLeadDaysInput(String(clamped));
              void save({ leadDays: clamped });
            }}
            className={inputClass}
          />
          <p className="text-xs text-on-surface-faint mt-1">
            {gt("How early a deadline counts as upcoming and becomes alertable, 1–365.")}
          </p>
        </div>
      </div>

      {settings.lastNotifiedAt && (
        <p className="text-xs text-on-surface-tertiary">
          {gt("Last expiry alert sent {date}.", {
            date: new Date(settings.lastNotifiedAt).toLocaleString(),
          })}
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  );
}
