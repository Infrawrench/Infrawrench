import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

ipcMain.handle(
  "cloud_fetch_metrics",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      body,
    }: { orgId: string; pluginId: string; resourceTypeId: string; body: unknown },
  ) => {
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/metrics`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);

ipcMain.handle(
  "cloud_fetch_peer_panes",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      body,
    }: { orgId: string; pluginId: string; resourceTypeId: string; body: unknown },
  ) => {
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/peer-panes`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);
