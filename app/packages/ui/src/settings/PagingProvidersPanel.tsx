/**
 * Paging providers on the On-call settings page: PagerDuty, incident.io and any
 * other connected account whose plugin can page.
 *
 * The routing half (sending an alert to a provider, pushing whoever is on call
 * upstream) lives in the alert routing editor with every other destination.
 * This panel holds what is per account rather than per rule: whether the
 * provider's incidents are mirrored into Infrawrench, the webhook that keeps
 * the mirror current, who is on call upstream right now, and what Infrawrench
 * has opened upstream lately.
 *
 * Hidden entirely for members without `org:settings:write` (the listing 403s)
 * and for orgs with no paging-capable account.
 */
import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import type {
  PagingDestinationsResponse,
  PagingEventRecord,
  PagingEventsResponse,
  PagingOnCallNowResponse,
  PagingProviderAccount,
  PagingProvidersResponse,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";
import { INPUT } from "./alert-routing/shared.js";

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function PagingProvidersPanel() {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const apiGet = api.get;
  const [accounts, setAccounts] = useState<PagingProviderAccount[] | null>(null);
  const [destinations, setDestinations] = useState<PagingDestinationsResponse["accounts"]>([]);
  const [events, setEvents] = useState<PagingEventRecord[]>([]);
  const [hidden, setHidden] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiGet<PagingProvidersResponse>(`/api/org/${orgId}/paging-providers`)
      .then((res) => {
        if (cancelled) return;
        setAccounts(res.accounts);
        if (res.accounts.length === 0) return;
        // The on-call pickers and the event log only matter once there is an
        // account; both are best-effort.
        apiGet<PagingDestinationsResponse>(`/api/org/${orgId}/paging-providers/destinations`)
          .then((d) => {
            if (!cancelled) setDestinations(d.accounts);
          })
          .catch(() => undefined);
        apiGet<PagingEventsResponse>(`/api/org/${orgId}/paging-providers/events?limit=10`)
          .then((e) => {
            if (!cancelled) setEvents(e.events);
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (!cancelled) setHidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiGet, orgId, reload]);

  if (hidden || !accounts || accounts.length === 0) return null;

  const accountName = (id: string) => accounts.find((a) => a.accountId === id)?.displayName ?? id;

  return (
    <section className="border border-border rounded-xl p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-on-surface-secondary">
          {gt("Paging providers")}
        </h3>
        <p className="text-xs text-on-surface-muted mt-1">
          {gt(
            "Alert routing rules can open incidents in these accounts and push whoever is on call there. Mirror their incidents here to acknowledge and resolve them from Infrawrench.",
          )}
        </p>
      </div>
      <ul className="space-y-4">
        {accounts.map((account) => (
          <PagingAccountCard
            key={account.accountId}
            account={account}
            destination={destinations.find((d) => d.accountId === account.accountId) ?? null}
            onChanged={() => setReload((n) => n + 1)}
          />
        ))}
      </ul>
      {events.length > 0 && (
        <div className="pt-3 border-t border-border/50 space-y-2">
          <h4 className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">
            {gt("Recently sent to paging providers")}
          </h4>
          <ul className="divide-y divide-border/50">
            {events.map((event) => (
              <li key={event.id} className="py-2 text-sm">
                <p className="text-on-surface-secondary truncate">{event.title}</p>
                <p className="text-xs text-on-surface-tertiary">
                  {accountName(event.accountId)} · {eventStateLabel(event, gt)} ·{" "}
                  {formatWhen(event.updatedAt)}
                </p>
                {event.lastError && <p className="text-xs text-danger">{event.lastError}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function eventStateLabel(event: PagingEventRecord, gt: ReturnType<typeof useGT>): string {
  if (event.pendingAction) {
    return event.attempts > 0
      ? gt("retrying ({count} failed attempts)", { count: event.attempts })
      : gt("queued");
  }
  switch (event.state) {
    case "triggered":
      return gt("triggered");
    case "acknowledged":
      return gt("acknowledged");
    case "resolved":
      return gt("resolved");
  }
}

function PagingAccountCard({
  account,
  destination,
  onChanged,
}: {
  account: PagingProviderAccount;
  destination: PagingDestinationsResponse["accounts"][number] | null;
  onChanged: () => void;
}) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const settings = account.settings;
  const base = `/api/org/${orgId}/paging-providers/${encodeURIComponent(account.accountId)}`;

  async function save(body: { inboundEnabled: boolean; webhookSecret?: string | null }) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.put<{ warning: string | null }>(`${base}/settings`, body);
      if (res.warning) setNotice(res.warning);
      setSecret("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save"));
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ synced: number }>(`${base}/sync`);
      setNotice(gt("Reconciled {count} incidents.", { count: res.synced }));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Sync failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-border/60 p-3 space-y-2">
      <p className="text-sm font-medium text-on-surface-secondary">{account.displayName}</p>

      {account.incidents ? (
        <label className="flex items-center gap-2 text-xs text-on-surface-secondary">
          <input
            type="checkbox"
            checked={settings.inboundEnabled}
            disabled={busy}
            onChange={(e) => void save({ inboundEnabled: e.target.checked })}
          />
          <span>
            {gt("Show this account's {label} in Infrawrench", {
              label: account.incidents.label.toLowerCase(),
            })}
          </span>
        </label>
      ) : null}

      {settings.inboundEnabled && account.webhookMode === "managed" && (
        <p className="text-xs text-on-surface-tertiary">
          {settings.webhookConfigured
            ? gt("A webhook keeps this list current within seconds.")
            : gt("No webhook is subscribed, so incidents are reconciled every couple of minutes.")}
        </p>
      )}

      {settings.inboundEnabled && account.webhookMode === "manual" && (
        <div className="space-y-1.5">
          <p className="text-xs text-on-surface-tertiary">
            {account.webhookSetupHelp ??
              gt(
                "Add this URL as a webhook endpoint in the provider, then paste its signing secret.",
              )}
          </p>
          {settings.webhookUrl ? (
            <code className="block text-xs break-all rounded bg-surface-muted/60 px-2 py-1">
              {settings.webhookUrl}
            </code>
          ) : (
            <p className="text-xs text-warning">
              {gt("This deployment has no public URL, so incidents are reconciled on a timer.")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={
                settings.webhookConfigured
                  ? gt("Signing secret saved; paste a new one to replace it")
                  : gt("Signing secret")
              }
              aria-label={gt("Webhook signing secret")}
              className={`${INPUT} min-w-64`}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={busy || !secret.trim()}
              onClick={() => void save({ inboundEnabled: true, webhookSecret: secret })}
              className="text-xs text-info hover:text-info-strong disabled:opacity-50"
            >
              {gt("Save secret")}
            </button>
            {settings.webhookConfigured && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void save({ inboundEnabled: true, webhookSecret: null })}
                className="text-xs text-danger disabled:opacity-50"
              >
                {gt("Forget secret")}
              </button>
            )}
          </div>
        </div>
      )}

      {settings.inboundEnabled && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-on-surface-tertiary">
          <span>
            {settings.lastSyncedAt
              ? gt("Last reconciled {when}", { when: formatWhen(settings.lastSyncedAt) })
              : gt("Not reconciled yet")}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void syncNow()}
            className="text-info hover:text-info-strong disabled:opacity-50"
          >
            {gt("Sync now")}
          </button>
        </div>
      )}
      {settings.lastSyncError && (
        <p className="text-xs text-danger">
          {gt("Last sync failed: {error}", { error: settings.lastSyncError })}
        </p>
      )}

      {account.onCallSourceLabel && destination && destination.onCallSources.length > 0 && (
        <ProviderOnCallPreview accountId={account.accountId} sources={destination.onCallSources} />
      )}

      {notice && <p className="text-xs text-warning">{notice}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

/** "Who is on call there right now", for one schedule or escalation policy at a time. */
function ProviderOnCallPreview({
  accountId,
  sources,
}: {
  accountId: string;
  sources: PagingDestinationsResponse["accounts"][number]["onCallSources"];
}) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const apiGet = api.get;
  const [sourceId, setSourceId] = useState("");
  const [result, setResult] = useState<PagingOnCallNowResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (id: string) => {
      setResult(null);
      setError(null);
      if (!id) return;
      apiGet<PagingOnCallNowResponse>(
        `/api/org/${orgId}/paging-providers/${encodeURIComponent(accountId)}/on-call/${encodeURIComponent(id)}`,
      )
        .then(setResult)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    },
    [apiGet, orgId, accountId],
  );

  return (
    <div className="space-y-1.5">
      <select
        value={sourceId}
        onChange={(e) => {
          setSourceId(e.target.value);
          load(e.target.value);
        }}
        className={INPUT}
        aria-label={gt("Show who is on call")}
      >
        <option value="">{gt("Who is on call…")}</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-danger">{error}</p>}
      {result && result.people.length === 0 && (
        <p className="text-xs text-on-surface-tertiary">{gt("Nobody is on call right now.")}</p>
      )}
      {result && result.people.length > 0 && (
        <ul className="text-xs text-on-surface-secondary space-y-0.5">
          {result.people.map((p, i) => (
            <li key={`${p.email ?? p.name ?? ""}-${i}`}>
              {p.name ?? p.email ?? gt("Unknown")}
              {p.level && p.level > 1 ? gt(" (level {level})", { level: p.level }) : ""}
              {p.until ? gt(" until {when}", { when: formatWhen(p.until) }) : ""}
              {p.memberUserId ? "" : gt(" · not an Infrawrench member, so no push")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
