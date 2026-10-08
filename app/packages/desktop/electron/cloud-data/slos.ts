import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// SLOs: cloud-mode only (evaluated by the cloud poller against the cloud
// metric store, alerting through the org's routing rules).

ipcMain.handle("cloud_slos_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/slos");
});

ipcMain.handle("cloud_slos_sources", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/slos/sources");
});

ipcMain.handle("cloud_slos_get", async (_e, { orgId, sloId }: { orgId: string; sloId: string }) => {
  return cloudFetch(orgId, `/slos/${encodeURIComponent(sloId)}`);
});

ipcMain.handle(
  "cloud_slos_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/slos", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_slos_update",
  async (_e, { orgId, sloId, patch }: { orgId: string; sloId: string; patch: unknown }) => {
    return cloudFetch(orgId, `/slos/${encodeURIComponent(sloId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_slos_delete",
  async (_e, { orgId, sloId }: { orgId: string; sloId: string }) => {
    return cloudFetch(orgId, `/slos/${encodeURIComponent(sloId)}`, { method: "DELETE" });
  },
);

ipcMain.handle(
  "cloud_slos_freeze",
  async (_e, { orgId, sloId, request }: { orgId: string; sloId: string; request: unknown }) => {
    return cloudFetch(orgId, `/slos/${encodeURIComponent(sloId)}/freeze`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  },
);
