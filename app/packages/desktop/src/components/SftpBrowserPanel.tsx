import { useCallback } from "react";
import { FileBrowser, formatErrorMessage } from "@infrawrench/ui";
import type { StorageObject, SftpConfig } from "@infrawrench/plugin-base";
import { invoke } from "../lib/invoke";
import {
  cloudSftpList,
  cloudSftpMkdir,
  cloudSftpDelete,
  cloudSftpUpload,
  cloudSftpDownload,
} from "../lib/cloud-api";

interface SftpCloudContext {
  orgId: string;
  accountId: string;
  resourceId?: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}

interface SftpBrowserPanelProps {
  sftpConfig?: SftpConfig;
  cloudContext?: SftpCloudContext;
  initialPath?: string;
}

export function SftpBrowserPanel({
  sftpConfig,
  cloudContext,
  initialPath = "/",
}: SftpBrowserPanelProps) {
  const onList = useCallback(
    async (path: string) => {
      if (cloudContext) {
        return (await cloudSftpList(cloudContext.orgId, {
          accountId: cloudContext.accountId,
          ...(cloudContext.resourceId ? { resourceId: cloudContext.resourceId } : {}),
          path,
          ...(cloudContext.sshKeyId ? { sshKeyId: cloudContext.sshKeyId } : {}),
          ...(cloudContext.sshHost ? { sshHost: cloudContext.sshHost } : {}),
          ...(cloudContext.sshUsername ? { sshUsername: cloudContext.sshUsername } : {}),
        })) as StorageObject[];
      }
      if (!sftpConfig) throw new Error("SFTP not configured");
      return invoke<StorageObject[]>("sftp_list", { config: sftpConfig, path });
    },
    [sftpConfig, cloudContext],
  );

  const onUpload = useCallback(
    async (_bucket: string, key: string, file: File, _onProgress: (pct: number) => void) => {
      const buf = await file.arrayBuffer();
      if (cloudContext) {
        await cloudSftpUpload({
          orgId: cloudContext.orgId,
          accountId: cloudContext.accountId,
          remotePath: key,
          data: new Uint8Array(buf),
          filename: file.name,
          ...(cloudContext.sshKeyId ? { sshKeyId: cloudContext.sshKeyId } : {}),
          ...(cloudContext.sshHost ? { sshHost: cloudContext.sshHost } : {}),
          ...(cloudContext.sshUsername ? { sshUsername: cloudContext.sshUsername } : {}),
        });
        return;
      }
      if (!sftpConfig) throw new Error("SFTP not configured");
      await invoke("sftp_upload", { config: sftpConfig, remotePath: key, data: Buffer.from(buf) });
    },
    [sftpConfig, cloudContext],
  );

  const onMakeFolder = useCallback(
    async (_bucket: string, key: string) => {
      if (cloudContext) {
        await cloudSftpMkdir(cloudContext.orgId, {
          accountId: cloudContext.accountId,
          ...(cloudContext.resourceId ? { resourceId: cloudContext.resourceId } : {}),
          path: key,
          ...(cloudContext.sshKeyId ? { sshKeyId: cloudContext.sshKeyId } : {}),
          ...(cloudContext.sshHost ? { sshHost: cloudContext.sshHost } : {}),
          ...(cloudContext.sshUsername ? { sshUsername: cloudContext.sshUsername } : {}),
        });
        return;
      }
      if (!sftpConfig) throw new Error("SFTP not configured");
      await invoke("sftp_mkdir", { config: sftpConfig, path: key });
    },
    [sftpConfig, cloudContext],
  );

  const onDelete = useCallback(
    async (_bucket: string, key: string, isDirectory?: boolean) => {
      if (cloudContext) {
        await cloudSftpDelete(cloudContext.orgId, {
          accountId: cloudContext.accountId,
          ...(cloudContext.resourceId ? { resourceId: cloudContext.resourceId } : {}),
          path: key,
          isDir: isDirectory ?? false,
          ...(cloudContext.sshKeyId ? { sshKeyId: cloudContext.sshKeyId } : {}),
          ...(cloudContext.sshHost ? { sshHost: cloudContext.sshHost } : {}),
          ...(cloudContext.sshUsername ? { sshUsername: cloudContext.sshUsername } : {}),
        });
        return;
      }
      if (!sftpConfig) throw new Error("SFTP not configured");
      await invoke("sftp_delete", { config: sftpConfig, path: key, isDir: isDirectory ?? false });
    },
    [sftpConfig, cloudContext],
  );

  const onBatchDownload = useCallback(
    async (keys: string[], basePath: string) => {
      const result = await invoke<{ canceled?: boolean; filePaths?: string[] }>(
        "show_open_dialog",
        { properties: ["openDirectory"], title: "Choose download destination" },
      );
      if (result.canceled || !result.filePaths?.[0]) return;
      const destFolder = result.filePaths[0];
      const normalizedBase = basePath.endsWith("/") ? basePath : basePath ? `${basePath}/` : "";

      await Promise.allSettled(
        keys.map(async (remotePath) => {
          const rel =
            normalizedBase && remotePath.startsWith(normalizedBase)
              ? remotePath.slice(normalizedBase.length)
              : (remotePath.split("/").pop() ?? remotePath);
          const localPath = `${destFolder}/${rel}`;
          if (cloudContext) {
            await cloudSftpDownload({
              orgId: cloudContext.orgId,
              accountId: cloudContext.accountId,
              remotePath,
              localPath,
              ...(cloudContext.sshKeyId ? { sshKeyId: cloudContext.sshKeyId } : {}),
              ...(cloudContext.sshHost ? { sshHost: cloudContext.sshHost } : {}),
              ...(cloudContext.sshUsername ? { sshUsername: cloudContext.sshUsername } : {}),
            });
            return;
          }
          if (!sftpConfig) throw new Error("SFTP not configured");
          await invoke("sftp_download", { config: sftpConfig, remotePath, localPath });
        }),
      );
    },
    [sftpConfig, cloudContext],
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
