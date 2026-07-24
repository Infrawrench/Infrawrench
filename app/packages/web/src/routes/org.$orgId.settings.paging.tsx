import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState, useEffect, useId, isValidElement, cloneElement } from "react";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";
import type { Recipient } from "@infrawrench/ui";

interface PagingSettings {
  enabled: boolean;
  fromNumber: string | null;
  failureThreshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  credentialsConfigured: boolean;
}

export const Route = createFileRoute("/org/$orgId/settings/paging")({
  component: PagingPage,
});

function PagingPage() {
  const { orgId } = useParams({ from: "/org/$orgId/settings/paging" });
  const [settings, setSettings] = useState<PagingSettings | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const [s, r] = await Promise.all([
        apiGet<PagingSettings>(`/api/org/${orgId}/twilio`),
        apiGet<Recipient[]>(`/api/org/${orgId}/twilio/recipients`),
      ]);
      setSettings(s);
      setRecipients(r);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load paging settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  if (loadError) {
    return <p className="text-sm text-red-400">{loadError}</p>;
  }
  if (loading || !settings) {
    return <p className="text-sm text-on-surface-faint">Loading…</p>;
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="text-sm text-on-surface-muted mt-1">
          Alert your team when a resource type fails to sync repeatedly or a budget threshold is
          crossed. Incidents are triggered by the background poller; manual syncs from the UI never
          page. Delivery goes to mobile push (the Infrawrench app) and, when Twilio credentials are
          configured, SMS and voice calls.
        </p>
      </div>

      <SettingsForm orgId={orgId} initial={settings} onSaved={() => void load()} />

      <RecipientsSection orgId={orgId} recipients={recipients} onChanged={() => void load()} />

      <TestSection orgId={orgId} settings={settings} recipientCount={recipients.length} />

      <PushPreferencesSection orgId={orgId} />

      <PushRosterSection orgId={orgId} />
    </div>
  );
}

