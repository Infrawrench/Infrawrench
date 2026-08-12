import { useState, useEffect } from "react";
import type { DriftAlertSettings } from "@infrawrench/client-core";
import { DRIFT_ALERT_LIMITS } from "@infrawrench/client-core";
import { useSettingsHost } from "../host.js";
import { Field, inputClass, parsePositiveInt } from "./shared.js";

interface AccountOption {
  id: string;
  displayName: string;
}

/**
 * What counts as drift worth notifying about, and how often. Separate from the
 * per-channel `resourceDrift` opt-in above it: that decides *who* hears, this
 * decides *what* and *how often*.
 *
 * The section exists because drift is the one alert whose volume is set by the
 * infrastructure rather than by an exceptional event — a sync pass can record
 * hundreds of changes — so the filter is not a nicety, it is the difference
 * between a digest and a muted integration.
 */
export function DriftAlertsSection({ orgId }: { orgId: string }) {
  const { api, openWorkspace } = useSettingsHost();
  const [settings, setSettings] = useState<DriftAlertSettings | null>(null);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.get<DriftAlertSettings>(`/api/org/${orgId}/changes/alert-settings`);
        if (!cancelled) setSettings(s);
      } catch {
        // Non-admins get a 403 — hide the section rather than show an error.
        if (!cancelled) setForbidden(true);
        return;
      }
      try {
        const rows = await api.get<AccountOption[]>(`/api/org/${orgId}/accounts`);
        if (!cancelled) setAccounts(rows);
      } catch {
        // The scope picker degrades to "all accounts"; the rest still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  async function save(patch: Partial<DriftAlertSettings>) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    try {
      const saved = await api.put<DriftAlertSettings>(
        `/api/org/${orgId}/changes/alert-settings`,
        patch,
      );
      setSettings(saved);
    } catch (e) {
      setSettings(previous);
      setError(e instanceof Error ? e.message : "Failed to save drift alert settings");
    }
  }

  function toggleAccount(accountId: string, checked: boolean) {
    if (!settings) return;
    const next = checked
      ? [...settings.accountIds, accountId]
      : settings.accountIds.filter((id) => id !== accountId);
    void save({ accountIds: next });
  }

  if (forbidden || !settings) return null;

  const { min: cooldownMin, max: cooldownMax } = DRIFT_ALERT_LIMITS.cooldownMinutes;
  const { min: minChangesMin, max: minChangesMax } = DRIFT_ALERT_LIMITS.minChanges;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">Resource drift alerts</h2>
        <p className="text-xs text-on-surface-muted mt-1">
          One batched digest of the{" "}
          <button type="button" onClick={() => openWorkspace("changes")} className="underline">
            change timeline
          </button>{" "}
          per organization per cooldown window — never one message per change. Turn the{" "}
          <strong>Drift</strong> trigger on for a Slack channel, a Teams channel or your phone above
          to receive it; it is off by default everywhere.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-on-surface-secondary">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.notifyCreated}
            onChange={(e) => void save({ notifyCreated: e.target.checked })}
          />
          <span>Resources appearing</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.notifyDeleted}
            onChange={(e) => void save({ notifyDeleted: e.target.checked })}
          />
          <span>Resources disappearing</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.notifyUpdated}
            onChange={(e) => void save({ notifyUpdated: e.target.checked })}
          />
          <span>Field changes</span>
        </label>
      </div>
      <p className="text-xs text-on-surface-tertiary">
        Field changes are off by default: they are the bulk of the volume and are usually a provider
        restating a value rather than someone changing something.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Cooldown (minutes)"
          hint={`At most one drift message per ${cooldownMin}–${cooldownMax} minute window.`}
        >
          <input
            type="number"
            min={cooldownMin}
            max={cooldownMax}
            value={settings.cooldownMinutes}
            onChange={(e) =>
              setSettings({ ...settings, cooldownMinutes: Number(e.target.value) || cooldownMin })
            }
            onBlur={(e) =>
              void save({
                cooldownMinutes: Math.min(
                  Math.max(parsePositiveInt(e.target.value), cooldownMin),
                  cooldownMax,
                ),
              })
            }
            className={inputClass}
          />
        </Field>
        <Field label="Minimum changes" hint="Skip windows smaller than this.">
          <input
            type="number"
            min={minChangesMin}
            max={minChangesMax}
            value={settings.minChanges}
            onChange={(e) =>
              setSettings({ ...settings, minChanges: Number(e.target.value) || minChangesMin })
            }
            onBlur={(e) =>
              void save({
                minChanges: Math.min(
                  Math.max(parsePositiveInt(e.target.value), minChangesMin),
                  minChangesMax,
                ),
              })
            }
            className={inputClass}
          />
        </Field>
      </div>

      {accounts.length > 0 && (
        <div>
          <p className="text-xs text-on-surface-tertiary mb-2">
            Accounts to watch — leave every box unchecked to watch all {accounts.length}.
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-on-surface-secondary">
            {accounts.map((a) => (
              <label key={a.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.accountIds.includes(a.id)}
                  onChange={(e) => toggleAccount(a.id, e.target.checked)}
                />
                <span>{a.displayName}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {settings.lastNotifiedAt && (
        <p className="text-xs text-on-surface-tertiary">
          Last drift digest sent {new Date(settings.lastNotifiedAt).toLocaleString()}.
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  );
}
