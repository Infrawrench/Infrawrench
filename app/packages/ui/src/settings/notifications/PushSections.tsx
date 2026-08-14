import { useState, useEffect } from "react";
import { T, useGT } from "gt-react";
import type { AlertTrigger, PushDeviceSummary, PushPreferences } from "@infrawrench/client-core";
import {
  PUSHABLE_TRIGGERS,
  alertTriggerDef,
  pushTriggerEnabled,
  withPushTrigger,
} from "@infrawrench/client-core";
import { useSettingsHost } from "../host.js";
import { useDataString } from "../../i18n/data-strings.js";

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
  const gt = useGT();
  const gtData = useDataString();
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
          setError(e instanceof Error ? e.message : gt("Failed to load push settings"));
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
      setError(e instanceof Error ? e.message : gt("Failed to save preferences"));
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
        text: gt("Delivered {succeeded}/{attempted} test notification(s).", {
          succeeded: r.succeeded,
          attempted: r.attempted,
        }),
      });
    } catch (e) {
      setTestMessage({ kind: "error", text: e instanceof Error ? e.message : gt("Test failed") });
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
          {gt("Your mobile notifications")}
        </h2>
        <p className="text-xs text-danger mt-2">{error}</p>
      </>,
      "",
    );
  }
  if (!prefs) return null;

  return shell(
    <>
      <h2 className="text-sm font-semibold text-on-surface-secondary">
        {gt("Your mobile notifications")}
      </h2>
      <T>
        <p className="text-xs text-on-surface-muted">
          Push notifications go to the Infrawrench mobile app. Sign in on your phone to register a
          device; these toggles apply to this organization only.
        </p>
      </T>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-on-surface-secondary">
        {PUSHABLE_TRIGGERS.map((trigger) => {
          const def = alertTriggerDef(trigger);
          return (
            <label
              key={trigger}
              className="flex items-center gap-2"
              title={gtData(def.description)}
            >
              <input
                type="checkbox"
                checked={pushTriggerEnabled(prefs, trigger)}
                onChange={(e) =>
                  void updatePref({
                    mutedTriggers: withPushTrigger(prefs, trigger, e.target.checked),
                  })
                }
              />
              <span>{gtData(def.label)}</span>
            </label>
          );
        })}
      </div>

      {devices.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          {gt("No devices registered. Sign in on the mobile app to enroll this account.")}
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <p className="text-on-surface-secondary">
                  {d.deviceName ?? (d.platform === "ios" ? "iPhone" : gt("Android device"))}
                  {d.disabled && (
                    <span className="text-danger ml-2 text-xs">{gt("(disabled)")}</span>
                  )}
                </p>
                <p className="text-xs text-on-surface-tertiary">
                  {d.platform} ·{" "}
                  {gt("last seen {date}", { date: new Date(d.lastSeenAt).toLocaleDateString() })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleRemoveDevice(d.id)}
                className="text-xs text-danger hover:text-danger-strong"
              >
                {gt("Remove")}
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
          title={devices.length === 0 ? gt("Register a device on the mobile app first") : undefined}
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
        >
          {testBusy ? gt("Sending...") : gt("Send test push")}
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
  const gt = useGT();
  const gtData = useDataString();
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
      <h2 className="text-sm font-semibold text-on-surface-secondary">
        {gt("Members receiving push")}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          {gt("No members have registered a mobile device yet.")}
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {rows.map((r) => {
            const mutedList = r.mutedTriggers
              .map((t) => gtData(alertTriggerDef(t).label).toLowerCase())
              .join(", ");
            return (
              <li key={r.userId} className="py-2 text-sm">
                <p className="text-on-surface-secondary">{r.displayName ?? r.email}</p>
                <p className="text-xs text-on-surface-tertiary">
                  {gt("{count} device(s)", { count: r.devices.length })} ·{" "}
                  {/* Naming what is *muted* rather than what is on: the list is
                      almost always shorter, and "muted: drift" reads as the
                      exception it is where eleven trigger names read as noise. */}
                  {r.mutedTriggers.length === 0
                    ? gt("all triggers on")
                    : r.mutedTriggers.length === PUSHABLE_TRIGGERS.length
                      ? gt("all triggers off")
                      : gt("muted: {list}", { list: mutedList })}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  if (embedded) {
    return <div className="space-y-3 border-t border-border/50 pt-5">{body}</div>;
  }
  return <section className="border border-border rounded-xl p-5 space-y-3">{body}</section>;
}
