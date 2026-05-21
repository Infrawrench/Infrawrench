import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

ipcMain.handle(
  "cloud_ssh_tunnel_create_account",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/ssh-tunnels/create-account`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_ssh_tunnel_exec",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/ssh-tunnels/exec`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);
