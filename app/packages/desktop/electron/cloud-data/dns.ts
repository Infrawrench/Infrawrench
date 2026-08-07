import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// DNS inventory — cloud mode. The inventory is computed server-side over the
// org's synced rows (`GET /dns`, the same endpoint the web Domains screen and
// the CLI's `infrawrench dns` use). The local-mode counterpart lives in the
// renderer (src/lib/local-dns.ts), which runs the shared `computeDnsInventory`
// over this machine's workspace.

ipcMain.handle("cloud_dns", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/dns");
});
