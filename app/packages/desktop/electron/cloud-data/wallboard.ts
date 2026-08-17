import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// The wallboard — cloud only. Three of its four sources (declared incidents,
// query monitors, the sync pager's open incidents) are org state, and the
// fourth (synthetic probes) is run by the cloud poller.

ipcMain.handle("cloud_wallboard", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/wallboard");
});
