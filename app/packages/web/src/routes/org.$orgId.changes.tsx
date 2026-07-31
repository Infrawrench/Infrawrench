import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { summarizeChange, type ResourceChangeEntry } from "@infrawrench/ui";
import { ChangeDiffList, ChangeKindBadge } from "@/components/ResourceChangesPanel";
import { apiGet } from "@/lib/api";

interface AccountRow {
  id: string;
  pluginId: string;
  displayName: string;
}

const KINDS = ["created", "updated", "deleted"] as const;

export const Route = createFileRoute("/org/$orgId/changes")({
  component: ChangesFeedPage,
});

/**
 * Org-wide change timeline — every resource that appeared, changed a stored
 * field, or disappeared upstream, across all providers, newest first.
 */
function ChangesFeedPage() {
  const { orgId } = Route.useParams();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<ResourceChangeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const pageSize = 50;

  useEffect(() => {
    apiGet<AccountRow[]>(`/api/org/${orgId}/accounts`)
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, [orgId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (kindFilter) params.set("kind", kindFilter);
    if (accountFilter) params.set("accountId", accountFilter);
    apiGet<{ entries: ResourceChangeEntry[]; total: number }>(
      `/api/org/${orgId}/changes?${params}`,
    ).then((result) => {
      if (cancelled) return;
      setEntries(result.entries);
      setTotal(result.total);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, page, kindFilter, accountFilter]);

  const totalPages = Math.ceil(total / pageSize);

  function openResource(entry: ResourceChangeEntry) {
    void navigate({
      to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
      params: {
        orgId,
        pluginId: entry.pluginId,
        resourceTypeId: entry.resourceTypeId,
        resourceId: entry.resourceId,
      },
      search: { accountId: entry.accountId },
    });
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <h1 className="text-xl font-semibold mb-1">Changes</h1>
      <p className="text-sm text-on-surface-muted mb-6">
        Everything the resource poller saw appear, change, or disappear across your connected
        providers.
      </p>

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

      <div className="border border-border rounded-xl overflow-hidden">
        {loading ? (
          <p className="px-4 py-8 text-center text-sm text-on-surface-faint">Loading…</p>
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
                  <button
                    type="button"
                    onClick={() => openResource(entry)}
                    className="text-sm text-on-surface-secondary hover:text-on-surface hover:underline truncate"
                    title={`Open ${entry.displayName}`}
                  >
                    {entry.displayName}
                  </button>
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
