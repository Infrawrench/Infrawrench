import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Orphan & idle resource finder: cloud-mode only. Classification runs
// server-side over the org's synced resources; local mode has no equivalent
// aggregate (the CLI's `infrawrench orphans` shares this cloud endpoint).

ipcMain.handle("cloud_orphans_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/orphans");
});

// Metric-based idle rules: the tuning panel's overview, the settings write and
// a manual re-scan, all passthroughs to `/idle-findings`.
ipcMain.handle("cloud_idle_findings_overview", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/idle-findings");
});

ipcMain.handle(
  "cloud_idle_findings_save",
  async (_e, { orgId, settings }: { orgId: string; settings: unknown }) => {
    return cloudFetch(orgId, "/idle-findings/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },
);

ipcMain.handle("cloud_idle_findings_rescan", async (_e, { orgId }: { orgId: string }) => {
  await cloudFetch(orgId, "/idle-findings/rescan", { method: "POST" });
});
