import { ipcMain, BrowserWindow } from "electron";
import { getAccessToken, getAuthStatus } from "./cloud-auth";
import { getDb, getEncryptionKey, decryptValue } from "./main-utils";

const CLOUD_URL = process.env["INFRAWRENCH_CLOUD_URL"] ?? "http://localhost:3000";
const SYNC_INTERVAL_MS = 60_000; // 60 seconds

let syncTimer: ReturnType<typeof setInterval> | null = null;
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
      const plain = decryptValue(a.encrypted_credentials, a.credentials_iv, encKey);
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

async function pullChanges(token: string): Promise<void> {
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
    accounts: Array<{ id: string; syncVersion: number; [k: string]: unknown }>;
    resources: Array<{ id: string; syncVersion: number; [k: string]: unknown }>;
    dashboards: Array<{ id: string; syncVersion: number; [k: string]: unknown }>;
  };

  let maxVersion = lastSyncVersion;

  for (const acct of data.accounts ?? []) {
    if (acct.syncVersion > maxVersion) maxVersion = acct.syncVersion;
  }
  for (const res of data.resources ?? []) {
    if (res.syncVersion > maxVersion) maxVersion = res.syncVersion;
  }
  for (const dash of data.dashboards ?? []) {
    if (dash.syncVersion > maxVersion) maxVersion = dash.syncVersion;
  }

  if (maxVersion > lastSyncVersion) {
    await setSyncState("last_sync_version", String(maxVersion));
  }

  // TODO: Upsert pulled data into local SQLite (requires re-encrypting
  // credentials with the local master key). This is the pull-side implementation
  // that will be completed alongside the full sync integration.
}

async function runSyncCycle(): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const token = await getAccessToken();
    if (!token) return;

    notifyRenderer("cloud-sync-status", { status: "syncing" });

    await pushChanges(token);
    await pullChanges(token);

    notifyRenderer("cloud-sync-status", {
      status: "synced",
      lastSyncedAt: new Date().toISOString(),
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

export function startSyncTimer(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    void runSyncCycle();
  }, SYNC_INTERVAL_MS);
  void runSyncCycle();
}

export function stopSyncTimer(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

ipcMain.handle("cloud_sync_now", async () => {
  await runSyncCycle();
  return { ok: true };
});

ipcMain.handle("cloud_sync_status", async () => {
  const status = await getAuthStatus();
  const lastSyncedAt = await getSyncState("last_sync_version");
  return {
    ...status,
    syncing: isSyncing,
    lastSyncedAt,
  };
});
