import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Resource ownership — cloud-mode only. Ownership is an org record about an
// org's resources; a local workspace has no org and no members to own
// anything, so the renderer wires this panel only when signed in.

ipcMain.handle("cloud_ownership_members", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/ownership/members");
});

ipcMain.handle(
  "cloud_ownership_get",
  async (_e, { orgId, resourceId }: { orgId: string; resourceId: string }) => {
    return cloudFetch(orgId, `/ownership/resource?resourceId=${encodeURIComponent(resourceId)}`);
  },
);

ipcMain.handle(
  "cloud_ownership_save",
  async (_e, { orgId, patch }: { orgId: string; patch: unknown }) => {
    return cloudFetch(orgId, "/ownership", { method: "PUT", body: JSON.stringify(patch) });
  },
);

ipcMain.handle(
  "cloud_ownership_clear",
  async (_e, { orgId, resourceId }: { orgId: string; resourceId: string }) => {
    return cloudFetch(orgId, `/ownership?resourceId=${encodeURIComponent(resourceId)}`, {
      method: "DELETE",
    });
  },
);
