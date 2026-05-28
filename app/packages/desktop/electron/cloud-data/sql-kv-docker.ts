import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

ipcMain.handle("cloud_sql_query", async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
  return cloudFetch(orgId, `/sql/query`, { method: "POST", body: JSON.stringify(body) });
});

ipcMain.handle(
  "cloud_list_artifacts",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/artifacts/list`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_sql_execute",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/sql/execute`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_sql_estimate",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/sql/estimate`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_kv_command",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/kv/command`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_kv_browser_list",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/kv-browser/list`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_kv_browser_get",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/kv-browser/get`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_kv_browser_put",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/kv-browser/put`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_kv_browser_delete",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/kv-browser/delete`, { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_docker_command",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/docker/command`, { method: "POST", body: JSON.stringify(body) });
  },
);
