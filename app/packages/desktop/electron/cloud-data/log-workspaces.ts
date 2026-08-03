import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Log workspace saved queries + log-capable resource discovery — cloud-mode
// only. The rows live server-side and the cloud poller evaluates the alert
// pass; local mode builds the same picker from the local resource table and
// the in-renderer plugin clients (see src/lib/log-workspace-client.ts), so
// only the cloud half needs IPC.

ipcMain.handle("cloud_log_workspaces_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/log-workspaces");
});

ipcMain.handle("cloud_log_workspaces_resources", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/log-workspaces/resources");
});

ipcMain.handle(
  "cloud_log_workspaces_create",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, "/log-workspaces", { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_log_workspaces_update",
  async (_e, { orgId, queryId, patch }: { orgId: string; queryId: string; patch: unknown }) => {
    return cloudFetch(orgId, `/log-workspaces/${encodeURIComponent(queryId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_log_workspaces_delete",
  async (_e, { orgId, queryId }: { orgId: string; queryId: string }) => {
    await cloudFetch(orgId, `/log-workspaces/${encodeURIComponent(queryId)}`, {
      method: "DELETE",
    });
    return { ok: true };
  },
);
