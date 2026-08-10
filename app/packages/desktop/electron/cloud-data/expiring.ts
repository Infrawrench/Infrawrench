import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Expiry radar — cloud mode. The feed is computed server-side over the org's
// synced rows (`GET /expiring`, the same endpoint the web Expiring screen and
// the CLI's `infrawrench expiring` use). The local-mode counterpart lives in
// the renderer (src/lib/local-expiring.ts), which runs the shared
// `computeExpiryFeed` over this machine's workspace.

ipcMain.handle("cloud_expiring", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/expiring");
});