function SettingsForm({
  orgId,
  initial,
  onSaved,
}: {
  orgId: string;
  initial: PagingSettings;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [fromNumber, setFromNumber] = useState(initial.fromNumber ?? "");
  const [failureThreshold, setFailureThreshold] = useState(initial.failureThreshold);
  const [windowMinutes, setWindowMinutes] = useState(initial.windowMinutes);
  const [cooldownMinutes, setCooldownMinutes] = useState(initial.cooldownMinutes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: Record<string, unknown> = {
        enabled,
        fromNumber: fromNumber.trim() || null,
        failureThreshold,
        windowMinutes,
        cooldownMinutes,
      };
      if (accountSid.trim()) body["accountSid"] = accountSid.trim();
      if (authToken.trim()) body["authToken"] = authToken.trim();
      await apiPut(`/api/org/${orgId}/twilio`, body);
      setAccountSid("");
      setAuthToken("");
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <h2 className="text-sm font-semibold text-on-surface-secondary">Twilio configuration</h2>

      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Paging enabled</span>
      </label>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Account SID">
          <input
            type="text"
            aria-label="Account SID"
            value={accountSid}
            onChange={(e) => setAccountSid(e.target.value)}
            placeholder={initial.credentialsConfigured ? "•••• (stored)" : "ACxxxxxxxx..."}
            className={inputClass}
            autoComplete="off"
          />
        </Field>
        <Field label="Auth Token">
          <input
            type="password"
            aria-label="Auth Token"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder={initial.credentialsConfigured ? "•••• (stored)" : "Token"}
            className={inputClass}
            autoComplete="off"
          />
        </Field>
      </div>

      <Field label="From number (E.164)" hint="The Twilio number SMS and calls originate from.">
        <input
          type="text"
          aria-label="From number (E.164)"
          value={fromNumber}
          onChange={(e) => setFromNumber(e.target.value)}
          placeholder="+15551234567"
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-3 gap-4">
        <Field label="Failures" hint="Distinct sync failures…">
          <input
            type="number"
            min={1}
            aria-label="Failures"
            value={failureThreshold}
            onChange={(e) => setFailureThreshold(parsePositiveInt(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Window (min)" hint="…within this many minutes.">
          <input
            type="number"
            min={1}
            aria-label="Window (min)"
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(parsePositiveInt(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Re-page after (min)" hint="Min interval between re-pages.">
          <input
            type="number"
            min={1}
            aria-label="Re-page after (min)"
            value={cooldownMinutes}
            onChange={(e) => setCooldownMinutes(parsePositiveInt(e.target.value))}
            className={inputClass}
          />
        </Field>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {saved && <p className="text-xs text-green-400">Saved.</p>}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          {saving ? "Saving..." : "Save settings"}
        </button>
      </div>
    </section>
  );
}

function RecipientsSection({
  orgId,
  recipients,
  onChanged,
}: {
  orgId: string;
  recipients: Recipient[];
  onChanged: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [sms, setSms] = useState(true);
  const [voice, setVoice] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/api/org/${orgId}/twilio/recipients`, {
        displayName: displayName.trim(),
        phoneNumber: phoneNumber.trim(),
        sms,
        voice,
      });
      setDisplayName("");
      setPhoneNumber("");
      setSms(true);
      setVoice(true);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add recipient");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await apiDelete(`/api/org/${orgId}/twilio/recipients/${id}`);
    onChanged();
  }

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <h2 className="text-sm font-semibold text-on-surface-secondary">Recipients</h2>

      {recipients.length === 0 ? (
        <p className="text-sm text-on-surface-muted">No recipients yet.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {recipients.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <p className="text-on-surface-secondary">{r.displayName}</p>
                <p className="text-xs text-on-surface-tertiary font-mono">{r.phoneNumber}</p>
              </div>
              <div className="flex items-center gap-3 text-xs text-on-surface-tertiary">
                <span>{r.sms ? "SMS" : ""}</span>
                <span>{r.voice ? "Voice" : ""}</span>
                <button
                  type="button"
                  onClick={() => void handleDelete(r.id)}
                  className="text-red-400 hover:text-red-500 dark:text-red-300"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border/50">
        <Field label="Name">
          <input
            type="text"
            aria-label="Name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="On-call"
            className={inputClass}
          />
        </Field>
        <Field label="Phone (E.164)">
          <input
            type="text"
            aria-label="Phone (E.164)"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+15551234567"
            className={inputClass}
          />
        </Field>
      </div>
      <div className="flex items-center gap-4 text-sm text-on-surface-secondary">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} />
          <span>SMS</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
          <span>Voice call</span>
        </label>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={saving}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          {saving ? "Adding..." : "Add recipient"}
        </button>
      </div>
    </section>
  );
}

function TestSection({
  orgId,
  settings,
  recipientCount,
}: {
  orgId: string;
  settings: PagingSettings;
  recipientCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const ready = settings.credentialsConfigured && settings.fromNumber && recipientCount > 0;

  async function handleTest() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await apiPost<{ recipientCount: number; attempted: number }>(
        `/api/org/${orgId}/twilio/test`,
      );
      setMessage({
        kind: "ok",
        text: `Sent ${r.attempted} message(s) to ${r.recipientCount} recipient(s).`,
      });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-border rounded-xl p-5 space-y-3">
      <h2 className="text-sm font-semibold text-on-surface-secondary">Send test page</h2>
      <p className="text-xs text-on-surface-muted">
        Sends a one-off SMS and/or voice call to every recipient to verify your Twilio setup. Save
        credentials and add at least one recipient first.
      </p>
      {message && (
        <p className={`text-xs ${message.kind === "ok" ? "text-green-400" : "text-red-400"}`}>
          {message.text}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={busy || !ready}
          title={ready ? undefined : "Save Twilio creds and add a recipient first"}
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
        >
          {busy ? "Sending..." : "Send test page"}
        </button>
      </div>
    </section>
  );
}

interface PushDevice {
  id: string;
  platform: "ios" | "android";
  deviceName: string | null;
  lastSeenAt: string;
  disabled: boolean;
}

interface PushPreferences {
  syncIncidents: boolean;
  budgetAlerts: boolean;
}

/**
 * The caller's own mobile push setup: per-org trigger toggles, registered
 * devices, and a test send. Devices are enrolled by signing in on the mobile
 * app — there is nothing to add here, only to review and remove.
 */
function PushPreferencesSection({ orgId }: { orgId: string }) {
  const [prefs, setPrefs] = useState<PushPreferences | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [testBusy, setTestBusy] = useState(false);

  async function load() {
    try {
      const [p, d] = await Promise.all([
        apiGet<PushPreferences>(`/api/org/${orgId}/push/preferences`),
        apiGet<PushDevice[]>(`/api/push/devices`),
      ]);
      setPrefs(p);
      setDevices(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load push settings");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function updatePref(patch: Partial<PushPreferences>) {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      await apiPut(`/api/org/${orgId}/push/preferences`, next);
    } catch (e) {
      setPrefs(prefs);
      setError(e instanceof Error ? e.message : "Failed to save preferences");
    }
  }

  async function handleRemoveDevice(id: string) {
    await apiDelete(`/api/push/devices/${id}`);
    void load();
  }

  async function handleTest() {
    setTestBusy(true);
    setTestMessage(null);
    try {
      const r = await apiPost<{ attempted: number; succeeded: number }>(
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

  if (error) {
    return (
      <section className="border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold text-on-surface-secondary">
          Your mobile notifications
        </h2>
        <p className="text-xs text-red-400 mt-2">{error}</p>
      </section>
    );
  }
  if (!prefs) return null;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <h2 className="text-sm font-semibold text-on-surface-secondary">Your mobile notifications</h2>
      <p className="text-xs text-on-surface-muted">
        Push notifications go to the Infrawrench mobile app. Sign in on your phone to register a
        device; these toggles apply to this organization only.
      </p>

      <div className="flex items-center gap-6 text-sm text-on-surface-secondary">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.syncIncidents}
            onChange={(e) => void updatePref({ syncIncidents: e.target.checked })}
          />
          <span>Sync-failure incidents</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.budgetAlerts}
            onChange={(e) => void updatePref({ budgetAlerts: e.target.checked })}
          />
          <span>Budget alerts</span>
        </label>
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
                  {d.disabled && <span className="text-red-400 ml-2 text-xs">(disabled)</span>}
                </p>
                <p className="text-xs text-on-surface-tertiary">
                  {d.platform} · last seen {new Date(d.lastSeenAt).toLocaleDateString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleRemoveDevice(d.id)}
                className="text-xs text-red-400 hover:text-red-500 dark:text-red-300"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {testMessage && (
        <p className={`text-xs ${testMessage.kind === "ok" ? "text-green-400" : "text-red-400"}`}>
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
    </section>
  );
}

interface PushRecipientRow {
  userId: string;
  email: string;
  displayName: string | null;
  syncIncidents: boolean;
  budgetAlerts: boolean;
  devices: Array<{ id: string; platform: string; deviceName: string | null }>;
}

/** Read-only admin roster of members with at least one active push device. */
function PushRosterSection({ orgId }: { orgId: string }) {
  const [rows, setRows] = useState<PushRecipientRow[] | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    apiGet<PushRecipientRow[]>(`/api/org/${orgId}/push/recipients`)
      .then(setRows)
      // Non-admins get a 403 — just hide the section.
      .catch(() => setForbidden(true));
  }, [orgId]);

  if (forbidden || rows === null) return null;

  return (
    <section className="border border-border rounded-xl p-5 space-y-3">
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
                {[r.syncIncidents && "incidents", r.budgetAlerts && "budgets"]
                  .filter(Boolean)
                  .join(", ") || "all triggers off"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const inputClass =
  "w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong";

/** Parse a positive integer from a numeric input. Falls back to 1 on empty or
 * non-numeric input so transient typing states don't poison the API payload. */
function parsePositiveInt(value: string): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const generatedId = useId();
  const child = isValidElement<{ id?: string }>(children) ? children : null;
  const controlId = child?.props.id ?? generatedId;
  return (
    <div>
      <label htmlFor={controlId} className="block text-xs text-on-surface-tertiary mb-1">
        {label}
      </label>
      {child ? cloneElement(child, { id: controlId }) : children}
      {hint && <p className="text-xs text-on-surface-faint mt-1">{hint}</p>}
    </div>
  );
}
