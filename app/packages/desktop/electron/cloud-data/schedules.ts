import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Sleep/wake schedules — cloud-mode only. The rows live server-side and the
// cloud poller executes the transitions; local mode has no scheduler, so
// there is no local counterpart (same stance as the change timeline).

ipcMain.handle("cloud_schedules_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/schedules");
});

ipcMain.handle(
  "cloud_schedules_create",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, "/schedules", { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_schedules_update",
  async (
    _e,
    { orgId, scheduleId, patch }: { orgId: string; scheduleId: string; patch: unknown },
  ) => {
    return cloudFetch(orgId, `/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_schedules_delete",
  async (_e, { orgId, scheduleId }: { orgId: string; scheduleId: string }) => {
    await cloudFetch(orgId, `/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_schedules_preview",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, "/schedules/preview", { method: "POST", body: JSON.stringify(body) });
  },
);
