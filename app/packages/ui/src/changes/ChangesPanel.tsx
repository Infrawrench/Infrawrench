import { useCallback, useEffect, useRef, useState } from "react";
import { summarizeChange } from "@infrawrench/client-core";
import { ChangeDiffList, ChangeKindBadge } from "./ChangeParts.js";
import { ProviderIncidentChangesSection } from "../status/ProviderIncidentChangesSection.js";
import type { StatusIncidentsClient } from "../status/types.js";
import type {
  ChangeFeedAccount,
  ChangesClient,
  ResourceChangeEntry,
  ResourceChangeKind,
} from "./types.js";

const KINDS: ResourceChangeKind[] = ["created", "updated", "deleted"];
const PAGE_SIZE = 50;

export interface ChangesPanelProps {
  /**
   * Org-scoped data access. Hosts mount the panel with `key={orgId}` so an org
   * switch remounts it — that is what clears the previous org's rows, rather
   * than an effect resetting every state value by hand.
   */
  client: ChangesClient;
  /** Jump to a changed resource's detail view. Omitted, names are plain text. */
  onOpenResource?: ((entry: ResourceChangeEntry) => void) | undefined;
  /**
   * Provider status correlation. When present, incidents overlapping the org
   * render as a section above the feed ("these N changes happened during an
   * incident"). Optional so hosts adopt it independently.
   */
  statusClient?: StatusIncidentsClient | undefined;
  /** Open an external URL (provider status page). */
  onOpenUrl?: ((url: string) => void) | undefined;
}

/**
 * Org-wide change timeline — every resource that appeared, changed a stored
 * field, or disappeared upstream, across all providers, newest first.
 *
 * Cloud-only by nature: the events are recorded by the poller as it syncs, so a
 * host with no org has nothing to show. Hosts guard the entry point rather than
 * rendering this with a dead client.
 */
export function ChangesPanel({
  client,
  onOpenResource,
  statusClient,
  onOpenUrl,
}: ChangesPanelProps) {
  const [entries, setEntries] = useState<ResourceChangeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [accounts, setAccounts] = useState<ChangeFeedAccount[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Bumped per request so a slow page can't overwrite a later one that already
  // landed — filters change faster than a feed query returns.
  const requestSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Awaited inside try/catch rather than chained: a host client may throw
    // synchronously (desktop's requires an active org), and a synchronous throw
    // escapes a promise chain straight into the nearest error boundary.
    void (async () => {
      try {
        const rows = await client.listAccounts();
        if (!cancelled) setAccounts(rows);
      } catch {
        // The filter is a convenience; the feed still works without it.
        if (!cancelled) setAccounts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await client.listChanges({
        page,
        pageSize: PAGE_SIZE,
        ...(kindFilter ? { kind: kindFilter } : {}),
        ...(accountFilter ? { accountId: accountFilter } : {}),
      });
      if (seq !== requestSeq.current) return;
      setEntries(result.entries);
      setTotal(result.total);
      setLoading(false);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [client, page, kindFilter, accountFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">Changes</h1>
      <p className="text-sm text-on-surface-muted mb-6">
        Everything the resource poller saw appear, change, or disappear across your connected
        providers.
      </p>

      {statusClient && (
        <ProviderIncidentChangesSection client={statusClient} onOpenUrl={onOpenUrl} />
      )}

      <div className="flex gap-3 mb-4">
        <label htmlFor="changes-kind-filter" className="sr-only">
          Filter by change kind
        </label>
        <select
          id="changes-kind-filter"
          value={kindFilter}
          onChange={(e) => {
            setKindFilter(e.target.value);
            setPage(1);
          }}
          className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary"
        >
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label htmlFor="changes-account-filter" className="sr-only">
          Filter by account
        </label>
        <select
          id="changes-account-filter"
          value={accountFilter}
          onChange={(e) => {
            setAccountFilter(e.target.value);
            setPage(1);
          }}
          className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
      </div>

      {error !== null && (
        <div role="alert" className="mb-4 text-sm text-red-500">
          Couldn&apos;t load the change feed — {error}{" "}
          <button type="button" onClick={() => void load()} className="underline">
            Retry
          </button>
        </div>
      )}

      <div className="border border-border rounded-xl overflow-hidden">
        {loading ? (
          <p role="status" className="px-4 py-8 text-center text-sm text-on-surface-faint">
            Loading…
          </p>
        ) : entries.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-on-surface-faint">No changes recorded yet.</p>
            <p className="text-xs text-on-surface-faint mt-1">
              Events appear here after the poller has synced your accounts at least twice.
            </p>
          </div>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="border-b border-border/50 last:border-b-0 px-4 py-3 hover:bg-surface-raised/50"
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs text-on-surface-tertiary whitespace-nowrap w-36 shrink-0">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  <ChangeKindBadge kind={entry.changeKind} />
                  {entry.origin === "schedule" && (
                    <span
                      className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-tertiary whitespace-nowrap"
                      title="This transition was executed by a sleep/wake schedule."
                    >
                      via schedule
                    </span>
                  )}
                  {onOpenResource ? (
                    <button
                      type="button"
                      onClick={() => onOpenResource(entry)}
                      className="text-sm text-on-surface-secondary hover:text-on-surface hover:underline truncate"
                      title={`Open ${entry.displayName}`}
                    >
                      {entry.displayName}
                    </button>
                  ) : (
                    <span className="text-sm text-on-surface-secondary truncate">
                      {entry.displayName}
                    </span>
                  )}
                  <span className="text-xs text-on-surface-muted font-mono truncate">
                    {entry.pluginId}/{entry.resourceTypeId}
                  </span>
                  {entry.accountName && (
                    <span className="text-xs text-on-surface-faint truncate">
                      {entry.accountName}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-2 min-w-0">
                    <span className="text-xs text-on-surface-muted truncate">
                      {summarizeChange(entry)}
                    </span>
                    {entry.changeKind === "updated" && entry.diff.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                        aria-expanded={expandedId === entry.id}
                        className="text-xs text-on-surface-faint hover:text-on-surface-secondary shrink-0"
                      >
                        {expandedId === entry.id ? "Hide diff" : "Show diff"}
                      </button>
                    )}
                  </span>
                </div>
                {expandedId === entry.id && <ChangeDiffList entry={entry} />}
              </li>
            ))}
          </ul>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-on-surface-muted">{total} events</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label="Previous page"
              className="px-3 py-1 text-sm border border-border-strong rounded-lg text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-30"
            >
              Previous
            </button>
            <span
              aria-current="page"
              aria-label={`Page ${page} of ${totalPages}`}
              className="px-3 py-1 text-sm text-on-surface-tertiary"
            >
              {page} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              aria-label="Next page"
              className="px-3 py-1 text-sm border border-border-strong rounded-lg text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-30"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
