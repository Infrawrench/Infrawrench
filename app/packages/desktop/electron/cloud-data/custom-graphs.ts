import { ipcMain } from "electron";
import { cloudFetch, cloudFetchText } from "./shared";

// Custom graphs — cloud-mode only (the script runs in the web server's
// sandbox against org data; there is no local-SQLite equivalent).

ipcMain.handle("cloud_list_custom_graphs", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, "/custom-graphs")) ?? [];
});

ipcMain.handle(
  "cloud_get_custom_graph",
  async (_e, { orgId, graphId }: { orgId: string; graphId: string }) => {
    return cloudFetch(orgId, `/custom-graphs/${encodeURIComponent(graphId)}`);
  },
);

ipcMain.handle(
  "cloud_create_custom_graph",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, "/custom-graphs", { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_update_custom_graph",
  async (_e, { orgId, graphId, body }: { orgId: string; graphId: string; body: unknown }) => {
    return cloudFetch(orgId, `/custom-graphs/${encodeURIComponent(graphId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_delete_custom_graph",
  async (_e, { orgId, graphId }: { orgId: string; graphId: string }) => {
    return cloudFetch(orgId, `/custom-graphs/${encodeURIComponent(graphId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_render_custom_graph",
  async (_e, { orgId, graphId, request }: { orgId: string; graphId: string; request: unknown }) => {
    return cloudFetch(orgId, `/custom-graphs/${encodeURIComponent(graphId)}/render`, {
      method: "POST",
      body: JSON.stringify(request ?? {}),
    });
  },
);

// Org-specific since the read-only infra half reflects connected accounts —
// this cannot be the static string the renderer once imported.
ipcMain.handle("cloud_custom_graph_typings", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetchText(orgId, "/custom-graphs/typings");
});

ipcMain.handle(
  "cloud_check_custom_graph",
  async (_e, { orgId, source }: { orgId: string; source: string }) => {
    return cloudFetch(orgId, "/custom-graphs/check", {
      method: "POST",
      body: JSON.stringify({ source }),
    });
  },
);
