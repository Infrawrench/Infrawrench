import { ipcMain } from "electron";
import { getAccessToken } from "./cloud-auth";
import { CLOUD_URL } from "../env";
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

async function cloudFetch<T>(orgId: string, path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated to Infrawrench Cloud");

  const res = await fetch(`${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    let message: string;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      message = text;
    }
    throw new Error(`${res.status} ${message}`);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

ipcMain.handle(
  "cloud_ssh_keys_list",
  async (_e, { orgId }: { orgId: string }): Promise<CloudSshKey[]> => {
    return cloudFetch<CloudSshKey[]>(orgId, "/ssh-keys");
  },
);

ipcMain.handle(
  "cloud_ssh_keys_create",
  async (_e, { orgId, name }: { orgId: string; name: string }): Promise<CloudSshKey> => {
    return cloudFetch<CloudSshKey>(orgId, "/ssh-keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },
);

ipcMain.handle(
  "cloud_ssh_keys_delete",
  async (_e, { orgId, id }: { orgId: string; id: string }): Promise<void> => {
    await cloudFetch<unknown>(orgId, `/ssh-keys/${id}`, { method: "DELETE" });
  },
);
