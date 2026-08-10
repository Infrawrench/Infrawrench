import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Posture checks — cloud mode. The findings are computed server-side over the
// org's synced rows (`GET /posture`, the same endpoint the web Posture screen
// and the CLI's `infrawrench posture` use). The local-mode counterpart lives
// in the renderer (src/lib/local-posture.ts), which runs the shared
// `computePostureFindings` over this machine's workspace.

ipcMain.handle("cloud_posture", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/posture");
});

// Accepting a finding is org state, not machine state, so cloud mode records
// it through the API — a dismissal made on this laptop has to be the same
// dismissal the web app, the alerts and everyone else's desktop see. Local
// mode writes its own SQLite table instead (src/lib/local-posture.ts).
ipcMain.handle(
  "cloud_posture_dismiss",
  async (
    _e,
    {
      orgId,
      resourceId,
      ruleId,
      reason,
    }: { orgId: string; resourceId: string; ruleId: string; reason?: string },
  ) => {
    return cloudFetch(orgId, "/posture/dismissals", {
      method: "POST",
      body: JSON.stringify({ resourceId, ruleId, reason: reason ?? null }),
    });
  },
);

ipcMain.handle(
  "cloud_posture_restore",
  async (
    _e,
    { orgId, resourceId, ruleId }: { orgId: string; resourceId: string; ruleId: string },
  ) => {
    const query = new URLSearchParams({ resourceId, ruleId });
    return cloudFetch(orgId, `/posture/dismissals?${query.toString()}`, { method: "DELETE" });
  },
);
