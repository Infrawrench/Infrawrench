import { useState } from "react";
import { T, Var, useGT } from "gt-react";
import type {
  IssueStatusRefreshResult,
  IssueWebhookSetupResult,
  IssueWebhookState,
} from "@infrawrench/client-core";

import { useSettingsHost } from "./host.js";

export interface IssueStatusSyncPanelProps {
  tracker: "jira" | "linear" | "github";
  /** Whether the tracker is connected (GitHub: filing is set up). */
  connected: boolean;
  /** Jira and Linear: the stored webhook. */
  webhook?: IssueWebhookState | null | undefined;
  /** GitHub: the server-wide App webhook. */
  githubWebhook?: { configured: boolean; url: string | null } | undefined;
  /** Whether the caller may set up or remove the webhook. */
  canConfigure: boolean;
  onWebhookChange?: ((webhook: IssueWebhookState) => void) | undefined;
  /** Called after a refresh so the section can reload its filed list. */
  onRefreshed?: (() => void) | undefined;
}

const buttonClass =
  "px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors";
const inputClass =
  "px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong w-full";

/**
 * "Live status" for one tracker's settings section: how filed issues' status
 * reaches Infrawrench (a webhook, or the poll every half hour), a way to set
 * the webhook up, and a "Refresh statuses" button that asks the tracker now.
 *
 * Jira: automatic registration needs a Jira admin; when Jira refuses, the
 * reply carries the URL and a one-time secret to paste into Jira's own form,
 * shown here once. Linear: automatic creation needs a workspace admin; the
 * manual path is "copy this URL into Linear, paste the signing secret back".
 * GitHub: one webhook for the whole server, configured on the GitHub App by
 * whoever runs it, so this only says whether it is on.
 */
