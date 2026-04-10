import { useCallback } from "react";
import { FileBrowser } from "@infrawrench/ui";
import type { StorageObject } from "@infrawrench/plugin-base";
import type { SftpConfig } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import { formatErrorMessage } from "../lib/errors";

interface SftpBrowserPanelProps {
  sftpConfig: SftpConfig;
  initialPath?: string;
}

export function SftpBrowserPanel({ sftpConfig, initialPath = "/" }: SftpBrowserPanelProps) {
  const onList = useCallback(
    (path: string) => invoke<StorageObject[]>("sftp_list", { config: sftpConfig, path }),
    [sftpConfig],
  );

  const onUpload = useCallback(
    async (_bucket: string, key: string, file: File, _onProgress: (pct: number) => void) => {
      const buf = await file.arrayBuffer();
      await invoke("sftp_upload", { config: sftpConfig, remotePath: key, data: Buffer.from(buf) });
    },
    [sftpConfig],
  );

  const onMakeFolder = useCallback(
    async (_bucket: string, key: string) => {
      await invoke("sftp_mkdir", { config: sftpConfig, path: key });
    },
    [sftpConfig],
  );

  const onDelete = useCallback(
    async (_bucket: string, key: string, isDirectory?: boolean) => {
      await invoke("sftp_delete", { config: sftpConfig, path: key, isDir: isDirectory ?? false });
    },
    [sftpConfig],
  );

  const onBatchDownload = useCallback(
    async (keys: string[]) => {
      const result = await invoke<{ canceled?: boolean; filePaths?: string[] }>(
        "show_open_dialog",
        { properties: ["openDirectory"], title: "Choose download destination" },
      );
      if (result.canceled || !result.filePaths?.[0]) return;
      const destFolder = result.filePaths[0];

      await Promise.allSettled(keys.map(async (remotePath) => {
        const fileName = remotePath.split("/").pop() ?? remotePath;
        const localPath = `${destFolder}/${fileName}`;
        await invoke("sftp_download", { config: sftpConfig, remotePath, localPath });
      }));
    },
    [sftpConfig],
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
