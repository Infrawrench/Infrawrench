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
