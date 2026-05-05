import { useEffect, useState } from "react";
import { MongoDocumentBrowser as SharedMongoDocumentBrowser } from "@infrawrench/ui";
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
  const [accounts, setAccounts] = useState<Array<{ id: string; displayName: string }>>([]);
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
        const db = await getDb();
        const rows = await db.select<
          Array<{ encrypted_credentials: string; credentials_iv: string }>
        >("SELECT encrypted_credentials, credentials_iv FROM accounts WHERE id = $1 LIMIT 1", [id]);
        if (!rows[0]) {
          if (!cancelled) {
            setError("Linked MongoDB account not found");
            setLinkedAccountId(null);
            localStorage.removeItem(storageKey);
          }
          return;
        }
        const plaintext = await invoke<string>("decrypt_value", {
          ciphertext: rows[0].encrypted_credentials,
          iv: rows[0].credentials_iv,
        });
        const creds = JSON.parse(plaintext) as Record<string, string>;
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
            wire protocol. Pick an account with a connection string pointing at this Firestore
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

  if (!connectionString) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-faint text-sm">
        {error ?? "Loading connection..."}
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
        connected={true}
        onCommand={async (command, args) =>
          kvCommand("mongodb", connectionString, command, ...args.map(String))
        }
      />
    </div>
  );
}
