import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// The wallboard — cloud only. Two of its three sources (declared incidents and
// the sync pager's open incidents) are org state, and the third (synthetic
// probes) is run by the cloud poller.

ipcMain.handle("cloud_wallboard", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/wallboard");
});
