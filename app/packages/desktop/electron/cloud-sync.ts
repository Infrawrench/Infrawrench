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

/**
 * Sync is deliberately PUSH-ONLY.
 *
 * The desktop has two modes and only one of them has local data to reconcile:
 *
 *  - **Local workspace** — its own SQLite store. `pushChanges` sends that
 *    upward so work started locally can be adopted by a cloud organization.
 *  - **Cloud workspace** — a thin client. `electron/cloud-data/*` proxies every
 *    read to the web API, and `src/lib/ssh-dispatch.ts` routes cloud-key SSH
 *    through the WS proxy so private keys never leave the server. There is no
 *    local mirror to update, so there is nothing to pull into.
 *
 * A downward apply was scaffolded once and is not coming back. Beyond being
 * unnecessary, it is not expressible against this schema: `accounts.
 * encrypted_credentials` is `NOT NULL` and `resources.account_id` is
 * `NOT NULL REFERENCES accounts(id)`, with associations and pins hanging off
 * resources — so a credential-free mirror cannot be written at all, and a
 * credential-bearing one would put provider secrets on every device and make
 * the desktop a second caller of provider APIs outside the poller's per-plugin
 * rate limits (`packages/poller/src/poll-account.ts`).
 *
 * The server's `/api/v1/sync/pull` still exists and is still correct — it is
 * simply not something this client consumes. Reviving a local mirror means
 * answering the credential question first, not writing upserts.
 */

export async function runSyncCycle(): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const token = await getAccessToken();
    if (!token) return;

    notifyRenderer("cloud-sync-status", { status: "syncing" });

    await pushChanges(token);

    // `pushOnly` is permanent, not provisional: cloud mode reads live from
    // the API, so "synced" must never imply a local mirror was refreshed.
    notifyRenderer("cloud-sync-status", {
      status: "synced",
      lastSyncedAt: new Date().toISOString(),
      pushOnly: true,
    });
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
