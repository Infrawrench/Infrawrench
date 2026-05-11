import { useEffect, useState } from "react";
import {
  MongoDocumentBrowser as SharedMongoDocumentBrowser,
  FirestoreMongoPeerShell,
  type MongoPeerAccount,
} from "@infrawrench/ui";
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
  const [accounts, setAccounts] = useState<MongoPeerAccount[]>([]);
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

  return (
    <FirestoreMongoPeerShell
      accounts={accounts}
      linkedAccountId={linkedAccountId}
      loading={loading}
      error={error}
      onLink={link}
      onUnlink={unlink}
    >
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
    </FirestoreMongoPeerShell>
  );
}
