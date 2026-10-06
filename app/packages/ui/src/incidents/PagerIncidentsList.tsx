import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import { sortPagerIncidents, type PagerIncidentRecord } from "@infrawrench/client-core";
import type { IncidentSeed, IncidentsClient } from "./types.js";

function statusTone(status: PagerIncidentRecord["status"]): string {
  switch (status) {
    case "triggered":
      return "text-danger";
    case "acknowledged":
      return "text-warning";
    default:
      return "text-on-surface-faint";
  }
}

function formatWhen(iso: string): string {
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

/**
 * Open incidents from connected paging providers, with acknowledge and resolve
 * written back upstream, and a shortcut to declare an Infrawrench incident
 * seeded from one (the provider pages people; declaring is what opens the
 * freeze, the status page notice and the timeline here).
 *
 * Renders nothing when the host has no provider client or there is nothing
 * open, so an org without PagerDuty or incident.io never sees an empty box.
 */
export function PagerIncidentsList({
  client,
  showResolved,
  onDeclare,
}: {
  client: IncidentsClient;
  showResolved: boolean;
  onDeclare?: ((seed: IncidentSeed) => void) | undefined;
}) {
  const gt = useGT();
  const [rows, setRows] = useState<PagerIncidentRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!client.listPagerIncidents) return;
    client
      .listPagerIncidents(showResolved ? "all" : "open")
      .then((list) => setRows(sortPagerIncidents(list)))
      .catch(() => setRows([]));
  }, [client, showResolved]);

  useEffect(() => {
    load();
  }, [load]);

  if (!client.listPagerIncidents || rows.length === 0) return null;

  async function act(row: PagerIncidentRecord, action: "acknowledge" | "resolve") {
    if (!client.actOnPagerIncident) return;
    setBusyId(row.id);
    setError(null);
    try {
      const updated = await client.actOnPagerIncident(row.id, action);
      setRows((list) => sortPagerIncidents(list.map((r) => (r.id === updated.id ? updated : r))));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("The provider refused the change"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-2" aria-label={gt("Paging provider incidents")}>
      <h3 className="text-xs font-semibold text-on-surface-tertiary uppercase tracking-wide">
        {gt("From your paging providers")}
      </h3>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-xl border border-border bg-surface-raised px-4 py-3 space-y-1"
          >
            <div className="flex flex-wrap items-center gap-2">
              {row.reference && (
                <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-surface-sunken text-on-surface-secondary">
                  {row.reference}
                </span>
              )}
              <span className="text-sm font-medium text-on-surface truncate">{row.title}</span>
              <span className={`text-xs ${statusTone(row.status)}`}>
                {row.statusLabel ??
                  (row.status === "triggered"
                    ? gt("Triggered")
                    : row.status === "acknowledged"
                      ? gt("Acknowledged")
                      : gt("Resolved"))}
              </span>
              {row.fromInfrawrench && (
                <span className="text-[11px] text-on-surface-faint">
                  {gt("opened by an Infrawrench alert")}
                </span>
              )}
            </div>
            <p className="text-xs text-on-surface-secondary truncate">
              {row.accountName}
              {row.serviceName ? ` · ${row.serviceName}` : ""}
              {row.urgency ? ` · ${row.urgency}` : ""} · {formatWhen(row.createdAt)}
              {row.assignees.length > 0 &&
                ` · ${row.assignees.map((a) => a.name ?? a.email ?? "").join(", ")}`}
            </p>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {client.actOnPagerIncident && row.canAcknowledge && (
                <button
                  type="button"
                  disabled={busyId === row.id}
                  onClick={() => void act(row, "acknowledge")}
                  className="text-info hover:text-info-strong disabled:opacity-50"
                >
                  {gt("Acknowledge")}
                </button>
              )}
              {client.actOnPagerIncident && row.canResolve && (
                <button
                  type="button"
                  disabled={busyId === row.id}
                  onClick={() => void act(row, "resolve")}
                  className="text-success hover:underline disabled:opacity-50"
                >
                  {gt("Resolve")}
                </button>
              )}
              {onDeclare && row.status !== "resolved" && (
                <button
                  type="button"
                  onClick={() =>
                    onDeclare({
                      title: row.title,
                      summary: [row.reference, row.accountName, row.url]
                        .filter(Boolean)
                        .join(" · "),
                      startedAt: row.createdAt,
                    })
                  }
                  className="text-on-surface-secondary hover:text-on-surface"
                >
                  {gt("Declare incident")}
                </button>
              )}
              {row.url && (
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-on-surface-secondary hover:text-on-surface underline"
                >
                  {gt("Open in {provider}", { provider: row.accountName })}
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
