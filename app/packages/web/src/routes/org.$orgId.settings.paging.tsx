import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState, useEffect } from "react";
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
        <h1 className="text-xl font-semibold">Paging</h1>
        <p className="text-sm text-on-surface-muted mt-1">
          Send SMS and voice calls via Twilio when a resource type fails to sync repeatedly.
          Triggered by the background poller; manual syncs from the UI do not page.
        </p>
      </div>

      <SettingsForm orgId={orgId} initial={settings} onSaved={() => void load()} />

      <RecipientsSection orgId={orgId} recipients={recipients} onChanged={() => void load()} />

      <TestSection orgId={orgId} settings={settings} recipientCount={recipients.length} />
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
  return (
    <div>
      <label className="block text-xs text-on-surface-tertiary mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-on-surface-faint mt-1">{hint}</p>}
    </div>
  );
}
