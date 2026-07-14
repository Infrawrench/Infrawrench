import { BrowserWindow } from "electron";
import { getAccessToken } from "./cloud-auth";
import { getDb, getEncryptionKey, decryptValue, buildAad } from "./main-utils";
import { CLOUD_URL } from "../env";

let isSyncing = false;

async function getSyncState(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM cloud_sync_state WHERE key = $1",
    [key],
  );
  return rows[0]?.value ?? null;
}

async function setSyncState(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute("INSERT OR REPLACE INTO cloud_sync_state (key, value) VALUES ($1, $2)", [
    key,
    value,
  ]);
}

function notifyRenderer(event: string, data: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(event, data);
  }
}

async function pushChanges(token: string): Promise<void> {
  const db = await getDb();
  const lastPushAt = (await getSyncState("last_push_at")) ?? "1970-01-01T00:00:00Z";
  const encKey = getEncryptionKey();

  const modifiedAccounts = await db.select<
    Array<{
      id: string;
      plugin_id: string;
      display_name: string;
      encrypted_credentials: string;
      credentials_iv: string;
      updated_at: string;
      deleted_at: string | null;
    }>
  >(
    "SELECT id, plugin_id, display_name, encrypted_credentials, credentials_iv, updated_at, deleted_at FROM accounts WHERE updated_at > $1",
    [lastPushAt],
  );

  const accountPayload = modifiedAccounts.map((a) => {
    // Decrypt credentials locally, send plaintext over TLS
    let credentials: Record<string, string> = {};
    try {
      const plain = decryptValue(
        a.encrypted_credentials,
        a.credentials_iv,
        encKey,
        buildAad("account", a.id, "credentials"),
      );
      credentials = JSON.parse(plain) as Record<string, string>;
    } catch {
      /* skip if can't decrypt */
    }

    return {
      id: a.id,
      pluginId: a.plugin_id,
      displayName: a.display_name,
      credentials,
      updatedAt: a.updated_at,
      deletedAt: a.deleted_at,
    };
  });

  const modifiedDashboards = await db.select<
    Array<{
      id: string;
      name: string;
      is_default: number;
      updated_at: string;
      deleted_at: string | null;
    }>
  >("SELECT id, name, is_default, updated_at, deleted_at FROM dashboards WHERE updated_at > $1", [
    lastPushAt,
  ]);

  const dashboardPayload = modifiedDashboards.map((d) => ({
    id: d.id,
    name: d.name,
    isDefault: d.is_default === 1,
    updatedAt: d.updated_at,
    deletedAt: d.deleted_at,
  }));

  if (accountPayload.length === 0 && dashboardPayload.length === 0) return;

  const response = await fetch(`${CLOUD_URL}/api/v1/sync/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      accounts: accountPayload,
      dashboards: dashboardPayload,
    }),
  });

  if (!response.ok) {
    throw new Error(`Push failed: ${response.status}`);
  }

  await setSyncState("last_push_at", new Date().toISOString());
}

interface PendingPull {
  accounts: number;
  resources: number;
  dashboards: number;
}

/**
 * Pull is currently FETCH-ONLY: it reports how many remote changes are
 * pending but applies nothing locally, and it deliberately does NOT advance
 * the `last_sync_version` cursor. The server only returns records with
 * `syncVersion > lastSyncVersion`, so advancing the cursor without applying
 * the records would permanently skip them once apply is implemented.
 *
 * TODO(pull-apply): applying pulled records is blocked on a protocol change,
 * not on local plumbing. `/api/v1/sync/pull` returns account credentials
 * encrypted with the SERVER's master key (`encryptedCredentials` /
 * `credentialsIv`, see web `src/api/routes/sync.ts`), which this process
 * cannot decrypt — the desktop only holds its own per-install key
 * (`main-utils.getEncryptionKey`). Push works because the desktop sends
 * plaintext credentials over TLS and the server re-encrypts. Full pull-apply
 * needs:
 *   1. The server to return credentials in a client-decryptable form (e.g.
 *      plaintext over TLS, mirroring push).
 *   2. Decided conflict semantics between the server's per-org `syncVersion`
 *      counter and local `updated_at` timestamps.
 *   3. Local upserts into accounts / resources / dashboards (re-encrypting
 *      credentials with the local master key), deletion handling via
 *      `deletedAt`, and the `dashboardPins` / `associations` collections the
 *      payload also carries.
 * Only after records are actually applied may `last_sync_version` advance.
 */
export async function pullChanges(token: string): Promise<PendingPull> {
  const lastSyncVersion = Number((await getSyncState("last_sync_version")) ?? "0");

  const response = await fetch(`${CLOUD_URL}/api/v1/sync/pull`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ lastSyncVersion }),
  });

  if (!response.ok) {
    throw new Error(`Pull failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    accounts?: Array<{ id: string; syncVersion: number }>;
    resources?: Array<{ id: string; syncVersion: number }>;
    dashboards?: Array<{ id: string; syncVersion: number }>;
  };

  return {
    accounts: data.accounts?.length ?? 0,
    resources: data.resources?.length ?? 0,
    dashboards: data.dashboards?.length ?? 0,
  };
}

export async function runSyncCycle(): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const token = await getAccessToken();
    if (!token) return;

    notifyRenderer("cloud-sync-status", { status: "syncing" });

    await pushChanges(token);

    // Only push actually syncs data today; scope the success signal so
    // "synced" never claims remote changes were applied locally.
    notifyRenderer("cloud-sync-status", {
      status: "synced",
      lastSyncedAt: new Date().toISOString(),
      pushOnly: true,
    });

    // Best-effort probe of the pull endpoint. It applies nothing (see
    // pullChanges), so a failure here must not flip the cycle to "error".
    try {
      const pending = await pullChanges(token);
      const total = pending.accounts + pending.resources + pending.dashboards;
      if (total > 0) {
        console.info(
          `[cloud-sync] ${total} remote change(s) pending; pull-apply is not implemented yet`,
        );
      }
    } catch (probeError) {
      console.warn("[cloud-sync] pull probe failed:", probeError);
    }
  } catch (e) {
    console.error("[cloud-sync] Sync error:", e);
    notifyRenderer("cloud-sync-status", {
      status: "error",
      error: e instanceof Error ? e.message : "Unknown sync error",
    });
  } finally {
    isSyncing = false;
  }
}
