import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// IaC reconciliation (the ClickOps detector) — cloud-mode only. The inventory
// it classifies is the org's *synced* resources, which only exist in cloud
// mode; a local-only desktop has nothing to reconcile a state document
// against, so the panel says so rather than fetching.

ipcMain.handle("cloud_iac_states", async (_e, { orgId }: { orgId: string }) =>
  cloudFetch(orgId, "/iac/states"),
);

ipcMain.handle(
  "cloud_iac_upload_state",
  async (
    _e,
    {
      orgId,
      label,
      accountId,
      document,
    }: { orgId: string; label: string; accountId: string | null; document: string },
  ) =>
    cloudFetch(orgId, "/iac/states", {
      method: "POST",
      body: JSON.stringify({ label, accountId, document }),
    }),
);

ipcMain.handle(
  "cloud_iac_delete_state",
  async (_e, { orgId, stateId }: { orgId: string; stateId: string }) =>
    cloudFetch(orgId, `/iac/states/${encodeURIComponent(stateId)}`, { method: "DELETE" }),
);

ipcMain.handle(
  "cloud_iac_reconcile",
  async (_e, { orgId, stateId }: { orgId: string; stateId: string }) =>
    cloudFetch(orgId, `/iac/reconciliation?stateId=${encodeURIComponent(stateId)}`),
);

ipcMain.handle(
  "cloud_iac_import_plan",
  async (_e, { orgId, resourceIds }: { orgId: string; resourceIds: string[] }) =>
    cloudFetch(orgId, "/iac/import-plan", {
      method: "POST",
      body: JSON.stringify({ resourceIds }),
    }),
);

ipcMain.handle(
  "cloud_iac_resource_status",
  async (_e, { orgId, resourceId }: { orgId: string; resourceId: string }) =>
    cloudFetch(orgId, `/iac/resource?resourceId=${encodeURIComponent(resourceId)}`),
);
