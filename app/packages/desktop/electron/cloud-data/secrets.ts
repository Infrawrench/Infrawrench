import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

ipcMain.handle(
  "cloud_list_secret_versions",
  async (
    _e,
    {
      orgId,
      pluginId,
      resourceTypeId,
      resourceId,
      accountId,
      parentResourceId,
    }: {
      orgId: string;
      pluginId: string;
      resourceTypeId: string;
      resourceId: string;
      accountId: string;
      parentResourceId?: string;
    },
  ) => {
    const params: Record<string, string> = { resourceId, accountId };
    if (parentResourceId) params["parentResourceId"] = parentResourceId;
    const qs = new URLSearchParams(params).toString();
    return cloudFetch(
      orgId,
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/secret-versions?${qs}`,
    );
  },
);

ipcMain.handle(
  "cloud_access_secret_version",
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
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/secret-versions/access`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);

ipcMain.handle(
  "cloud_add_secret_version",
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
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/secret-versions/add`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);

ipcMain.handle(
  "cloud_modify_secret_version",
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
      `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/secret-versions/modify`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
);
