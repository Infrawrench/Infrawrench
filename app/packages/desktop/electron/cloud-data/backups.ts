import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Backup coverage — cloud only, deliberately. The coverage is computed
// server-side over the org's synced rows (`GET /backups`, the same endpoint
// the web Backups screen uses), and unlike posture there is no local-mode
// counterpart: recovery objectives are org state, and a local workspace has
// nowhere to keep them. The panel says so rather than rendering an empty
// screen.

ipcMain.handle("cloud_backups", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/backups");
});

ipcMain.handle("cloud_backup_policies", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/backups/policies");
});

ipcMain.handle(
  "cloud_backup_policy_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/backups/policies", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_backup_policy_update",
  async (_e, { orgId, policyId, patch }: { orgId: string; policyId: string; patch: unknown }) => {
    return cloudFetch(orgId, `/backups/policies/${encodeURIComponent(policyId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_backup_policy_delete",
  async (_e, { orgId, policyId }: { orgId: string; policyId: string }) => {
    return cloudFetch(orgId, `/backups/policies/${encodeURIComponent(policyId)}`, {
      method: "DELETE",
    });
  },
);
