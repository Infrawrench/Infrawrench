import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Extended-support findings, cloud mode: the server computes them over the
// org's synced rows and overlays billed charges where a plugin can read them.
// The local counterpart is `local_extended_support_list` (list price only).

ipcMain.handle(
  "cloud_extended_support_list",
  async (_e, { orgId, refresh }: { orgId: string; refresh?: boolean }) => {
    return cloudFetch(orgId, `/extended-support${refresh ? "?refresh=true" : ""}`);
  },
);