export function IssueStatusSyncPanel({
  tracker,
  connected,
  webhook,
  githubWebhook,
  canConfigure,
  onWebhookChange,
  onRefreshed,
}: IssueStatusSyncPanelProps) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const base = `/api/org/${orgId}/${tracker === "github" ? "github-issues" : tracker}`;

  const [busy, setBusy] = useState<"setup" | "remove" | "refresh" | "url" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Jira manual setup: the one-time secret to paste into Jira. */
  const [jiraSecret, setJiraSecret] = useState<string | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  /** Linear manual setup: the URL to paste into Linear, then the secret back. */
  const [linearManualUrl, setLinearManualUrl] = useState<string | null>(null);
  const [signingSecret, setSigningSecret] = useState("");

  if (!connected) return null;

  async function run<T>(kind: NonNullable<typeof busy>, body: () => Promise<T>): Promise<T | null> {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      return await body();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Something went wrong"));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function setup(mode: "auto" | "manual") {
    const res = await run("setup", () =>
      api.post<IssueWebhookSetupResult>(`${base}/webhook`, { mode }),
    );
    if (!res) return;
    onWebhookChange?.(res.webhook);
    setJiraSecret(res.secret ?? null);
    setFallbackReason(res.fallbackReason ?? null);
    if (res.webhook.mode === "registered")
      setNotice(gt("Webhook created. Statuses now update live."));
  }

  async function startLinearManual() {
    const res = await run("url", () => api.post<{ url: string }>(`${base}/webhook/url`));
    if (res) setLinearManualUrl(res.url);
  }

  async function saveLinearSecret() {
    const res = await run("setup", () =>
      api.post<IssueWebhookSetupResult>(`${base}/webhook`, {
        mode: "manual",
        signingSecret: signingSecret.trim(),
      }),
    );
    if (!res) return;
    onWebhookChange?.(res.webhook);
    setLinearManualUrl(null);
    setSigningSecret("");
    setNotice(gt("Webhook saved. Statuses update as soon as Linear sends the first change."));
  }

  async function remove() {
    if (!window.confirm(gt("Remove the status webhook? Statuses keep refreshing every half hour.")))
      return;
    const res = await run("remove", () => api.delete(`${base}/webhook`));
    if (res === null) return;
    onWebhookChange?.({ mode: null, url: null, lastDeliveryAt: null });
    setJiraSecret(null);
    setFallbackReason(null);
    setNotice(gt("Webhook removed."));
  }

  async function refresh() {
    const res = await run("refresh", () =>
      api.post<IssueStatusRefreshResult>(`${base}/links/refresh`),
    );
    if (!res) return;
    setNotice(
      gt("Checked {checked} issues; {changed} changed.", {
        checked: res.checked,
        changed: res.changed,
      }),
    );
    onRefreshed?.();
  }

  const live = tracker === "github" ? Boolean(githubWebhook?.configured) : Boolean(webhook?.mode);

  return (
    <section className="border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{gt("Live status")}</h2>
        <span className={`text-xs ${live ? "text-success" : "text-on-surface-muted"}`}>
          {live ? gt("Webhook on") : gt("Polling every 30 minutes")}
        </span>
      </div>
      <p className="text-xs text-on-surface-muted">
        {gt(
          "Every filed issue shows its current status and assignee next to its link. A webhook updates them within seconds; without one they refresh every half hour.",
        )}
      </p>

      {error && <p className="text-xs text-danger">{error}</p>}
      {notice && <p className="text-xs text-success">{notice}</p>}

      {tracker === "github" ? (
        githubWebhook?.configured ? (
          <p className="text-xs text-on-surface-tertiary">
            {gt(
              "The GitHub App's webhook is set up on this server, so issue changes arrive as they happen.",
            )}
          </p>
        ) : (
          <T>
            <p className="text-xs text-on-surface-tertiary">
              Whoever runs this Infrawrench server can make GitHub statuses live: on the GitHub App,
              turn the webhook on with the URL{" "}
              <Var>
                <code className="break-all">
                  {githubWebhook?.url ?? "/api/issue-webhooks/github"}
                </code>
              </Var>
              , subscribe it to Issues events, and set the same secret as{" "}
              <Var>
                <code>GITHUB_APP_WEBHOOK_SECRET</code>
              </Var>
              .
            </p>
          </T>
        )
      ) : webhook?.mode ? (
        <div className="space-y-1 text-xs text-on-surface-tertiary">
          <p>
            {webhook.mode === "registered"
              ? gt("Created in {tracker} by Infrawrench.", {
                  tracker: tracker === "jira" ? "Jira" : "Linear",
                })
              : gt("Added by hand in {tracker}.", {
                  tracker: tracker === "jira" ? "Jira" : "Linear",
                })}{" "}
            {webhook.lastDeliveryAt
              ? gt("Last delivery {date}.", {
                  date: new Date(webhook.lastDeliveryAt).toLocaleString(),
                })
              : gt("No delivery yet.")}
          </p>
          {webhook.url && (
            <p className="break-all">
              {gt("URL")}: <code>{webhook.url}</code>
            </p>
          )}
        </div>
      ) : null}

      {jiraSecret && webhook?.url && (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning-surface p-3 text-xs">
          {fallbackReason && <p className="text-warning-on-surface">{fallbackReason}</p>}
          <p className="text-on-surface-secondary">
            {gt(
              "In Jira, go to Settings > System > Webhooks, create a webhook for issue updated and issue deleted events, and paste these. The secret is shown only now.",
            )}
          </p>
          <label className="block">
            <span className="block text-on-surface-tertiary mb-1">{gt("URL")}</span>
            <input
              readOnly
              value={webhook.url}
              className={inputClass}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <label className="block">
            <span className="block text-on-surface-tertiary mb-1">{gt("Secret")}</span>
            <input
              readOnly
              value={jiraSecret}
              className={inputClass}
              onFocus={(e) => e.target.select()}
            />
          </label>
        </div>
      )}

      {linearManualUrl && (
        <div className="space-y-2 rounded-lg border border-border p-3 text-xs">
          <p className="text-on-surface-secondary">
            {gt(
              "In Linear, go to Settings > API > Webhooks, create a webhook for Issues with this URL, then paste the signing secret Linear shows.",
            )}
          </p>
          <label className="block">
            <span className="block text-on-surface-tertiary mb-1">{gt("URL")}</span>
            <input
              readOnly
              value={linearManualUrl}
              className={inputClass}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <label className="block">
            <span className="block text-on-surface-tertiary mb-1">{gt("Signing secret")}</span>
            <input
              type="password"
              autoComplete="off"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              className={inputClass}
            />
          </label>
          <button
            type="button"
            onClick={() => void saveLinearSecret()}
            disabled={busy !== null || !signingSecret.trim()}
            className={buttonClass}
          >
            {gt("Save webhook")}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {tracker !== "github" && canConfigure && (
          <>
            <button
              type="button"
              onClick={() => void setup("auto")}
              disabled={busy !== null}
              className={buttonClass}
            >
              {busy === "setup"
                ? gt("Setting up…")
                : webhook?.mode
                  ? gt("Recreate webhook")
                  : gt("Set up webhook")}
            </button>
            {!webhook?.mode && (
              <button
                type="button"
                onClick={() => void (tracker === "jira" ? setup("manual") : startLinearManual())}
                disabled={busy !== null}
                className={buttonClass}
              >
                {gt("Add it by hand")}
              </button>
            )}
            {webhook?.mode && (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy !== null}
                className="px-3 py-1.5 text-sm font-medium text-danger hover:text-danger-strong disabled:opacity-50"
              >
                {gt("Remove webhook")}
              </button>
            )}
          </>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy !== null}
          className={buttonClass}
        >
          {busy === "refresh" ? gt("Refreshing…") : gt("Refresh statuses")}
        </button>
      </div>
    </section>
  );
}
