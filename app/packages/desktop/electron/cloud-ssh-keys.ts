import { ipcMain } from "electron";
import { cloudFetch } from "./cloud-data/shared";

interface CloudSshKey {
  id: string;
  name: string;
  publicKey: string;
  keyType: string | null;
  userId?: string;
  ownerEmail?: string;
  ownerName?: string;
  privateKey?: string;
}

ipcMain.handle(
  "cloud_ssh_keys_list",
  async (_e, { orgId }: { orgId: string }): Promise<CloudSshKey[]> => {
    return (await cloudFetch<CloudSshKey[]>(orgId, "/ssh-keys")) ?? [];
  },
);

ipcMain.handle(
  "cloud_ssh_keys_create",
  async (_e, { orgId, name }: { orgId: string; name: string }): Promise<CloudSshKey> => {
    const result = await cloudFetch<CloudSshKey>(orgId, "/ssh-keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (!result) throw new Error("Cloud SSH key creation returned no response body");
    return result;
  },
);

ipcMain.handle(
  "cloud_ssh_keys_delete",
  async (_e, { orgId, id }: { orgId: string; id: string }): Promise<void> => {
    await cloudFetch<unknown>(orgId, `/ssh-keys/${id}`, { method: "DELETE" });
  },
);
