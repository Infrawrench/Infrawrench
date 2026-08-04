import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Resource leases (TTL) — cloud-mode only. The rows live server-side and the
// cloud poller runs the auto-delete pass; local mode has no lease store, so
// there is no local counterpart (same stance as sleep/wake schedules).

ipcMain.handle(
  "cloud_leases_get_resource",
  async (_e, { orgId, resourceId }: { orgId: string; resourceId: string }) => {
    return cloudFetch(orgId, `/leases/resource?resourceId=${encodeURIComponent(resourceId)}`);
  },
);

ipcMain.handle("cloud_leases_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/leases");
});

ipcMain.handle(
  "cloud_leases_create",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, "/leases", { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_leases_update",
  async (_e, { orgId, leaseId, patch }: { orgId: string; leaseId: string; patch: unknown }) => {
    return cloudFetch(orgId, `/leases/${encodeURIComponent(leaseId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_leases_cancel",
  async (_e, { orgId, leaseId }: { orgId: string; leaseId: string }) => {
    return cloudFetch(orgId, `/leases/${encodeURIComponent(leaseId)}/cancel`, { method: "POST" });
  },
);

ipcMain.handle(
  "cloud_leases_delete",
  async (_e, { orgId, leaseId }: { orgId: string; leaseId: string }) => {
    await cloudFetch(orgId, `/leases/${encodeURIComponent(leaseId)}`, { method: "DELETE" });
    return { ok: true };
  },
);
