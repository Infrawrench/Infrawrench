import { useState, useEffect } from "react";
import type { SlackAvailableChannel, SlackStatus } from "@infrawrench/client-core";
import { useSettingsHost } from "../host.js";
import { Field, inputClass } from "./shared.js";

/** The Slack mark, from Slack's brand assets. */
export function SlackMark({ className }: { className?: string }) {
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

/**
 * Slack connection + per-channel alert routing. The install is a normal
 * "Add to Slack" OAuth round-trip; the callback lands back on this page with
 * `?slack=connected`, which the banner below reports.
 */
export function SlackSection({ orgId, embedded = false }: { orgId: string; embedded?: boolean }) {
  const { api, openExternal } = useSettingsHost();
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
      setStatus(await api.get<SlackStatus>(`/api/org/${orgId}/slack/status`));
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
      const { url } = await api.get<{ url: string }>(`/api/org/${orgId}/slack/install-url`);
      // Web: same-tab redirect (the OAuth callback lands back on this page).
      // Desktop: system browser — the callback finishes on the web app, and
      // this card shows the connected state on the next load.
      openExternal(url, { sameTab: true });
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the Slack install");
      setBusy(false);
    }
  }

  async function handleDisconnect(installationId: string) {
    await api.delete(`/api/org/${orgId}/slack/installations/${installationId}`);
    void load();
  }

  async function handleRemoveChannel(id: string) {
    await api.delete(`/api/org/${orgId}/slack/channels/${id}`);
    void load();
  }

  async function handleTest() {
    setBusy(true);
    setTestMessage(null);
    try {
      const r = await api.post<{ channelCount: number; succeeded: number }>(
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

  const shell = (children: React.ReactNode, className = "space-y-4") =>
    embedded ? (
      <div className={className}>{children}</div>
    ) : (
      <section className={`border border-border rounded-xl p-5 ${className}`}>{children}</section>
    );

  if (!status) {
    return shell(
      <>
        <h2 className="text-sm font-semibold text-on-surface-secondary">Slack</h2>
        {error ? (
          <p className="text-xs text-danger">{error}</p>
        ) : (
          <p className="text-sm text-on-surface-faint">Loading…</p>
        )}
      </>,
      "space-y-2",
    );
  }

  const install = status.installations[0] ?? null;

  return shell(
    <>
      <div className="flex items-center gap-2">
        <SlackMark className="w-4 h-4" />
        <h2 className="text-sm font-semibold text-on-surface-secondary">Slack</h2>
      </div>

      {installResult === "connected" && (
        <p className="text-xs text-success">Slack workspace connected.</p>
      )}
      {installResult === "cancelled" && (
        <p className="text-xs text-on-surface-muted">Slack install was cancelled.</p>
      )}
      {installResult === "linked" && (
        <p className="text-xs text-success">
          Your Slack account is linked. You can now run /infrawrench commands and decide approvals
          from Slack.
        </p>
      )}
      {installResult === "error" && (
        <p className="text-xs text-danger">
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
              className="text-xs text-danger hover:text-danger-strong"
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
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-on-surface-tertiary">
                    <button
                      type="button"
                      onClick={() => void handleRemoveChannel(ch.id)}
                      className="text-danger hover:text-danger-strong"
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

          {error && <p className="text-xs text-danger">{error}</p>}
          {testMessage && (
            <p className={`text-xs ${testMessage.kind === "ok" ? "text-success" : "text-danger"}`}>
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
    </>,
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
  const { api } = useSettingsHost();
  const [available, setAvailable] = useState<SlackAvailableChannel[] | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadChannels() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<{ channels: SlackAvailableChannel[] }>(
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
      await api.post(`/api/org/${orgId}/slack/channels`, {
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
        {error && <p className="text-xs text-danger mt-2">{error}</p>}
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
      {error && <p className="text-xs text-danger">{error}</p>}
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
