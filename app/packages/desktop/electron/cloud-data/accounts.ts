import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

ipcMain.handle("cloud_list_accounts", async (_e, { orgId }: { orgId: string }) => {
  return (
    (await cloudFetch<
      Array<{ id: string; pluginId: string; displayName: string; createdAt: string }>
    >(orgId, "/accounts")) ?? []
  );
});

ipcMain.handle(
  "cloud_create_account",
  async (
    _e,
    {
      orgId,
      pluginId,
      displayName,
      credentials,
    }: {
      orgId: string;
      pluginId: string;
      displayName: string;
      credentials: Record<string, string>;
    },
  ) => {
    return cloudFetch<{ id: string }>(orgId, "/accounts", {
      method: "POST",
      body: JSON.stringify({ pluginId, displayName, credentials }),
    });
  },
);

ipcMain.handle(
  "cloud_list_account_resources",
  async (_e, { orgId, accountId }: { orgId: string; accountId: string }) => {
    return (
      (await cloudFetch<Array<Record<string, unknown>>>(
        orgId,
        `/accounts/${encodeURIComponent(accountId)}/resources?topLevelOnly=true`,
      )) ?? []
    );
  },
);

ipcMain.handle(
  "cloud_get_account_detail",
  async (_e, { orgId, accountId }: { orgId: string; accountId: string }) => {
    return cloudFetch(orgId, `/accounts/${encodeURIComponent(accountId)}/detail`);
  },
);

ipcMain.handle(
  "cloud_sync_account_type",
  async (
    _e,
    { orgId, accountId, typeId }: { orgId: string; accountId: string; typeId: string },
  ) => {
    return cloudFetch(
      orgId,
      `/accounts/${encodeURIComponent(accountId)}/sync-type/${encodeURIComponent(typeId)}`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
);

ipcMain.handle(
  "cloud_delete_account",
  async (_e, { orgId, accountId }: { orgId: string; accountId: string }) => {
    await cloudFetch(orgId, `/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_rename_account",
  async (
    _e,
    { orgId, accountId, displayName }: { orgId: string; accountId: string; displayName: string },
  ) => {
    return cloudFetch<{ id: string; displayName: string }>(
      orgId,
      `/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ displayName }),
      },
    );
  },
);
