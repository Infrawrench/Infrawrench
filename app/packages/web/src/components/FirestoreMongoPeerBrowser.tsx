import { useEffect, useState } from "react";
import { MongoDocumentBrowser as SharedMongoDocumentBrowser } from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

interface AccountRow {
  id: string;
  pluginId: string;
  displayName: string;
}

/**
 * Web variant of the Firestore Enterprise+MongoDB-compat browser. Lists the
 * caller's MongoDB accounts, persists the selected one in localStorage keyed
 * by the Firestore resource id, and renders MongoDocumentBrowser scoped to
 * that account with the Firestore database id as the Mongo database name.
 */
export function FirestoreMongoPeerBrowser({
  resourceId,
  firestoreDatabaseId,
}: {
  resourceId: string;
  firestoreDatabaseId: string;
}) {
  const orgId = useOrgId();
  const storageKey = `firestore:mongoPeer:${resourceId}`;
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkedAccountId, setLinkedAccountId] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem(storageKey) : null,
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await apiGet<AccountRow[]>(`/api/org/${orgId}/accounts`);
        if (cancelled) return;
        const list = rows.filter((r) => r.pluginId === "mongodb");
        setAccounts(list);
        if (!linkedAccountId && list.length === 1 && list[0]) {
          localStorage.setItem(storageKey, list[0].id);
          setLinkedAccountId(list[0].id);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load accounts");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  function link(accountId: string) {
    setError(null);
    localStorage.setItem(storageKey, accountId);
    setLinkedAccountId(accountId);
  }

  function unlink() {
    localStorage.removeItem(storageKey);
    setLinkedAccountId(null);
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-faint text-sm">
        Loading MongoDB accounts...
      </div>
    );
  }

  if (!linkedAccountId) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 border-t border-border">
        <div className="max-w-md w-full">
          <div className="text-sm text-on-surface-secondary mb-3 font-medium">
            Link a MongoDB account to browse this Enterprise database
          </div>
          <div className="text-xs text-on-surface-muted mb-4">
            Firestore Enterprise databases with MongoDB compatibility are accessed over the MongoDB
            wire protocol. Pick an account whose connection string points at this Firestore
            database.
          </div>
          {error && <div className="text-xs text-red-400 mb-2">{error}</div>}
          {accounts.length === 0 ? (
            <div className="text-xs text-on-surface-muted">
              No MongoDB accounts. Add one from the sidebar first.
            </div>
          ) : (
            <div className="space-y-2">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => link(a.id)}
                  className="w-full text-left px-3 py-2 rounded border border-border-strong bg-surface-overlay hover:bg-surface-sunken text-sm text-on-surface-secondary transition-colors"
                >
                  {a.displayName}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const linkedAccount = accounts.find((a) => a.id === linkedAccountId);

  return (
    <div className="flex flex-col flex-1 overflow-hidden border-t border-border">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-surface/80 border-b border-border/60">
        <span className="text-xs text-on-surface-muted">
          Linked:{" "}
          <span className="text-on-surface-secondary">
            {linkedAccount?.displayName ?? linkedAccountId}
          </span>
        </span>
        <div className="flex-1" />
        <button
          onClick={unlink}
          className="text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
        >
          Unlink
        </button>
      </div>
      <SharedMongoDocumentBrowser
        databaseName={firestoreDatabaseId}
        onCommand={async (command, args) => {
          const { result } = await apiPost<{ result: unknown }>(`/api/org/${orgId}/kv/command`, {
            accountId: linkedAccountId,
            command,
            args,
          });
          return result;
        }}
      />
    </div>
  );
}
