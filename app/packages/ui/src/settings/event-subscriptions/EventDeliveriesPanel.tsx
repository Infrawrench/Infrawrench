import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { EventDelivery, EventDeliveryState } from "@infrawrench/client-core";
import { useSettingsHost } from "../host.js";
import { SECONDARY_BUTTON } from "../styles.js";

const STATE_CLASS: Record<EventDeliveryState, string> = {
  pending: "text-on-surface-muted",
  retrying: "text-warning",
  succeeded: "text-success",
  dead: "text-danger",
  skipped: "text-on-surface-faint",
};

/**
 * The delivery log for one subscription: newest first, each row expandable to
 * its attempts and the envelope as sent, with Redeliver on any row.
 */
export function EventDeliveriesPanel({
  subscriptionId,
  refreshKey,
}: {
  subscriptionId: string;
  refreshKey: number;
}) {
  const gt = useGT();
  const { orgId, api } = useSettingsHost();
  const [deliveries, setDeliveries] = useState<EventDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const stateLabel = (s: EventDeliveryState): string => {
    switch (s) {
      case "pending":
        return gt("Pending");
      case "retrying":
        return gt("Retrying");
      case "succeeded":
        return gt("Delivered");
      case "dead":
        return gt("Failed");
      case "skipped":
        return gt("Skipped");
    }
  };

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ deliveries: EventDelivery[] }>(
        `/api/org/${orgId}/event-subscriptions/deliveries?subscriptionId=${encodeURIComponent(subscriptionId)}&limit=50`,
      );
      setDeliveries(r.deliveries);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load deliveries"));
    }
  }, [api, orgId, subscriptionId, gt]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function redeliver(id: string) {
    setNotice(null);
    try {
      await api.post(`/api/org/${orgId}/event-subscriptions/deliveries/${id}/redeliver`);
      setNotice(gt("Queued. It goes out within a minute."));
      void load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : gt("Redelivery failed"));
    }
  }

  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!deliveries) return <p className="text-xs text-on-surface-faint">{gt("Loading…")}</p>;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-on-surface-tertiary">
          {gt("Recent deliveries")}
        </h4>
        <button type="button" className={SECONDARY_BUTTON} onClick={() => void load()}>
          {gt("Refresh")}
        </button>
      </div>
      {notice && <p className="text-xs text-on-surface-muted">{notice}</p>}
      {deliveries.length === 0 ? (
        <p className="text-xs text-on-surface-faint">
          {gt("Nothing sent yet. Use Send test event to try the destination.")}
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg">
          {deliveries.map((d) => (
            <li key={d.id} className="px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="text-left flex-1 min-w-0"
                  aria-expanded={open === d.id}
                  onClick={() => setOpen(open === d.id ? null : d.id)}
                >
                  <span className={`font-medium ${STATE_CLASS[d.state]}`}>
                    {stateLabel(d.state)}
                  </span>
                  <code className="ml-2 text-on-surface-secondary">{d.eventType}</code>
                  {d.test && <span className="ml-2 text-on-surface-faint">{gt("test")}</span>}
                  <span className="ml-2 text-on-surface-faint">
                    {new Date(d.createdAt).toLocaleString()}
                  </span>
                  {d.responseStatus !== null && (
                    <span className="ml-2 text-on-surface-faint">HTTP {d.responseStatus}</span>
                  )}
                  <span className="ml-2 text-on-surface-faint">
                    {gt("{n} attempt(s)", { n: d.attemptCount })}
                  </span>
                </button>
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  onClick={() => void redeliver(d.id)}
                >
                  {gt("Redeliver")}
                </button>
              </div>
              {d.error && <p className="mt-1 text-danger">{d.error}</p>}
              {d.nextAttemptAt && (
                <p className="mt-1 text-on-surface-faint">
                  {gt("Next attempt {at}", { at: new Date(d.nextAttemptAt).toLocaleString() })}
                </p>
              )}
              {open === d.id && (
                <div className="mt-2 space-y-2">
                  {d.attempts.length > 0 && (
                    <ul className="space-y-0.5">
                      {d.attempts.map((a) => (
                        <li key={a.at} className="text-on-surface-muted">
                          {new Date(a.at).toLocaleString()} · {a.status ?? "-"} · {a.durationMs} ms
                          {a.error ? ` · ${a.error}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {d.responseExcerpt && (
                    <pre className="whitespace-pre-wrap break-all bg-surface-overlay rounded p-2 text-on-surface-muted">
                      {d.responseExcerpt}
                    </pre>
                  )}
                  <pre className="overflow-x-auto bg-surface-overlay rounded p-2 text-on-surface-muted">
                    {JSON.stringify(d.payload, null, 2)}
                  </pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
