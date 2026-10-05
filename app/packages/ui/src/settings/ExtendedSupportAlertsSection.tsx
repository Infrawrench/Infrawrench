import { useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import { EXTENDED_SUPPORT_LIMITS, type ExtendedSupportSettings } from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

const inputClass =
  "w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong";

const { min: MIN_LEAD, max: MAX_LEAD } = EXTENDED_SUPPORT_LIMITS.leadDays;

/**
 * Org-level extended-support settings: the weekly alert switch and how far
 * ahead upcoming surcharges are listed in Costs → Extended support. Who hears
 * the alert is the "Extended support" routing trigger above; upcoming
 * surcharges also appear on the expiry radar, under its own alert.
 */
export function ExtendedSupportAlertsSection() {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [settings, setSettings] = useState<ExtendedSupportSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [leadDaysInput, setLeadDaysInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .get<ExtendedSupportSettings>(`/api/org/${orgId}/extended-support/settings`)
      .then((s) => {
        if (!cancelled) {
          setSettings(s);
          setLeadDaysInput(String(s.leadDays));
        }
      })
      .catch(() => {
        // Non-admins get a 403: hide the section rather than show an error.
        if (!cancelled) setForbidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);

  async function save(patch: { enabled?: boolean; leadDays?: number }) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    try {
      const saved = await api.put<ExtendedSupportSettings>(
        `/api/org/${orgId}/extended-support/settings`,
        patch,
      );
      setSettings(saved);
      setLeadDaysInput(String(saved.leadDays));
    } catch (e) {
      setSettings(previous);
      setLeadDaysInput(String(previous.leadDays));
      setError(e instanceof Error ? e.message : gt("Failed to save extended support settings"));
    }
  }

  if (forbidden || !settings) return null;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">
          {gt("Extended support")}
        </h2>
        <T>
          <p className="text-xs text-on-surface-muted mt-1">
            A weekly alert listing resources on paid extended support or past end of support, with
            upgrade savings. Turn the <strong>Extended support</strong> trigger on for a channel or
            your phone above to route it.
          </p>
        </T>
      </div>

      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        <span>{gt("Send the weekly extended support alert")}</span>
      </label>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="extended-support-lead-days"
            className="block text-xs text-on-surface-tertiary mb-1"
          >
            {gt("List upcoming surcharges (days ahead)")}
          </label>
          <input
            id="extended-support-lead-days"
            type="number"
            min={MIN_LEAD}
            max={MAX_LEAD}
            value={leadDaysInput}
            onChange={(e) => setLeadDaysInput(e.target.value)}
            onBlur={() => {
              const n = Number(leadDaysInput.trim());
              if (!Number.isInteger(n) || n < MIN_LEAD || n > MAX_LEAD) {
                setError(gt("Enter a whole number of days from 1 to 365."));
                return;
              }
              if (n !== settings.leadDays) void save({ leadDays: n });
            }}
            className={inputClass}
          />
          <p className="text-xs text-on-surface-faint mt-1">
            {gt("How early a surcharge that has not started yet is listed, 1–365.")}
          </p>
        </div>
      </div>

      {settings.lastNotifiedAt && (
        <p className="text-xs text-on-surface-tertiary">
          {gt("Last extended support scan {date}.", {
            date: new Date(settings.lastNotifiedAt).toLocaleString(),
          })}
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  );
}
