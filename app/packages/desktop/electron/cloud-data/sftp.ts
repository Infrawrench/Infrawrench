import { ipcMain } from "electron";
import { getAccessToken } from "../cloud-auth";
import { CLOUD_URL } from "../../env";
import { cloudFetch, fetchWithHostKeyPrompt } from "./shared";

ipcMain.handle("cloud_sftp_list", async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
  return cloudFetch(orgId, `/sftp/list`, { method: "POST", body: JSON.stringify(body) });
});

ipcMain.handle(
  "cloud_sftp_mkdir",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    await cloudFetch(orgId, `/sftp/mkdir`, { method: "POST", body: JSON.stringify(body) });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_sftp_delete",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    await cloudFetch(orgId, `/sftp/delete`, { method: "POST", body: JSON.stringify(body) });
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_sftp_upload",
  async (
    _e,
    {
      orgId,
      accountId,
      remotePath,
      data,
      filename,
      sshKeyId,
      sshHost,
      sshUsername,
    }: {
      orgId: string;
      accountId: string;
      remotePath: string;
      data: Buffer;
      filename?: string;
      sshKeyId?: string;
      sshHost?: string;
      sshUsername?: string;
    },
  ) => {
    const token = await getAccessToken();
    if (!token) throw new Error("Not authenticated to Infrawrench Cloud");
    const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/v1/sftp/upload`;
    const buildInit = (): RequestInit => {
      const form = new FormData();
      form.append("accountId", accountId);
      form.append("remotePath", remotePath);
      form.append(
        "file",
        new Blob([new Uint8Array(data)]),
        filename ?? remotePath.split("/").pop() ?? "upload",
      );
      if (sshKeyId) form.append("sshKeyId", sshKeyId);
      if (sshHost) form.append("sshHost", sshHost);
      if (sshUsername) form.append("sshUsername", sshUsername);
      return {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      };
    };
    const res = await fetchWithHostKeyPrompt(orgId, url, buildInit, token);
    if (!res.ok)
      throw new Error(`Upload failed: ${res.status} ${await res.text().catch(() => "")}`);
    return { ok: true };
  },
);

ipcMain.handle(
  "cloud_sftp_download",
  async (
    _e,
    {
      orgId,
      accountId,
      remotePath,
      localPath,
      sshKeyId,
      sshHost,
      sshUsername,
    }: {
      orgId: string;
      accountId: string;
      remotePath: string;
      localPath: string;
      sshKeyId?: string;
      sshHost?: string;
      sshUsername?: string;
    },
  ) => {
    const token = await getAccessToken();
    if (!token) throw new Error("Not authenticated to Infrawrench Cloud");
    const params = new URLSearchParams({
      accountId,
      paths: JSON.stringify([remotePath]),
      ...(sshKeyId ? { sshKeyId } : {}),
      ...(sshHost ? { sshHost } : {}),
      ...(sshUsername ? { sshUsername } : {}),
    });
    const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/v1/sftp/download?${params}`;
    const buildInit = (): RequestInit => ({
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await fetchWithHostKeyPrompt(orgId, url, buildInit, token);
    if (!res.ok)
      throw new Error(`Download failed: ${res.status} ${await res.text().catch(() => "")}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(localPath, buf);
    return { ok: true };
  },
);
