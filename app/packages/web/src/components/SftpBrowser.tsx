import { useCallback } from "react";
import { FileBrowser, formatErrorMessage } from "@infrawrench/ui";
import type { StorageObject } from "@infrawrench/plugin-base";
import { apiPost } from "@/lib/api";

interface SshKeyParams {
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}

export function SftpBrowser({ accountId, initialPath = "/", sshKeyId, sshHost, sshUsername }: { accountId: string; initialPath?: string; sshKeyId?: string; sshHost?: string; sshUsername?: string }) {
  const sshParams: SshKeyParams = sshKeyId ? {
    sshKeyId,
    ...(sshHost !== undefined ? { sshHost } : {}),
    ...(sshUsername !== undefined ? { sshUsername } : {}),
  } : {};

  const onList = useCallback(
    (path: string) =>
      apiPost<StorageObject[]>("/api/sftp/list", { accountId, path, ...sshParams }),
    [accountId, sshKeyId, sshHost, sshUsername],
  );

  const onUpload = useCallback(
    async (_bucket: string, key: string, file: File, _onProgress: (pct: number) => void) => {
      const formData = new FormData();
      formData.append("accountId", accountId);
      formData.append("remotePath", key);
      formData.append("file", file);
      if (sshKeyId) formData.append("sshKeyId", sshKeyId);
      if (sshHost) formData.append("sshHost", sshHost);
      if (sshUsername) formData.append("sshUsername", sshUsername);
      const resp = await fetch("/api/v1/sftp/upload", { method: "POST", body: formData });
      if (!resp.ok) throw new Error(await resp.text());
    },
    [accountId, sshKeyId, sshHost, sshUsername],
  );

  const onMakeFolder = useCallback(
    async (_bucket: string, key: string) => {
      await apiPost("/api/sftp/mkdir", { accountId, path: key, ...sshParams });
    },
    [accountId, sshKeyId, sshHost, sshUsername],
  );

  const onDelete = useCallback(
    async (_bucket: string, key: string, isDirectory?: boolean) => {
      await apiPost("/api/sftp/delete", { accountId, path: key, isDir: isDirectory ?? false, ...sshParams });
    },
    [accountId, sshKeyId, sshHost, sshUsername],
  );

  const onBatchDownload = useCallback(
    async (keys: string[]) => {
      const params = new URLSearchParams({
        accountId,
        paths: JSON.stringify(keys),
      });
      window.open(`/api/v1/sftp/download?${params.toString()}`);
    },
    [accountId],
  );

  return (
    <FileBrowser
      bucketName="/"
      pathMode="absolute"
      initialPrefix={initialPath}
      showFolderUpload={false}
      onList={onList}
      onUpload={onUpload}
      onMakeFolder={onMakeFolder}
      onDelete={onDelete}
      onBatchDownload={onBatchDownload}
      formatError={formatErrorMessage}
    />
  );
}
