import { useEffect, useState } from "react";
import {
  MongoDocumentBrowser as SharedMongoDocumentBrowser,
  FirestoreMongoPeerShell,
  type MongoPeerAccount,
} from "@infrawrench/ui";
import { kvCommand } from "../lib/sql-drivers";
import { getDb } from "../db/client";
import { invoke } from "../lib/invoke";

/**
 * Renders a MongoDB document browser against a user-picked MongoDB account
 * for a Firestore Enterprise database with MongoDB-compatible data access.
 *
 * Flow:
 *  1. On mount, read the linked MongoDB accountId from localStorage (keyed
 *     by the Firestore resource id). If none linked, show the picker.
 *  2. Picker lists MongoDB accounts from the local DB. User selects one.
 *  3. We decrypt the selected account's `connectionString` credential and
 *     render `MongoDocumentBrowser` against it, using the Firestore database
 *     id as the MongoDB database name (this is how Firestore Enterprise
 *     exposes databases over the wire protocol).
 */
export function FirestoreMongoPeerBrowser({
  resourceId,
  firestoreDatabaseId,
}: {
  resourceId: string;
  firestoreDatabaseId: string;
}) {
  const storageKey = `firestore:mongoPeer:${resourceId}`;
  const [accounts, setAccounts] = useState<MongoPeerAccount[]>([]);
  const [linkedAccountId, setLinkedAccountId] = useState<string | null>(() =>
    localStorage.getItem(storageKey),
  );
  const [connectionString, setConnectionString] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const db = await getDb();
        const rows = await db.select<Array<{ id: string; display_name: string }>>(
          "SELECT id, display_name FROM accounts WHERE plugin_id = $1 ORDER BY display_name",
          ["mongodb"],
        );
        if (cancelled) return;
        const list = rows.map((r) => ({ id: r.id, displayName: r.display_name }));
        setAccounts(list);
        // Auto-link when there's exactly one MongoDB account and the user
        // hasn't already picked one. The explicit picker is only useful
        // when the choice is ambiguous.
        if (!linkedAccountId && list.length === 1 && list[0]) {
          setLinkedAccountId(list[0].id);
          localStorage.setItem(storageKey, list[0].id);
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!linkedAccountId) {
      setConnectionString(null);
      return;
    }
    let cancelled = false;
    async function loadCreds(id: string) {
      try {
        let creds: Record<string, string>;
        try {
          creds = await invoke<Record<string, string>>("account_get_credentials", {
            accountId: id,
          });
        } catch {
          if (!cancelled) {
            setError("Linked MongoDB account not found");
            setLinkedAccountId(null);
            localStorage.removeItem(storageKey);
          }
          return;
        }
        const cs = creds["connectionString"] ?? "";
        if (!cs) {
          if (!cancelled) setError("MongoDB account has no connection string set");
          return;
        }
        if (!cancelled) setConnectionString(cs);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load credentials");
      }
    }
    void loadCreds(linkedAccountId);
    return () => {
      cancelled = true;
    };
  }, [linkedAccountId, storageKey]);

  function link(accountId: string) {
    setError(null);
    setLinkedAccountId(accountId);
    localStorage.setItem(storageKey, accountId);
  }

  function unlink() {
    setLinkedAccountId(null);
    setConnectionString(null);
    localStorage.removeItem(storageKey);
  }

  return (
    <FirestoreMongoPeerShell
      accounts={accounts}
      linkedAccountId={linkedAccountId}
      loading={loading}
      error={error}
      pendingConnection={linkedAccountId !== null && connectionString === null}
      onLink={link}
      onUnlink={unlink}
    >
      {connectionString && (
        <SharedMongoDocumentBrowser
          databaseName={firestoreDatabaseId}
          connected={true}
          onCommand={async (command, args) =>
            kvCommand("mongodb", connectionString, command, ...args.map(String))
          }
        />
      )}
    </FirestoreMongoPeerShell>
  );
}
