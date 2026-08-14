import { useState, useEffect } from "react";
import { T, useGT } from "gt-react";
import type { MsTeamsWebhook } from "@infrawrench/client-core";
import { useSettingsHost } from "../host.js";
import { Field, inputClass } from "./shared.js";

/** The Microsoft Teams glyph, in the Teams brand purple. */
export function TeamsMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="#6264A7"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9.186 4.797a2.42 2.42 0 1 0-2.86-2.448h1.178c.929 0 1.682.753 1.682 1.682zm-4.295 7.738h2.613c.929 0 1.682-.753 1.682-1.682V5.58h2.783a.7.7 0 0 1 .682.716v4.294a4.197 4.197 0 0 1-4.093 4.293c-1.618-.04-3-.99-3.667-2.35Zm10.737-9.372a1.674 1.674 0 1 1-3.349 0 1.674 1.674 0 0 1 3.349 0m-2.238 9.488-.12-.002a5.2 5.2 0 0 0 .381-2.07V6.306a1.7 1.7 0 0 0-.15-.725h1.792c.39 0 .707.317.707.707v3.765a2.6 2.6 0 0 1-2.598 2.598z" />
      <path d="M.682 3.349h6.822c.377 0 .682.305.682.682v6.822a.68.68 0 0 1-.682.682H.682A.68.68 0 0 1 0 10.853V4.03c0-.377.305-.682.682-.682Zm5.206 2.596v-.72h-3.59v.72h1.357V9.66h.87V5.945z" />
    </svg>
  );
}

/**
 * Microsoft Teams channel routing.
 *
 * There is no "Add to Teams" button here, and that is not an omission. Teams
 * has no app-only OAuth flow for posting channel messages — Graph requires a
 * signed-in user — so the supported path is a webhook URL the user creates in
 * the channel. That makes this section a paste-a-URL form rather than a picker,
 * and the disclosure below carries the steps to get one.
 */
export function MsTeamsSection({ orgId, embedded = false }: { orgId: string; embedded?: boolean }) {
  const gt = useGT();
  const { api } = useSettingsHost();
  const [webhooks, setWebhooks] = useState<MsTeamsWebhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testMessage, setTestMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  async function load() {
    try {
      const r = await api.get<{ webhooks: MsTeamsWebhook[] }>(`/api/org/${orgId}/msteams/status`);
      setWebhooks(r.webhooks);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load Teams settings"));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function handleRemove(id: string) {
    await api.delete(`/api/org/${orgId}/msteams/webhooks/${id}`);
    void load();
  }

  async function handleTest() {
    setBusy(true);
    setTestMessage(null);
    try {
      const r = await api.post<{ webhookCount: number; succeeded: number }>(
        `/api/org/${orgId}/msteams/test`,
      );
      setTestMessage({
        kind: "ok",
        text: gt("Posted to {succeeded}/{count} channel(s).", {
          succeeded: r.succeeded,
          count: r.webhookCount,
        }),
      });
    } catch (e) {
      setTestMessage({
        kind: "error",
        text: e instanceof Error ? e.message : gt("Test failed"),
      });
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

  if (!webhooks) {
    return shell(
      <>
        <h2 className="text-sm font-semibold text-on-surface-secondary">{gt("Microsoft Teams")}</h2>
        {error ? (
          <p className="text-xs text-danger">{error}</p>
        ) : (
          <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
        )}
      </>,
      "space-y-2",
    );
  }

  return shell(
    <>
      <div className="flex items-center gap-2">
        <TeamsMark className="w-4 h-4" />
        <h2 className="text-sm font-semibold text-on-surface-secondary">{gt("Microsoft Teams")}</h2>
      </div>

      <T>
        <p className="text-xs text-on-surface-muted">
          Add a channel by pasting the webhook URL from a Teams <strong>Workflows</strong>{" "}
          automation.
        </p>
      </T>

      <details className="text-xs text-on-surface-muted">
        <summary className="cursor-pointer text-on-surface-tertiary hover:text-on-surface-secondary">
          {gt("How do I get one?")}
        </summary>
        <ol className="list-decimal ml-5 mt-2 space-y-1">
          <T>
            <li>
              In Teams, hover the channel you want alerts in and choose{" "}
              <strong>More options (…) → Workflows</strong>.
            </li>
          </T>
          <T>
            <li>
              Pick the <strong>Post to a channel when a webhook request is received</strong>{" "}
              template.
            </li>
          </T>
          <li>{gt("Name it, confirm the team and channel, and select Create.")}</li>
          <li>{gt("Copy the webhook URL it shows you and paste it below.")}</li>
        </ol>
        <p className="mt-2">
          {gt(
            "The URL is a credential — anyone holding it can post to that channel. It's stored encrypted and never shown again after you add it.",
          )}
        </p>
      </details>

      {webhooks.length > 0 && (
        <ul className="divide-y divide-border/50">
          {webhooks.map((w) => (
            <li
              key={w.id}
              className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="text-on-surface-secondary truncate">{w.label}</p>
                <p className="text-xs text-on-surface-faint font-mono truncate">{w.urlHint}</p>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-on-surface-tertiary">
                <button
                  type="button"
                  onClick={() => void handleRemove(w.id)}
                  className="text-danger hover:text-danger-strong"
                >
                  {gt("Remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddMsTeamsWebhook orgId={orgId} onAdded={() => void load()} />

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
          disabled={busy || webhooks.length === 0}
          title={webhooks.length === 0 ? gt("Add a channel first") : undefined}
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
        >
          {busy ? gt("Posting…") : gt("Send test message")}
        </button>
      </div>
    </>,
  );
}

/** Paste-a-URL form. The server validates the host and returns the error to show. */
function AddMsTeamsWebhook({ orgId, onAdded }: { orgId: string; onAdded: () => void }) {
  const gt = useGT();
  const { api } = useSettingsHost();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/api/org/${orgId}/msteams/webhooks`, { label, url });
      setLabel("");
      setUrl("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to add the channel"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-2 border-t border-border/50 space-y-2">
      <Field label={gt("Label")}>
        <input
          type="text"
          aria-label={gt("Label")}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={gt("#alerts (Platform)")}
          className={inputClass}
        />
      </Field>
      <Field label={gt("Webhook URL")}>
        <input
          type="url"
          aria-label={gt("Webhook URL")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…/workflows/…/triggers/manual/paths/invoke?…"
          className={inputClass}
        />
      </Field>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={saving || !label.trim() || !url.trim()}
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
        >
          {saving ? gt("Adding…") : gt("Add channel")}
        </button>
      </div>
    </div>
  );
}
