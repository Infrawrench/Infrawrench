import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

ipcMain.handle(
  "cloud_connect_templates",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/connect/templates`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_secret_export",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/connect/secret-export`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_env_deploy",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/connect/env-deploy`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);
