import { ipcMain } from "electron";
import { getAccessToken } from "./cloud-auth";

const CLOUD_URL = process.env["INFRAWRENCH_CLOUD_URL"] ?? "http://localhost:3000";

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

async function cloudFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated to Infrawrench Cloud");

  const res = await fetch(`${CLOUD_URL}/api${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
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
    throw new Error(message);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

ipcMain.handle("cloud_ssh_keys_list", async (): Promise<CloudSshKey[]> => {
  return cloudFetch<CloudSshKey[]>("/ssh-keys");
});

ipcMain.handle(
  "cloud_ssh_keys_create",
  async (_e, { name }: { name: string }): Promise<CloudSshKey> => {
    return cloudFetch<CloudSshKey>("/ssh-keys", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },
);

ipcMain.handle(
  "cloud_ssh_keys_delete",
  async (_e, { id }: { id: string }): Promise<void> => {
    await cloudFetch<unknown>(`/ssh-keys/${id}`, { method: "DELETE" });
  },
);
