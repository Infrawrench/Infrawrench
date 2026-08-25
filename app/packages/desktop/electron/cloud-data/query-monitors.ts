import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Query monitors — cloud only, and not merely because the rows are org state:
// the schedule is run by the cloud poller, so a monitor created on one laptop
// would only run while that laptop was open. The panel says so.

ipcMain.handle("cloud_query_monitors", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/query-monitors");
});

ipcMain.handle("cloud_query_monitor_targets", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/query-monitors/targets");
});

ipcMain.handle(
  "cloud_query_monitor_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/query-monitors", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_query_monitor_update",
  async (_e, { orgId, monitorId, patch }: { orgId: string; monitorId: string; patch: unknown }) => {
    return cloudFetch(orgId, `/query-monitors/${encodeURIComponent(monitorId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_query_monitor_delete",
  async (_e, { orgId, monitorId }: { orgId: string; monitorId: string }) => {
    return cloudFetch(orgId, `/query-monitors/${encodeURIComponent(monitorId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_query_monitor_test",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/query-monitors/test", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);
