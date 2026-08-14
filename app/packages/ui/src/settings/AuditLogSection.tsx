import { useState, useEffect } from "react";
import { useGT } from "gt-react";
import { useSettingsHost } from "./host.js";
import { useDataString } from "../i18n/data-strings.js";

interface AuditLogEntry {
  id: string;
  userId: string | null;
  apiKeyId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string;
  userName: string | null;
  userEmail: string | null;
}

const ACTION_LABELS: Record<string, string> = {
  "account.create": "Created account",
  "account.delete": "Deleted account",
  "account.update": "Updated account",
  "resource.create": "Created resource",
  "resource.delete": "Deleted resource",
  "resource.sync": "Synced resources",
  "dashboard.create": "Created dashboard",
  "dashboard.delete": "Deleted dashboard",
  "dashboard.pin": "Pinned resource",
  "dashboard.unpin": "Unpinned resource",
  "api_key.create": "Created API key",
  "api_key.revoke": "Revoked API key",
  "api_key.rotate": "Rotated API key",
  "member.invite": "Invited member",
  "member.remove": "Removed member",
  "member.role_change": "Changed member role",
  "invitation.accept": "Accepted invitation",
  "subscription.create": "Created subscription",
  "subscription.cancel": "Canceled subscription",
  "subscription.seat_change": "Changed seat count",
  "auth.login": "Logged in",
  "auth.logout": "Logged out",
  "sync.push": "Pushed sync data",
  "sync.pull": "Pulled sync data",
};

const ENTITY_TYPES = ["account", "resource", "dashboard", "api_key", "member", "subscription"];

export function AuditLogSection() {
  const { orgId, api } = useSettingsHost();
  const gt = useGT();
  const gtData = useDataString();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [entityTypeFilter, setEntityTypeFilter] = useState("");
  const pageSize = 25;

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (entityTypeFilter) params.set("entityType", entityTypeFilter);
    api
      .get<{ entries: AuditLogEntry[]; total: number }>(`/api/org/${orgId}/audit-logs?${params}`)
      .then((result) => {
        setEntries(result.entries);
        setTotal(result.total);
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, entityTypeFilter]);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">{gt("Audit Log")}</h1>

      <div className="flex gap-3 mb-4">
        <label htmlFor="audit-entity-filter" className="sr-only">
          {gt("Filter by type")}
        </label>
        <select
          id="audit-entity-filter"
          value={entityTypeFilter}
          onChange={(e) => {
            setEntityTypeFilter(e.target.value);
            setPage(1);
          }}
          className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary"
        >
          <option value="">{gt("All types")}</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-xs text-on-surface-muted">
              <th scope="col" className="text-left px-4 py-2 font-medium">
                {gt("Time")}
              </th>
              <th scope="col" className="text-left px-4 py-2 font-medium">
                {gt("User")}
              </th>
              <th scope="col" className="text-left px-4 py-2 font-medium">
                {gt("Action")}
              </th>
              <th scope="col" className="text-left px-4 py-2 font-medium">
                {gt("Entity")}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-on-surface-faint">
                  {gt("Loading…")}
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-on-surface-faint">
                  {gt("No audit events found.")}
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr key={entry.id} className="border-b border-border/50 hover:bg-surface-raised/50">
                  <td className="px-4 py-2 text-xs text-on-surface-tertiary whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-sm text-on-surface-secondary">
                    {entry.userName ??
                      entry.userEmail ??
                      (entry.apiKeyId ? gt("API Key") : gt("System"))}
                  </td>
                  <td className="px-4 py-2 text-sm text-on-surface-secondary">
                    {gtData(ACTION_LABELS[entry.action] ?? entry.action)}
                  </td>
                  <td className="px-4 py-2 text-xs text-on-surface-muted font-mono">
                    {entry.entityType}:{entry.entityId.slice(0, 12)}...
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-on-surface-muted">{gt("{count} events", { count: total })}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              aria-label={gt("Previous page")}
              className="px-3 py-1 text-sm border border-border-strong rounded-lg text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-30"
            >
              {gt("Previous")}
            </button>
            <span
              aria-current="page"
              aria-label={gt("Page {page} of {total}", { page, total: totalPages })}
              className="px-3 py-1 text-sm text-on-surface-tertiary"
            >
              {gt("{page} / {total}", { page, total: totalPages })}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              aria-label={gt("Next page")}
              className="px-3 py-1 text-sm border border-border-strong rounded-lg text-on-surface-tertiary hover:text-on-surface-secondary disabled:opacity-30"
            >
              {gt("Next")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
