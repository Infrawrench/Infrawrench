import { useState, useEffect, useCallback } from "react";
import type {
  DigestEmailRecipient,
  DigestSendResult,
  DigestSettings,
  DigestSettingsPatch,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

/**
 * The weekly digest's org-level settings: the on/off switch, the send
 * day/hour/timezone, the AI-narrative opt-in, the email recipient list, and the
 * outcome of the last delivery attempt.
 *
 * That last part is the point of the status block below. The digest is sent by
 * a background poller, so without a surface here a failing digest is a log line
 * nobody reads — the exact failure mode KNOWLEDGE.md warns about for the
 * poller's sync errors. Slack and Teams routing stays on the channel rows
 * above; this section owns everything that is org-wide.
 */

/** Days of the week, ISO-numbered (1 = Monday) to match the API. */
const DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
] as const;

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * The zone list comes from the browser's own tz database via
 * `Intl.supportedValuesOf`, so it never goes stale and costs no bundle weight.
 * Older engines without it fall back to a plain text input plus UTC, and the
 * server validates either way.
 */
function supportedTimeZones(): string[] | null {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  if (typeof supportedValuesOf !== "function") return null;
  try {
    const zones = supportedValuesOf("timeZone");
    return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    return null;
  }
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** The last-attempt banner: colour, headline, detail. */
function statusView(settings: DigestSettings): {
  tone: "ok" | "warn" | "error" | "muted";
  headline: string;
} | null {
  switch (settings.lastStatus) {
    case "succeeded":
      return { tone: "ok", headline: "Last digest delivered to every destination." };
    case "partial":
      return { tone: "warn", headline: "Last digest only partly delivered." };
    case "failed":
      return { tone: "error", headline: "Last digest failed to send." };
    case "no_targets":
      return { tone: "warn", headline: "The digest has nowhere to go." };
    case "pending":
      return { tone: "muted", headline: "A digest is being sent…" };
    default:
      return null;
  }
}

const TONE_CLASS = {
  ok: "text-green-400",
  warn: "text-amber-400",
  error: "text-red-400",
  muted: "text-on-surface-tertiary",
} as const;

export function WeeklyDigestSection() {
  const { orgId, api } = useSettingsHost();
  const [settings, setSettings] = useState<DigestSettings | null>(null);
  const [recipients, setRecipients] = useState<DigestEmailRecipient[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendMessage, setSendMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [newEmail, setNewEmail] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [recipientError, setRecipientError] = useState<string | null>(null);

  // Bumped to re-run the load effect after a "Send now" refreshes the status.
  const [reloadNonce, setReloadNonce] = useState(0);

  const zones = supportedTimeZones();

  useEffect(() => {
    // `cancelled` drops a response that lands after `orgId` changed, so a
    // slower earlier request can't overwrite the newer org's settings.
    let cancelled = false;
    void (async () => {
      try {
        const [next, list] = await Promise.all([
          api.get<DigestSettings>(`/api/org/${orgId}/digest`),
          api.get<{ recipients: DigestEmailRecipient[] }>(`/api/org/${orgId}/digest/recipients`),
        ]);
        if (!cancelled) {
          setSettings(next);
          setRecipients(list.recipients);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load digest settings");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, reloadNonce]);

  const save = useCallback(
    async (patch: DigestSettingsPatch) => {
      if (!settings) return;
      const previous = settings;
      // Optimistic, then reconciled with the server's answer — the server
      // recomputes `lastSentWeekStart` when the schedule moves, so the
      // response is the truth.
      setSettings({ ...settings, ...patch } as DigestSettings);
      setError(null);
      try {
        setSettings(await api.put<DigestSettings>(`/api/org/${orgId}/digest`, patch));
      } catch (e) {
        setSettings(previous);
        setError(e instanceof Error ? e.message : "Failed to save digest settings");
      }
    },
    [api, orgId, settings],
  );

  async function handleSendNow() {
    setSendBusy(true);
    setSendMessage(null);
    try {
      const r = await api.post<DigestSendResult>(`/api/org/${orgId}/digest/send`);
      setSendMessage({
        kind: "ok",
        text: `Sent to ${r.succeeded}/${r.attempted} destination(s) — Slack ${r.slack.succeeded}/${r.slack.attempted}, Teams ${r.teams.succeeded}/${r.teams.attempted}, email ${r.email.succeeded}/${r.email.attempted}.`,
      });
      setReloadNonce((n) => n + 1);
    } catch (e) {
      setSendMessage({ kind: "error", text: e instanceof Error ? e.message : "Send failed" });
    } finally {
      setSendBusy(false);
    }
  }

  async function handleAddRecipient() {
    const email = newEmail.trim();
    if (!email) return;
    setAddBusy(true);
    setRecipientError(null);
    try {
      const added = await api.post<DigestEmailRecipient>(`/api/org/${orgId}/digest/recipients`, {
        email,
      });
      setRecipients((list) =>
        [...list.filter((r) => r.id !== added.id), added].sort((a, b) =>
          a.email.localeCompare(b.email),
        ),
      );
      setNewEmail("");
    } catch (e) {
      setRecipientError(e instanceof Error ? e.message : "Failed to add the recipient");
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRemoveRecipient(id: string) {
    const previous = recipients;
    setRecipients((list) => list.filter((r) => r.id !== id));
    try {
      await api.delete(`/api/org/${orgId}/digest/recipients/${id}`);
    } catch (e) {
      setRecipients(previous);
      setRecipientError(e instanceof Error ? e.message : "Failed to remove the recipient");
    }
  }

  if (!settings) {
    return (
      <section className="border border-border rounded-xl p-5 space-y-2">
        <h2 className="text-sm font-semibold text-on-surface-secondary">Weekly digest</h2>
        {error ? (
          <p className="text-xs text-red-400">{error}</p>
        ) : (
          <p className="text-sm text-on-surface-faint">Loading…</p>
        )}
      </section>
    );
  }

  const dayLabel = DAYS.find((d) => d.value === settings.sendDay)?.label ?? "Monday";
  const status = statusView(settings);

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <h2 className="text-sm font-semibold text-on-surface-secondary">Weekly digest</h2>
      <p className="text-xs text-on-surface-muted">
        A summary of last week: total spend with week-over-week movers by provider and service, sync
        incidents, and resources added or removed. It always covers the last complete
        Monday-to-Sunday week in the time zone below, and goes to the Slack and Teams channels above
        that have <strong>Weekly digest</strong> ticked, plus any email recipients you add here.
      </p>

      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        <span>Send a weekly digest</span>
      </label>

      {/* Schedule */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-on-surface-muted">
          <span>Send on</span>
          <select
            value={settings.sendDay}
            onChange={(e) => void save({ sendDay: Number(e.target.value) as 1 })}
            className="px-2 py-1.5 text-sm bg-surface-overlay border border-border rounded-lg text-on-surface-secondary"
          >
            {DAYS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-muted">
          <span>at</span>
          <select
            value={settings.sendHour}
            onChange={(e) => void save({ sendHour: Number(e.target.value) })}
            className="px-2 py-1.5 text-sm bg-surface-overlay border border-border rounded-lg text-on-surface-secondary"
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-on-surface-muted flex-1 min-w-48">
          <span>Time zone</span>
          {zones ? (
            <select
              value={settings.timezone}
              onChange={(e) => void save({ timezone: e.target.value })}
              className="w-full px-2 py-1.5 text-sm bg-surface-overlay border border-border rounded-lg text-on-surface-secondary"
            >
              {zones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              defaultValue={settings.timezone}
              onBlur={(e) => {
                if (e.target.value !== settings.timezone) void save({ timezone: e.target.value });
              }}
              placeholder="UTC"
              className="w-full px-2 py-1.5 text-sm bg-surface-overlay border border-border rounded-lg text-on-surface-secondary"
            />
          )}
        </label>
      </div>
      <p className="text-xs text-on-surface-tertiary">
        Sends every {dayLabel} at {hourLabel(settings.sendHour)} {settings.timezone}.
        Daylight-saving changes are handled for you — the digest keeps its local send time.
      </p>

      {/* AI narrative */}
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
          <input
            type="checkbox"
            checked={settings.narrativeEnabled}
            disabled={!settings.narrativeAvailable}
            onChange={(e) => void save({ narrativeEnabled: e.target.checked })}
          />
          <span>Add an AI-written summary paragraph</span>
        </label>
        <p className="text-xs text-on-surface-muted">
          {settings.narrativeAvailable
            ? "A short paragraph above the numbers saying what changed and why it stands out. Only the digest's own figures are sent to the model — never resource or credential data. If it fails, the digest still sends without it."
            : "Unavailable: this deployment has no LLM API key configured."}
        </p>
      </div>

      {/* Email recipients */}
      <div className="space-y-2 border-t border-border pt-4">
        <h3 className="text-xs font-semibold text-on-surface-secondary">Email recipients</h3>
        {!settings.emailAvailable && (
          <p className="text-xs text-amber-400">
            This deployment has no mail provider configured, so email recipients will not receive
            anything.
          </p>
        )}
        {recipients.length === 0 ? (
          <p className="text-xs text-on-surface-muted">
            No email recipients. Addresses don&apos;t have to belong to Infrawrench users — a
            finance alias works fine.
          </p>
        ) : (
          <ul className="space-y-1">
            {recipients.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-2 text-sm text-on-surface-secondary"
              >
                <span className="truncate">{r.email}</span>
                <button
                  type="button"
                  onClick={() => void handleRemoveRecipient(r.id)}
                  aria-label={`Remove ${r.email}`}
                  className="text-xs text-on-surface-tertiary hover:text-red-400 transition-colors"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddRecipient();
            }}
            placeholder="finance@example.com"
            aria-label="Email recipient to add"
            className="flex-1 px-2 py-1.5 text-sm bg-surface-overlay border border-border rounded-lg text-on-surface-secondary"
          />
          <button
            type="button"
            onClick={() => void handleAddRecipient()}
            disabled={addBusy || newEmail.trim().length === 0}
            className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
          >
            {addBusy ? "Adding…" : "Add"}
          </button>
        </div>
        {recipientError && <p className="text-xs text-red-400">{recipientError}</p>}
      </div>

      {/* Last attempt */}
      {status && (
        <div className="space-y-1 border-t border-border pt-4">
          <p className={`text-xs font-medium ${TONE_CLASS[status.tone]}`}>{status.headline}</p>
          {settings.lastError && (
            <p className="text-xs text-on-surface-muted">{settings.lastError}</p>
          )}
          <p className="text-xs text-on-surface-tertiary">
            {settings.lastAttemptAt
              ? `Last attempt ${new Date(settings.lastAttemptAt).toLocaleString()} (attempt ${settings.attemptCount})`
              : "No attempt yet"}
            {settings.lastSentWeekStart ? ` · week of ${settings.lastSentWeekStart}` : ""}
            {settings.nextAttemptAt
              ? ` · retrying ${new Date(settings.nextAttemptAt).toLocaleString()}`
              : ""}
            .
          </p>
        </div>
      )}
      {!status && settings.lastSentAt && (
        <p className="text-xs text-on-surface-tertiary">
          Last sent {new Date(settings.lastSentAt).toLocaleString()}
          {settings.lastSentWeekStart ? ` (week of ${settings.lastSentWeekStart})` : ""}.
        </p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
      {sendMessage && (
        <p className={`text-xs ${sendMessage.kind === "ok" ? "text-green-400" : "text-red-400"}`}>
          {sendMessage.text}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleSendNow()}
          disabled={sendBusy}
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
        >
          {sendBusy ? "Sending…" : "Send now"}
        </button>
      </div>
    </section>
  );
}
