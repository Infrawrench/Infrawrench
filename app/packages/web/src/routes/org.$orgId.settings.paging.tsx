import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState, useEffect, useId, isValidElement, cloneElement } from "react";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from "@/lib/api";
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
          Alert your team when a resource type fails to sync repeatedly, a budget threshold is
          crossed, or a workflow calls <code>infra.page()</code>. Incidents are triggered by the
          background poller; manual syncs from the UI never page. Delivery goes to mobile push (the
          Infrawrench app), any Slack channels you connect below, and — when Twilio credentials are
          configured — SMS and voice calls.
        </p>
      </div>

      <SlackSection orgId={orgId} />

      <PushPreferencesSection orgId={orgId} />

      <PushRosterSection orgId={orgId} />

      <TwilioSection
        orgId={orgId}
        settings={settings}
        recipients={recipients}
        onChanged={() => void load()}
      />
    </div>
  );
}

/**
 * Everything SMS/voice in one card: the Twilio credentials, the recipients they
 * page, and the test send that exercises both. They are one setup — splitting
 * them across cards made the page read as three unrelated features.
 */
function TwilioSection({
  orgId,
  settings,
  recipients,
  onChanged,
}: {
  orgId: string;
  settings: PagingSettings;
  recipients: Recipient[];
  onChanged: () => void;
}) {
  return (
    <section className="border border-border rounded-xl p-5 space-y-5">
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
    </section>
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
    </div>
  );
}

interface SlackInstallation {
  id: string;
  teamId: string;
  teamName: string | null;
}

interface SlackChannel {
  id: string;
  installationId: string;
  channelId: string;
  channelName: string;
  isPrivate: boolean;
  syncIncidents: boolean;
  budgetAlerts: boolean;
  workflowPages: boolean;
}

interface SlackStatus {
  configured: boolean;
  installations: SlackInstallation[];
  channels: SlackChannel[];
}

interface AvailableChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

/** The Slack mark, from Slack's brand assets. */
function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 127 127" className={className} aria-hidden="true" focusable="false">
      <path
        d="M27.2 80c0 7.3-5.9 13.2-13.2 13.2C6.7 93.2.8 87.3.8 80c0-7.3 5.9-13.2 13.2-13.2h13.2V80zm6.6 0c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2v33c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V80z"
        fill="#E01E5A"
      />
      <path
        d="M47 27c-7.3 0-13.2-5.9-13.2-13.2C33.8 6.5 39.7.6 47 .6c7.3 0 13.2 5.9 13.2 13.2V27H47zm0 6.7c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H13.9C6.6 60.1.7 54.2.7 46.9c0-7.3 5.9-13.2 13.2-13.2H47z"
        fill="#36C5F0"
      />
      <path
        d="M99.9 46.9c0-7.3 5.9-13.2 13.2-13.2 7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H99.9V46.9zm-6.6 0c0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V13.8C66.9 6.5 72.8.6 80.1.6c7.3 0 13.2 5.9 13.2 13.2v33.1z"
        fill="#2EB67D"
      />
      <path
        d="M80.1 99.8c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2-7.3 0-13.2-5.9-13.2-13.2V99.8h13.2zm0-6.6c-7.3 0-13.2-5.9-13.2-13.2 0-7.3 5.9-13.2 13.2-13.2h33.1c7.3 0 13.2 5.9 13.2 13.2 0 7.3-5.9 13.2-13.2 13.2H80.1z"
        fill="#ECB22E"
      />
    </svg>
  );
}

const SLACK_TRIGGERS = [
  { key: "syncIncidents", label: "Sync failures" },
  { key: "budgetAlerts", label: "Budgets" },
  { key: "workflowPages", label: "Workflow pages" },
] as const;

/**
 * Slack connection + per-channel alert routing. The install is a normal
 * "Add to Slack" OAuth round-trip; the callback lands back on this page with
 * `?slack=connected`, which the banner below reports.
 */
