import { useState, useEffect } from "react";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import type { DigestSettings } from "@infrawrench/ui";

/**
 * The weekly digest's org-level switch. Which channels receive it is decided
 * by the "Weekly digest" checkbox on each Slack channel and Teams webhook on
 * the paging settings page — this section only turns the schedule on and
 * proves the pipeline with a "Send now".
 */
export function WeeklyDigestSection({ orgId }: { orgId: string }) {
  const [settings, setSettings] = useState<DigestSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendMessage, setSendMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  // Bumped to re-run the load effect after a "Send now" refreshes `lastSentAt`.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    // `cancelled` drops a response that lands after `orgId` changed, so a
    // slower earlier request can't overwrite the newer org's settings.
    let cancelled = false;
    void (async () => {
      try {
        const next = await apiGet<DigestSettings>(`/api/org/${orgId}/digest`);
        if (!cancelled) setSettings(next);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load digest settings");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, reloadNonce]);

  async function handleToggle(enabled: boolean) {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, enabled });
    setError(null);
    try {
      setSettings(await apiPut<DigestSettings>(`/api/org/${orgId}/digest`, { enabled }));
    } catch (e) {
      setSettings(previous);
      setError(e instanceof Error ? e.message : "Failed to save digest settings");
    }
  }

  async function handleSendNow() {
    setSendBusy(true);
    setSendMessage(null);
    try {
      const r = await apiPost<{ attempted: number; succeeded: number }>(
        `/api/org/${orgId}/digest/send`,
      );
      setSendMessage({
        kind: "ok",
        text: `Sent to ${r.succeeded}/${r.attempted} channel(s).`,
      });
      setReloadNonce((n) => n + 1);
    } catch (e) {
      setSendMessage({ kind: "error", text: e instanceof Error ? e.message : "Send failed" });
    } finally {
      setSendBusy(false);
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

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <h2 className="text-sm font-semibold text-on-surface-secondary">Weekly digest</h2>
      <p className="text-xs text-on-surface-muted">
        Every Monday morning (07:00 UTC), a summary of last week: total spend with week-over-week
        movers by provider and service, sync incidents, and resources added or removed. It goes to
        the Slack and Teams channels above that have <strong>Weekly digest</strong> ticked.
      </p>

      <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void handleToggle(e.target.checked)}
        />
        <span>Send a weekly digest</span>
      </label>

      {settings.lastSentAt && (
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
