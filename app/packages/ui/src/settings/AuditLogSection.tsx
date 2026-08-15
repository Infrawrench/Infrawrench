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
  /**
   * Resolved at read time by the route's join. Both are null for a browser
   * action, and also for a key row that has since been deleted — `apiKeyId`
   * outlives the key, which is exactly the case the actor cell has to word.
   */
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
}

/** Subset of GET /api/org/:orgId/api-keys the actor filter needs. */
interface ApiKeyOption {
  id: string;
  name: string;
  prefix: string;
  revokedAt: string | null;
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
  const { orgId, api, has } = useSettingsHost();
  const gt = useGT();
  const gtData = useDataString();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [entityTypeFilter, setEntityTypeFilter] = useState("");
  const [apiKeyFilter, setApiKeyFilter] = useState("");
  const [apiKeys, setApiKeys] = useState<ApiKeyOption[]>([]);
  const pageSize = 25;

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (entityTypeFilter) params.set("entityType", entityTypeFilter);
    if (apiKeyFilter) params.set("apiKeyId", apiKeyFilter);
    api
      .get<{ entries: AuditLogEntry[]; total: number }>(`/api/org/${orgId}/audit-logs?${params}`)
      .then((result) => {
        setEntries(result.entries);
        setTotal(result.total);
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, entityTypeFilter, apiKeyFilter]);

  /**
   * Names for the key filter. Reading audit entries and reading the org's keys
   * are separate permissions, so this is best-effort: without `apikeys:read`
   * the dropdown simply carries whatever key the reader clicked on in the
   * table, which is still enough to narrow the log and to clear the filter.
   */
  useEffect(() => {
    if (!has("apikeys:read")) return;
    api
      .get<ApiKeyOption[]>(`/api/org/${orgId}/api-keys`)
      .then(setApiKeys)
      .catch(() => setApiKeys([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const totalPages = Math.ceil(total / pageSize);

  /**
   * A key deleted since it acted, or one this reader cannot list, is not in
   * `apiKeys` — without a synthetic option the select would render blank while
   * a filter was active, and there would be no way back to the full log.
   */
  const filteredKeyIsListed = apiKeys.some((k) => k.id === apiKeyFilter);
  const keyOptions: ApiKeyOption[] =
    apiKeyFilter && !filteredKeyIsListed
      ? [
          {
            id: apiKeyFilter,
            name: entries.find((e) => e.apiKeyId === apiKeyFilter)?.apiKeyName ?? gt("Deleted key"),
            prefix: entries.find((e) => e.apiKeyId === apiKeyFilter)?.apiKeyPrefix ?? "",
            revokedAt: null,
          },
          ...apiKeys,
        ]
      : apiKeys;

  function filterByKey(apiKeyId: string) {
    setApiKeyFilter(apiKeyId);
    setPage(1);
  }

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

        {keyOptions.length > 0 && (
          <>
            <label htmlFor="audit-api-key-filter" className="sr-only">
              {gt("Filter by API key")}
            </label>
            <select
              id="audit-api-key-filter"
              value={apiKeyFilter}
              onChange={(e) => filterByKey(e.target.value)}
              className="bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary"
            >
              <option value="">{gt("All API keys")}</option>
              {keyOptions.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.prefix ? `${k.name} (${k.prefix}…)` : k.name}
                </option>
              ))}
            </select>
          </>
        )}
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
                    <ActorCell entry={entry} onFilterByKey={filterByKey} />
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

/**
 * Who did it. An API-key call is attributed to the key, not just to the person
 * who minted it: a key acts as its owner, so the owner's name alone cannot say
 * whether a human or a token was at the other end — which is the whole
 * question after a credential leaks. The chip filters the log to that one key
 * via the route's `apiKeyId` parameter, since `userId` would cover the owner
 * and every key they ever issued at once.
 */
function ActorCell({
  entry,
  onFilterByKey,
}: {
  entry: AuditLogEntry;
  onFilterByKey: (apiKeyId: string) => void;
}) {
  const gt = useGT();
  const owner = entry.userName ?? entry.userEmail;
  const apiKeyId = entry.apiKeyId;
  if (!apiKeyId) return <>{owner ?? gt("System")}</>;

  return (
    <div className="flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={() => onFilterByKey(apiKeyId)}
        title={gt("Show only this API key")}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-strong bg-surface-overlay py-0.5 pr-2 pl-1.5 transition-colors hover:bg-surface-raised"
      >
        <span className="rounded-full bg-surface-raised px-1.5 py-px text-[10px] font-medium tracking-wide text-on-surface-muted uppercase">
          {gt("API key")}
        </span>
        <span className="truncate text-xs text-on-surface-secondary">
          {entry.apiKeyName ?? gt("Deleted key")}
        </span>
        {entry.apiKeyPrefix && (
          <span className="font-mono text-[11px] text-on-surface-muted">{entry.apiKeyPrefix}…</span>
        )}
      </button>
      {owner && (
        <span className="text-xs text-on-surface-muted">{gt("Owned by {owner}", { owner })}</span>
      )}
    </div>
  );
}
