import { useState, useEffect } from "react";
import type { AlertTrigger, PushDeviceSummary, PushPreferences } from "@infrawrench/client-core";
import {
  PUSHABLE_TRIGGERS,
  alertTriggerDef,
  pushTriggerEnabled,
  withPushTrigger,
} from "@infrawrench/client-core";
import { useSettingsHost } from "../host.js";

/**
 * The caller's own mobile push setup: per-org trigger toggles, registered
 * devices, and a test send. Devices are enrolled by signing in on the mobile
 * app — there is nothing to add here, only to review and remove.
 */
export function PushPreferencesSection({
  orgId,
  embedded = false,
}: {
  orgId: string;
  embedded?: boolean;
}) {
  const { api } = useSettingsHost();
  const [prefs, setPrefs] = useState<PushPreferences | null>(null);
  const [devices, setDevices] = useState<PushDeviceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [testBusy, setTestBusy] = useState(false);

  // Bumped to re-run the load effect after removing a device.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    // `cancelled` drops a response that lands after `orgId` changed, so a
    // slower earlier request can't overwrite the newer org's preferences.
    let cancelled = false;
    void (async () => {
      try {
        const [p, d] = await Promise.all([
          api.get<PushPreferences>(`/api/org/${orgId}/push/preferences`),
          api.get<PushDeviceSummary[]>(`/api/push/devices`),
        ]);
        if (!cancelled) {
          setPrefs(p);
          setDevices(d);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load push settings");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, reloadNonce]);

  async function updatePref(patch: Partial<PushPreferences>) {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      await api.put(`/api/org/${orgId}/push/preferences`, next);
    } catch (e) {
      setPrefs(prefs);
      setError(e instanceof Error ? e.message : "Failed to save preferences");
    }
  }

  async function handleRemoveDevice(id: string) {
    await api.delete(`/api/push/devices/${id}`);
    setReloadNonce((n) => n + 1);
  }

  async function handleTest() {
    setTestBusy(true);
    setTestMessage(null);
    try {
      const r = await api.post<{ attempted: number; succeeded: number }>(
        `/api/org/${orgId}/push/test`,
      );
      setTestMessage({
        kind: "ok",
        text: `Delivered ${r.succeeded}/${r.attempted} test notification(s).`,
      });
    } catch (e) {
      setTestMessage({ kind: "error", text: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTestBusy(false);
    }
  }

  const shell = (children: React.ReactNode, className = "space-y-4") =>
    embedded ? (
      <div className={className}>{children}</div>
    ) : (
      <section className={`border border-border rounded-xl p-5 ${className}`}>{children}</section>
    );

  if (error) {
    return shell(
      <>
        <h2 className="text-sm font-semibold text-on-surface-secondary">
          Your mobile notifications
        </h2>
        <p className="text-xs text-danger mt-2">{error}</p>
      </>,
      "",
    );
  }
  if (!prefs) return null;

  return shell(
    <>
      <h2 className="text-sm font-semibold text-on-surface-secondary">Your mobile notifications</h2>
      <p className="text-xs text-on-surface-muted">
        Push notifications go to the Infrawrench mobile app. Sign in on your phone to register a
        device; these toggles apply to this organization only.
      </p>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-on-surface-secondary">
        {PUSHABLE_TRIGGERS.map((trigger) => {
          const def = alertTriggerDef(trigger);
          return (
            <label key={trigger} className="flex items-center gap-2" title={def.description}>
              <input
                type="checkbox"
                checked={pushTriggerEnabled(prefs, trigger)}
                onChange={(e) =>
                  void updatePref({
                    mutedTriggers: withPushTrigger(prefs, trigger, e.target.checked),
                  })
                }
              />
              <span>{def.label}</span>
            </label>
          );
        })}
      </div>

      {devices.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No devices registered. Sign in on the mobile app to enroll this account.
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <p className="text-on-surface-secondary">
                  {d.deviceName ?? (d.platform === "ios" ? "iPhone" : "Android device")}
                  {d.disabled && <span className="text-danger ml-2 text-xs">(disabled)</span>}
                </p>
                <p className="text-xs text-on-surface-tertiary">
                  {d.platform} · last seen {new Date(d.lastSeenAt).toLocaleDateString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleRemoveDevice(d.id)}
                className="text-xs text-danger hover:text-danger-strong"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {testMessage && (
        <p className={`text-xs ${testMessage.kind === "ok" ? "text-success" : "text-danger"}`}>
          {testMessage.text}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={testBusy || devices.length === 0}
          title={devices.length === 0 ? "Register a device on the mobile app first" : undefined}
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
        >
          {testBusy ? "Sending..." : "Send test push"}
        </button>
      </div>
    </>,
  );
}

interface PushRecipientRow {
  userId: string;
  email: string;
  displayName: string | null;
  /** Triggers this member has turned off. Everything else reaches them. */
  mutedTriggers: AlertTrigger[];
  devices: Array<{ id: string; platform: string; deviceName: string | null }>;
}

/** Read-only admin roster of members with at least one active push device. */
export function PushRosterSection({
  orgId,
  embedded = false,
}: {
  orgId: string;
  embedded?: boolean;
}) {
  const { api } = useSettingsHost();
  const [rows, setRows] = useState<PushRecipientRow[] | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    api
      .get<PushRecipientRow[]>(`/api/org/${orgId}/push/recipients`)
      .then(setRows)
      // Non-admins get a 403 — just hide the section.
      .catch(() => setForbidden(true));
  }, [orgId]);

  if (forbidden || rows === null) return null;

  const body = (
    <>
      <h2 className="text-sm font-semibold text-on-surface-secondary">Members receiving push</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No members have registered a mobile device yet.
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {rows.map((r) => (
            <li key={r.userId} className="py-2 text-sm">
              <p className="text-on-surface-secondary">{r.displayName ?? r.email}</p>
              <p className="text-xs text-on-surface-tertiary">
                {r.devices.length} device(s) ·{" "}
                {/* Naming what is *muted* rather than what is on: the list is
                    almost always shorter, and "muted: drift" reads as the
                    exception it is where eleven trigger names read as noise. */}
                {r.mutedTriggers.length === 0
                  ? "all triggers on"
                  : r.mutedTriggers.length === PUSHABLE_TRIGGERS.length
                    ? "all triggers off"
                    : `muted: ${r.mutedTriggers.map((t) => alertTriggerDef(t).label.toLowerCase()).join(", ")}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  if (embedded) {
    return <div className="space-y-3 border-t border-border/50 pt-5">{body}</div>;
  }
  return <section className="border border-border rounded-xl p-5 space-y-3">{body}</section>;
}
