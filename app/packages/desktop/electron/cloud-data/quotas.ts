import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Quota radar — cloud mode only. Collection runs in the cloud poller (it is
// credentialed, rate-limited and, on AWS, metered), and the feed is computed
// server-side over the collected readings (`GET /quotas`, the same endpoint the
// web Quotas screen uses). There is deliberately no local-mode counterpart:
// unlike the expiry radar, which computes over rows the desktop already holds,
// a quota reading requires a live provider call the desktop has no schedule to
// make and no stored history to fit a trend against.

ipcMain.handle("cloud_quotas", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/quotas");
});
