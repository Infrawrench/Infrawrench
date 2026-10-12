import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Leaked credentials: cloud only. Scanning runs in the cloud poller and the
// matching needs the org's stored credentials, so local mode has no
// counterpart. Same endpoints the web Posture tab and `infrawrench leaks` use.

ipcMain.handle(
  "cloud_leaked_secrets",
  async (
    _e,
    { orgId, status, accountId }: { orgId: string; status?: string; accountId?: string },
  ) => {
    const query = new URLSearchParams();
    if (status) query.set("status", status);
    if (accountId) query.set("accountId", accountId);
    const qs = query.toString();
    return cloudFetch(orgId, `/leaked-secrets${qs ? `?${qs}` : ""}`);
  },
);

/** The actions a renderer may take on one leak; anything else is refused here. */
const ACTIONS = new Set(["rotate", "mark-rotated", "dismiss", "reopen"]);

ipcMain.handle(
  "cloud_leaked_secret_action",
  async (
    _e,
    { orgId, id, action, body }: { orgId: string; id: string; action: string; body?: unknown },
  ) => {
    if (!ACTIONS.has(action)) throw new Error(`Unknown leaked secret action "${action}"`);
    return cloudFetch(orgId, `/leaked-secrets/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    });
  },
);

ipcMain.handle("cloud_leaked_secrets_scan", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/leaked-secrets/scan", { method: "POST", body: "{}" });
});