function SlackSection({ orgId }: { orgId: string }) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testMessage, setTestMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  // The OAuth callback redirects here with a result; show it, then drop the
  // param so a refresh doesn't repeat the banner.
  const [installResult, setInstallResult] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("slack");
    if (!result) return;
    setInstallResult(result);
    params.delete("slack");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, []);

  async function load() {
    try {
      setStatus(await apiGet<SlackStatus>(`/api/org/${orgId}/slack/status`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Slack settings");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await apiGet<{ url: string }>(`/api/org/${orgId}/slack/install-url`);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the Slack install");
      setBusy(false);
    }
  }

  async function handleDisconnect(installationId: string) {
    await apiDelete(`/api/org/${orgId}/slack/installations/${installationId}`);
    void load();
  }

  async function handleToggle(channel: SlackChannel, patch: Partial<SlackChannel>) {
    // Optimistic — the checkbox should not lag a round-trip.
    setStatus((prev) =>
      prev
        ? {
            ...prev,
            channels: prev.channels.map((c) => (c.id === channel.id ? { ...c, ...patch } : c)),
          }
        : prev,
    );
    try {
      await apiPatch(`/api/org/${orgId}/slack/channels/${channel.id}`, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update the channel");
      void load();
    }
  }

  async function handleRemoveChannel(id: string) {
    await apiDelete(`/api/org/${orgId}/slack/channels/${id}`);
    void load();
  }

  async function handleTest() {
    setBusy(true);
    setTestMessage(null);
    try {
      const r = await apiPost<{ channelCount: number; succeeded: number }>(
        `/api/org/${orgId}/slack/test`,
      );
      setTestMessage({
        kind: "ok",
        text: `Posted to ${r.succeeded}/${r.channelCount} channel(s).`,
      });
    } catch (e) {
      setTestMessage({ kind: "error", text: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <section className="border border-border rounded-xl p-5 space-y-2">
        <h2 className="text-sm font-semibold text-on-surface-secondary">Slack</h2>
        {error ? (
          <p className="text-xs text-red-400">{error}</p>
        ) : (
          <p className="text-sm text-on-surface-faint">Loading…</p>
        )}
      </section>
    );
  }

  const install = status.installations[0] ?? null;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <SlackMark className="w-4 h-4" />
        <h2 className="text-sm font-semibold text-on-surface-secondary">Slack</h2>
      </div>

      {installResult === "connected" && (
        <p className="text-xs text-green-400">Slack workspace connected.</p>
      )}
      {installResult === "cancelled" && (
        <p className="text-xs text-on-surface-muted">Slack install was cancelled.</p>
      )}
      {installResult === "error" && (
        <p className="text-xs text-red-400">
          The Slack install didn&apos;t complete. Try connecting again.
        </p>
      )}

      {!status.configured ? (
        <p className="text-sm text-on-surface-muted">
          Slack isn&apos;t set up on this server. An administrator needs to register a Slack app and
          set <code>SLACK_CLIENT_ID</code> and <code>SLACK_CLIENT_SECRET</code>.
        </p>
      ) : !install ? (
        <>
          <p className="text-xs text-on-surface-muted">
            Connect a workspace, then pick the channels each kind of alert should go to.
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleConnect()}
              disabled={busy}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium border border-border-strong hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
            >
              <SlackMark className="w-4 h-4" />
              {busy ? "Opening Slack…" : "Add to Slack"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between text-sm">
            <p className="text-on-surface-secondary">
              Connected to <span className="font-medium">{install.teamName ?? install.teamId}</span>
            </p>
            <button
              type="button"
              onClick={() => void handleDisconnect(install.id)}
              className="text-xs text-red-400 hover:text-red-500 dark:text-red-300"
            >
              Disconnect
            </button>
          </div>

          {status.channels.length === 0 ? (
            <p className="text-sm text-on-surface-muted">
              No channels yet. Add one below to start receiving alerts.
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {status.channels.map((ch) => (
                <li
                  key={ch.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
                >
                  <p className="text-on-surface-secondary font-mono">
                    #{ch.channelName}
                    {ch.isPrivate && (
                      <span className="ml-2 text-xs font-sans text-on-surface-tertiary">
                        private
                      </span>
                    )}
                  </p>
                  <div className="flex items-center gap-4 text-xs text-on-surface-tertiary">
                    {SLACK_TRIGGERS.map((t) => (
                      <label key={t.key} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={ch[t.key]}
                          onChange={(e) => void handleToggle(ch, { [t.key]: e.target.checked })}
                        />
                        <span>{t.label}</span>
                      </label>
                    ))}
                    <button
                      type="button"
                      onClick={() => void handleRemoveChannel(ch.id)}
                      className="text-red-400 hover:text-red-500 dark:text-red-300"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <AddSlackChannel
            orgId={orgId}
            installationId={install.id}
            existing={status.channels.map((c) => c.channelId)}
            onAdded={() => void load()}
          />

          <p className="text-xs text-on-surface-faint">
            Public channels work as soon as you add them. For a private channel, invite the
            Infrawrench app to it in Slack first — otherwise posting fails with{" "}
            <code>not_in_channel</code>.
          </p>

          {error && <p className="text-xs text-red-400">{error}</p>}
          {testMessage && (
            <p
              className={`text-xs ${testMessage.kind === "ok" ? "text-green-400" : "text-red-400"}`}
            >
              {testMessage.text}
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={busy || status.channels.length === 0}
              title={status.channels.length === 0 ? "Add a channel first" : undefined}
              className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
            >
              {busy ? "Posting…" : "Send test message"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Channel picker. Channels come from Slack's conversations.list, so nobody has
 * to know a channel id — the list is fetched lazily on first open because a
 * large workspace makes it a slow call.
 */
function AddSlackChannel({
  orgId,
  installationId,
  existing,
  onAdded,
}: {
  orgId: string;
  installationId: string;
  existing: string[];
  onAdded: () => void;
}) {
  const [available, setAvailable] = useState<AvailableChannel[] | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadChannels() {
    setLoading(true);
    setError(null);
    try {
      const r = await apiGet<{ channels: AvailableChannel[] }>(
        `/api/org/${orgId}/slack/installations/${installationId}/available-channels`,
      );
      setAvailable(r.channels);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to list Slack channels");
      setAvailable([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    const channel = available?.find((c) => c.id === selected);
    if (!channel) return;
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/api/org/${orgId}/slack/channels`, {
        installationId,
        channelId: channel.id,
        channelName: channel.name,
        isPrivate: channel.isPrivate,
      });
      setSelected("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add the channel");
    } finally {
      setSaving(false);
    }
  }

  if (available === null) {
    return (
      <div className="pt-2 border-t border-border/50">
        <button
          type="button"
          onClick={() => void loadChannels()}
          disabled={loading}
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
        >
          {loading ? "Loading channels…" : "Add a channel"}
        </button>
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
      </div>
    );
  }

  const options = available.filter((c) => !existing.includes(c.id));

  return (
    <div className="pt-2 border-t border-border/50 space-y-2">
      <Field label="Channel">
        <select
          aria-label="Channel"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className={inputClass}
        >
          <option value="">Select a channel…</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
              {c.isPrivate ? " (private)" : ""}
            </option>
          ))}
        </select>
      </Field>
      {options.length === 0 && (
        <p className="text-xs text-on-surface-faint">
          Every channel the app can see is already routed here.
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={saving || !selected}
          className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          {saving ? "Adding…" : "Add channel"}
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
    <div className="space-y-3 pt-5 border-t border-border/50">
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
    </div>
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
  /** Alerts raised by a workflow calling `infra.page(...)`. */
  workflowPages: boolean;
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
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.workflowPages}
            onChange={(e) => void updatePref({ workflowPages: e.target.checked })}
          />
          <span>Workflow pages</span>
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
  workflowPages: boolean;
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
                {[
                  r.syncIncidents && "incidents",
                  r.budgetAlerts && "budgets",
                  r.workflowPages && "workflow pages",
                ]
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
