import { useEffect, useState } from "react";
import type { PluginManifest } from "@infrawrench/plugin-base";
import {
  MongoDocumentBrowser as SharedMongoDocumentBrowser,
  FirestoreMongoPeerShell,
  type MongoPeerAccount,
} from "@infrawrench/ui";
import { kvCommand } from "../lib/sql-drivers";
import { getDb } from "../db/client";
import { getPlugin, loadPlugins } from "../plugins/loader";
import { getLocalAccountCredentials } from "../lib/local-credentials";

/**
 * Renders a document browser against a user-picked account for a Firestore
 * Enterprise database with MongoDB-compatible data access. Any plugin whose KV
 * driver declares `browser: "documents"` can be linked; its declaration names the
 * driver to speak and the credential holding the connection string.
 *
 * Flow:
 *  1. On mount, read the linked MongoDB accountId from localStorage (keyed
 *     by the Firestore resource id). If none linked, show the picker.
 *  2. Picker lists those accounts from the local DB. User selects one.
 *  3. We decrypt the selected account's connection string credential and
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
  const [connState, setConnState] = useState<{
    forId: string | null;
    value: string | null;
    driverId: string | null;
  }>({ forId: null, value: null, driverId: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Derive the connection string for the currently-linked account. When
  // linkedAccountId changes, the cached value no longer matches and we fall
  // back to null until the async loader refreshes it.
  const connectionString =
    linkedAccountId && connState.forId === linkedAccountId ? connState.value : null;
  const driverId = connState.driverId;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const db = await getDb();
        const [rows, plugins] = await Promise.all([
          db.select<Array<{ id: string; display_name: string; plugin_id: string }>>(
            "SELECT id, display_name, plugin_id FROM accounts ORDER BY display_name",
          ),
          loadPlugins(),
        ]);
        if (cancelled) return;
        const documentPluginIds = new Set(
          plugins.flatMap(({ plugin }) =>
            plugin.manifest.kvDriver?.browser === "documents" ? [plugin.manifest.id] : [],
          ),
        );
        const list = rows.flatMap((r) =>
          documentPluginIds.has(r.plugin_id) ? [{ id: r.id, displayName: r.display_name }] : [],
        );
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
      return;
    }
    let cancelled = false;
    async function loadCreds(id: string) {
      try {
        let creds: Record<string, string>;
        let driver: NonNullable<PluginManifest["kvDriver"]>;
        try {
          creds = await getLocalAccountCredentials(id);
          const db = await getDb();
          const [row] = await db.select<Array<{ plugin_id: string }>>(
            "SELECT plugin_id FROM accounts WHERE id = $1",
            [id],
          );
          const declared = row && (await getPlugin(row.plugin_id))?.plugin.manifest.kvDriver;
          if (declared?.browser !== "documents") throw new Error("No document browser");
          driver = declared;
        } catch {
          if (!cancelled) {
            setError("Linked MongoDB account not found");
            setLinkedAccountId(null);
            localStorage.removeItem(storageKey);
          }
          return;
        }
        const cs = creds[driver.credentialKey] ?? "";
        if (!cs) {
          if (!cancelled) setError("MongoDB account has no connection string set");
          return;
        }
        if (!cancelled) setConnState({ forId: id, value: cs, driverId: driver.driver });
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
      {connectionString && driverId && (
        <SharedMongoDocumentBrowser
          databaseName={firestoreDatabaseId}
          connected={true}
          onCommand={async (command, args) =>
            kvCommand(driverId, connectionString, command, ...args.map(String))
          }
        />
      )}
    </FirestoreMongoPeerShell>
  );
}
