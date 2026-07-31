import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Orphan & idle resource finder — cloud-mode only. Classification runs
// server-side over the org's synced resources; local mode has no equivalent
// aggregate (the CLI's `infrawrench orphans` shares this cloud endpoint).

ipcMain.handle("cloud_orphans_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/orphans");
});
