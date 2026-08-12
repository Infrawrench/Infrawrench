import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Public status pages — cloud-mode only, like the probes they publish: the
// checks run in the cloud poller and the page is served by the cloud web app,
// so there is nothing a local workspace could publish.

ipcMain.handle("cloud_status_pages_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/status-pages");
});

ipcMain.handle(
  "cloud_status_pages_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/status-pages", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_status_pages_update",
  async (_e, { orgId, pageId, patch }: { orgId: string; pageId: string; patch: unknown }) => {
    return cloudFetch(orgId, `/status-pages/${encodeURIComponent(pageId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_status_pages_rotate_slug",
  async (_e, { orgId, pageId }: { orgId: string; pageId: string }) => {
    return cloudFetch(orgId, `/status-pages/${encodeURIComponent(pageId)}/rotate-slug`, {
      method: "POST",
    });
  },
);

ipcMain.handle(
  "cloud_status_pages_delete",
  async (_e, { orgId, pageId }: { orgId: string; pageId: string }) => {
    return cloudFetch(orgId, `/status-pages/${encodeURIComponent(pageId)}`, { method: "DELETE" });
  },
);

ipcMain.handle(
  "cloud_status_pages_attach_hostname",
  async (_e, { orgId, pageId, hostname }: { orgId: string; pageId: string; hostname: string }) => {
    return cloudFetch(orgId, `/status-pages/${encodeURIComponent(pageId)}/custom-hostname`, {
      method: "POST",
      body: JSON.stringify({ hostname }),
    });
  },
);

ipcMain.handle(
  "cloud_status_pages_refresh_hostname",
  async (_e, { orgId, pageId }: { orgId: string; pageId: string }) => {
    return cloudFetch(
      orgId,
      `/status-pages/${encodeURIComponent(pageId)}/custom-hostname/refresh`,
      { method: "POST" },
    );
  },
);

ipcMain.handle(
  "cloud_status_pages_detach_hostname",
  async (_e, { orgId, pageId }: { orgId: string; pageId: string }) => {
    return cloudFetch(orgId, `/status-pages/${encodeURIComponent(pageId)}/custom-hostname`, {
      method: "DELETE",
    });
  },
);
