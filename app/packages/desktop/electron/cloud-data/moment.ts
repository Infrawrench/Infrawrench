import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// The moment view ("what changed around 03:14?") — cloud-mode only: every
// feed in the union (changes, incidents, anomalies, runs, deployments,
// audit, freezes, alert claims) is recorded server-side, so the desktop
// reads the merged window from the API rather than assembling it locally.

interface MomentArgs {
  orgId: string;
  at?: string;
  windowMinutes?: number;
}

ipcMain.handle("cloud_moment", async (_e, { orgId, at, windowMinutes }: MomentArgs) => {
  const params = new URLSearchParams();
  if (at) params.set("at", at);
  if (typeof windowMinutes === "number" && Number.isFinite(windowMinutes)) {
    params.set("window", String(windowMinutes));
  }
  const query = params.toString();
  return cloudFetch(orgId, query ? `/moment?${query}` : "/moment");
});
