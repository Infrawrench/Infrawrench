import { useState } from "react";
import type { Recipient } from "../../api-types.js";
import { useSettingsHost } from "../host.js";
import { Field, inputClass, parsePositiveInt } from "./shared.js";

export interface PagingSettings {
  enabled: boolean;
  fromNumber: string | null;
  failureThreshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  credentialsConfigured: boolean;
}

/**
 * Everything SMS/voice in one place: the Twilio credentials, the recipients they
 * page, and the test send that exercises both. They are one setup — splitting
 * them across cards made the page read as three unrelated features.
 *
 * When `embedded`, this sits in the Connections detail pane (no outer card).
 */
export function TwilioSection({
  orgId,
  settings,
  recipients,
  onChanged,
  embedded = false,
}: {
  orgId: string;
  settings: PagingSettings;
  recipients: Recipient[];
  onChanged: () => void;
  embedded?: boolean;
}) {
  const body = (
    <>
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">SMS &amp; voice</h2>
        <p className="text-xs text-on-surface-muted mt-1">
          Paging over Twilio. Add your credentials, list who should be reached, then send a test to
          confirm the whole path works.
        </p>
      </div>

      <SettingsForm orgId={orgId} initial={settings} onSaved={onChanged} />

      <RecipientsPanel orgId={orgId} recipients={recipients} onChanged={onChanged} />

      <TestPanel orgId={orgId} settings={settings} recipientCount={recipients.length} />
    </>
  );

  if (embedded) {
    return <div className="space-y-5">{body}</div>;
  }
  return <section className="border border-border rounded-xl p-5 space-y-5">{body}</section>;
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
  const { api } = useSettingsHost();
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
      await api.put(`/api/org/${orgId}/twilio`, body);
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
    <div className="space-y-4">
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

      {error && <p className="text-xs text-danger">{error}</p>}
      {saved && <p className="text-xs text-success">Saved.</p>}

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
    </div>
  );
}

function RecipientsPanel({
  orgId,
  recipients,
  onChanged,
}: {
  orgId: string;
  recipients: Recipient[];
  onChanged: () => void;
}) {
  const { api } = useSettingsHost();
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
      await api.post(`/api/org/${orgId}/twilio/recipients`, {
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
    await api.delete(`/api/org/${orgId}/twilio/recipients/${id}`);
    onChanged();
  }

  return (
    <div className="space-y-4 pt-5 border-t border-border/50">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-tertiary">
        Recipients
      </h3>

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
                  className="text-danger hover:text-danger-strong"
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

      {error && <p className="text-xs text-danger">{error}</p>}

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
    </div>
  );
}

function TestPanel({
  orgId,
  settings,
  recipientCount,
}: {
  orgId: string;
  settings: PagingSettings;
  recipientCount: number;
}) {
  const { api } = useSettingsHost();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const ready = settings.credentialsConfigured && settings.fromNumber && recipientCount > 0;

  async function handleTest() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.post<{ recipientCount: number; attempted: number }>(
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
    <div className="space-y-3 pt-5 border-t border-border/50">
      <p className="text-xs text-on-surface-muted">
        Sends a one-off SMS and/or voice call to every recipient to verify your Twilio setup. Save
        credentials and add at least one recipient first.
      </p>
      {message && (
        <p className={`text-xs ${message.kind === "ok" ? "text-success" : "text-danger"}`}>
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
    </div>
  );
}
