import { useCallback, useEffect, useState } from "react";
import { T, useGT } from "gt-react";
import {
  EVENT_SIGNATURE_HEADER,
  EVENT_SIGNATURE_TOLERANCE_SECONDS,
  type EventDelivery,
  type EventSubscription,
  type EventSubscriptionInput,
  type EventSubscriptionOptions,
  type EventSubscriptionSecret,
  type EventTypeInfo,
} from "@infrawrench/client-core";
import { useDataString } from "../../i18n/data-strings.js";
import { useSettingsHost } from "../host.js";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../styles.js";
import { EventSubscriptionForm } from "./EventSubscriptionForm.js";
import { EventDeliveriesPanel } from "./EventDeliveriesPanel.js";

/** Receiver-side verification, shown with the secret. Kept in sync with the docs page. */
const VERIFY_SNIPPET = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body exactly as received, before JSON.parse.
export function verifyInfrawrench(rawBody, header, secret) {
  const parts = header.split(",").map((p) => p.split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || Math.abs(Date.now() / 1000 - t) > ${EVENT_SIGNATURE_TOLERANCE_SECONDS}) return false;
  const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}`;

function SecretReveal({ secret, onDone }: { secret: string; onDone: () => void }) {
  const gt = useGT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="border border-warning/40 bg-warning/5 rounded-xl p-4 space-y-3">
      <T>
        <p className="text-sm font-medium text-on-surface-secondary">
          Copy the signing secret now. It is not shown again; reroll it if it is lost.
        </p>
      </T>
      <div className="flex gap-2 items-center">
        <code className="flex-1 min-w-0 break-all bg-surface-overlay rounded px-2 py-1 text-xs">
          {secret}
        </code>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          onClick={() => {
            void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
          }}
        >
          {copied ? gt("Copied") : gt("Copy")}
        </button>
      </div>
      <details className="text-xs text-on-surface-muted">
        <summary className="cursor-pointer">{gt("How to verify a request")}</summary>
        <p className="mt-2">
          {gt(
            "Each request carries a {header} header with a Unix timestamp t and one or more v1 signatures. Recompute HMAC-SHA256 of the timestamp, a dot and the raw body with this secret, and compare it with each v1. During the 24 hours after a reroll there are two v1 values; accept either.",
            { header: EVENT_SIGNATURE_HEADER },
          )}
        </p>
        <pre className="mt-2 overflow-x-auto bg-surface-overlay rounded p-2">{VERIFY_SNIPPET}</pre>
      </details>
      <button type="button" className={PRIMARY_BUTTON} onClick={onDone}>
        {gt("I have stored it")}
      </button>
    </div>
  );
}

/**
 * Event subscriptions: Infrawrench's own events, as data, to a signed HTTPS
 * webhook or an EventBridge bus / Pub/Sub topic in a connected account.
 * A tab of the Notifications section; shared by web and the desktop cloud
 * Settings tab.
 */
export function EventSubscriptionsSection() {
  const gt = useGT();
  const gtData = useDataString();
  const { orgId, api, has } = useSettingsHost();
  const canEdit = has("org:settings:write");
  const [subs, setSubs] = useState<EventSubscription[] | null>(null);
  const [catalog, setCatalog] = useState<EventTypeInfo[]>([]);
  const [options, setOptions] = useState<EventSubscriptionOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EventSubscription | "new" | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});

  const base = `/api/org/${orgId}/event-subscriptions`;

  const load = useCallback(async () => {
    try {
      const [list, cat, opts] = await Promise.all([
        api.get<{ subscriptions: EventSubscription[] }>(base),
        api.get<{ eventTypes: EventTypeInfo[] }>(`${base}/catalog`),
        api.get<EventSubscriptionOptions>(`${base}/options`),
      ]);
      setSubs(list.subscriptions);
      setCatalog(cat.eventTypes);
      setOptions(opts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load event subscriptions"));
    }
  }, [api, base, gt]);

  useEffect(() => {
    if (canEdit) void load();
  }, [load, canEdit]);

  if (!canEdit) {
    return (
      <p className="text-sm text-on-surface-muted">
        {gt("Managing event subscriptions needs the org:settings:write permission.")}
      </p>
    );
  }
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!subs || !options) return <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>;

  const labelFor = (type: string) => {
    const t = catalog.find((c) => c.type === type);
    return t ? gtData(t.label) : type;
  };

  async function save(input: EventSubscriptionInput) {
    if (editing === "new") {
      const r = await api.post<EventSubscriptionSecret>(base, input);
      if (r.secret) setSecret(r.secret);
      setExpanded(r.subscription.id);
    } else if (editing) {
      await api.put(`${base}/${editing.id}`, input);
    }
    setEditing(null);
    await load();
  }

  async function act(sub: EventSubscription, action: "test" | "reroll" | "delete" | "toggle") {
    setBusy(`${sub.id}:${action}`);
    try {
      if (action === "test") {
        const r = await api.post<{ delivery: EventDelivery }>(`${base}/${sub.id}/test`);
        const d = r.delivery;
        setMessages((m) => ({
          ...m,
          [sub.id]:
            d.state === "succeeded"
              ? {
                  ok: true,
                  text:
                    d.responseStatus !== null
                      ? gt("Test delivered (HTTP {status}).", { status: d.responseStatus })
                      : gt("Test delivered."),
                }
              : d.state === "pending"
                ? { ok: true, text: gt("Test queued; it goes out within a minute.") }
                : { ok: false, text: d.error ?? gt("Test failed") },
        }));
        setExpanded(sub.id);
        setRefreshKey((k) => k + 1);
      } else if (action === "reroll") {
        if (
          !window.confirm(
            gt(
              "Reroll the signing secret? The current secret keeps working for 24 hours so you can update your receiver.",
            ),
          )
        ) {
          return;
        }
        const r = await api.post<{ secret: string }>(`${base}/${sub.id}/reroll-secret`);
        setSecret(r.secret);
        await load();
      } else if (action === "delete") {
        if (
          !window.confirm(gt("Delete {name}? Its delivery log goes with it.", { name: sub.name }))
        ) {
          return;
        }
        await api.delete(`${base}/${sub.id}`);
        await load();
      } else {
        await api.put(`${base}/${sub.id}`, {
          name: sub.name,
          enabled: !sub.enabled,
          destination: sub.destination,
          eventTypes: sub.eventTypes,
          minSeverity: sub.minSeverity,
          accountIds: sub.accountIds,
          environments: sub.environments,
        });
        await load();
      }
    } catch (e) {
      setMessages((m) => ({
        ...m,
        [sub.id]: { ok: false, text: e instanceof Error ? e.message : gt("Request failed") },
      }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-on-surface-secondary">
          {gt("Event subscriptions")}
        </h2>
        <T>
          <p className="text-xs text-on-surface-muted">
            Send Infrawrench events (cost anomalies, budget thresholds, posture findings, drift,
            incidents, just-in-time access, SLO and metric alerts, sync failures) as JSON to your
            own systems: a signed HTTPS webhook, an EventBridge bus or a Pub/Sub topic. Unlike
            routing, these are data with a versioned schema, not messages for people. Failed
            deliveries retry with backoff for about a day and a half; a subscription that keeps
            failing for three days is turned off and admins are emailed.
          </p>
        </T>
      </div>

      {secret && <SecretReveal secret={secret} onDone={() => setSecret(null)} />}

      {editing ? (
        <EventSubscriptionForm
          existing={editing === "new" ? null : editing}
          catalog={catalog}
          options={options}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button type="button" className={PRIMARY_BUTTON} onClick={() => setEditing("new")}>
          {gt("Add subscription")}
        </button>
      )}

      {subs.length === 0 ? (
        <p className="text-sm text-on-surface-faint">{gt("No event subscriptions yet.")}</p>
      ) : (
        <ul className="space-y-3">
          {subs.map((sub) => {
            const message = messages[sub.id];
            return (
              <li key={sub.id} className="border border-border rounded-xl p-4 space-y-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-on-surface-secondary">
                      {sub.name}
                      <span
                        className={`ml-2 text-xs ${sub.enabled ? "text-success" : "text-on-surface-faint"}`}
                      >
                        {sub.enabled ? gt("On") : gt("Off")}
                      </span>
                    </p>
                    <p className="text-xs text-on-surface-muted break-all">
                      {sub.destination.kind === "webhook"
                        ? sub.destination.url
                        : sub.destinationLabel}
                    </p>
                    <p className="text-xs text-on-surface-faint mt-1">
                      {sub.eventTypes.length === 0
                        ? gt("Every event")
                        : sub.eventTypes.map(labelFor).join(", ")}
                      {sub.minSeverity
                        ? ` · ${gt("severity {level} and above", { level: sub.minSeverity })}`
                        : ""}
                      {sub.accountIds.length > 0
                        ? ` · ${gt("{n} account(s)", { n: sub.accountIds.length })}`
                        : ""}
                      {sub.environments.length > 0 ? ` · ${sub.environments.join(", ")}` : ""}
                    </p>
                    {sub.secretHint && (
                      <p className="text-xs text-on-surface-faint">
                        {gt("Secret ending {hint}", { hint: sub.secretHint })}
                        {sub.previousSecretExpiresAt
                          ? ` · ${gt("previous secret valid until {at}", {
                              at: new Date(sub.previousSecretExpiresAt).toLocaleString(),
                            })}`
                          : ""}
                      </p>
                    )}
                    {sub.disabledReason && (
                      <p className="text-xs text-danger mt-1">{sub.disabledReason}</p>
                    )}
                    {!sub.disabledReason && sub.consecutiveFailures > 0 && (
                      <p className="text-xs text-warning mt-1">
                        {gt("{n} failed deliveries in a row", { n: sub.consecutiveFailures })}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      disabled={busy !== null}
                      onClick={() => void act(sub, "test")}
                    >
                      {busy === `${sub.id}:test` ? gt("Sending…") : gt("Send test event")}
                    </button>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={() => setEditing(sub)}
                    >
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      disabled={busy !== null}
                      onClick={() => void act(sub, "toggle")}
                    >
                      {sub.enabled ? gt("Turn off") : gt("Turn on")}
                    </button>
                    {sub.destination.kind === "webhook" && (
                      <button
                        type="button"
                        className={SECONDARY_BUTTON}
                        disabled={busy !== null}
                        onClick={() => void act(sub, "reroll")}
                      >
                        {gt("Reroll secret")}
                      </button>
                    )}
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      aria-expanded={expanded === sub.id}
                      onClick={() => setExpanded(expanded === sub.id ? null : sub.id)}
                    >
                      {gt("Deliveries")}
                    </button>
                    <button
                      type="button"
                      className={`${SECONDARY_BUTTON} text-danger`}
                      disabled={busy !== null}
                      onClick={() => void act(sub, "delete")}
                    >
                      {gt("Delete")}
                    </button>
                  </div>
                </div>
                {message && (
                  <p className={`text-xs ${message.ok ? "text-success" : "text-danger"}`}>
                    {message.text}
                  </p>
                )}
                {expanded === sub.id && (
                  <EventDeliveriesPanel subscriptionId={sub.id} refreshKey={refreshKey} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
