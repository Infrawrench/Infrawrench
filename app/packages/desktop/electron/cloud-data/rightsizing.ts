import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// "Oversized" right-sizing recommendations — cloud-mode only, like schedules:
// the 14-day percentiles live in the cloud metrics warehouse and the size
// catalogs need the org's account credentials, neither of which exists
// locally. Applying a recommendation reuses the existing
// `cloud_update_resource` channel (the resource edit path), so it needs no
// IPC of its own.

ipcMain.handle(
  "cloud_rightsizing_list",
  async (_e, { orgId, refresh }: { orgId: string; refresh?: boolean }) => {
    return cloudFetch(orgId, `/rightsizing${refresh ? "?refresh=true" : ""}`);
  },
);
