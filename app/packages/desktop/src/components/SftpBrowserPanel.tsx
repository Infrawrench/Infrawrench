import { useCallback } from "react";
import { useGT } from "gt-react";
import { FileBrowser, formatErrorMessage, toast } from "@infrawrench/ui";
import type { StorageObject, SftpConfig } from "@infrawrench/plugin-base";
import { DesktopRpcClient, runRpc } from "../lib/rpc/client";
import { planSftpDownloads } from "../lib/sftp-download-plan";
import {
  cloudSftpList,
  cloudSftpMkdir,
  cloudSftpDelete,
  cloudSftpUpload,
  cloudSftpDownload,
} from "../lib/cloud-api";
import { showOpenDialog } from "../lib/app-shell";

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
  const gt = useGT();
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
      const config = sftpConfig;
      const entries = await runRpc(DesktopRpcClient.use((rpc) => rpc.SftpList({ config, path })));
      return [...entries];
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
      const config = sftpConfig;
      await runRpc(
        DesktopRpcClient.use((rpc) =>
          rpc.SftpUpload({ config, remotePath: key, data: new Uint8Array(buf) }),
        ),
      );
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
      const config = sftpConfig;
      await runRpc(DesktopRpcClient.use((rpc) => rpc.SftpMkdir({ config, path: key })));
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
      const config = sftpConfig;
      const isDir = isDirectory ?? false;
      await runRpc(DesktopRpcClient.use((rpc) => rpc.SftpDelete({ config, path: key, isDir })));
    },
    [sftpConfig, cloudContext],
  );

  const onBatchDownload = useCallback(
    async (keys: string[], basePath: string) => {
      const result = await showOpenDialog({
        properties: ["openDirectory"],
        title: "Choose download destination",
      });
      if (result.canceled || !result.filePaths?.[0]) return;
      const destFolder = result.filePaths[0];
      const { downloads, skipped } = planSftpDownloads(keys, basePath);
      if (skipped.length > 0) {
        toast.warning(
          gt("Skipped {count} file(s) with names that are unsafe to save locally", {
            count: skipped.length,
          }),
          { description: skipped.join("\n") },
        );
      }

      await Promise.allSettled(
        downloads.map(async ({ remotePath, relativePath }) => {
          if (cloudContext) {
            await cloudSftpDownload({
              orgId: cloudContext.orgId,
              accountId: cloudContext.accountId,
              remotePath,
              destFolder,
              relativePath,
              ...(cloudContext.sshKeyId ? { sshKeyId: cloudContext.sshKeyId } : {}),
              ...(cloudContext.sshHost ? { sshHost: cloudContext.sshHost } : {}),
              ...(cloudContext.sshUsername ? { sshUsername: cloudContext.sshUsername } : {}),
            });
            return;
          }
          if (!sftpConfig) throw new Error("SFTP not configured");
          const config = sftpConfig;
          await runRpc(
            DesktopRpcClient.use((rpc) =>
              rpc.SftpDownload({ config, remotePath, destFolder, relativePath }),
            ),
          );
        }),
      );
    },
    [sftpConfig, cloudContext, gt],
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
