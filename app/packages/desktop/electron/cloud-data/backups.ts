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

// Restore drills — the Backups screen's fourth tab. Cloud only for the same
// reason the rest of the screen is: a drill is evidence the whole team reads.
ipcMain.handle("cloud_restore_drills", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/backups/drills");
});

ipcMain.handle(
  "cloud_restore_drill_record",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/backups/drills", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

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
