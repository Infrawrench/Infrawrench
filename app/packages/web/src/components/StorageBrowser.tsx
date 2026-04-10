import { useCallback } from "react";
import { FileBrowser, formatErrorMessage } from "@infrawrench/ui";
import type { StorageObject } from "@infrawrench/plugin-base";
import { apiPost } from "@/lib/api";

export function StorageBrowser({ accountId, bucketName }: { accountId: string; bucketName: string }) {
  const onList = useCallback(
    (prefix: string) =>
      apiPost<StorageObject[]>("/api/storage/list", { accountId, bucket: bucketName, prefix }),
    [accountId, bucketName],
  );

  const onUpload = useCallback(
    async (bucket: string, key: string, file: File, onProgress: (pct: number) => void) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("accountId", accountId);
      formData.append("bucket", bucket);
      formData.append("key", key);

      const xhr = new XMLHttpRequest();
      await new Promise<void>((resolve, reject) => {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        });
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: ${xhr.statusText}`));
        });
        xhr.addEventListener("error", () => reject(new Error("Upload failed")));
        xhr.open("POST", "/api/v1/storage/upload");
        xhr.send(formData);
      });
    },
    [accountId],
  );

  const onMakeFolder = useCallback(
    async (bucket: string, key: string) => {
      await apiPost("/api/storage/mkdir", { accountId, bucket, key });
    },
    [accountId],
  );

  const onDelete = useCallback(
    async (bucket: string, key: string) => {
      await apiPost("/api/storage/delete", { accountId, bucket, key });
    },
    [accountId],
  );

  const onBatchDownload = useCallback(
    async (keys: string[]) => {
      for (const key of keys) {
        window.open(`/api/v1/storage/download?accountId=${encodeURIComponent(accountId)}&bucket=${encodeURIComponent(bucketName)}&key=${encodeURIComponent(key)}`, "_blank");
      }
    },
    [accountId, bucketName],
  );

  return (
    <FileBrowser
      bucketName={bucketName}
      onList={onList}
      onUpload={onUpload}
      onMakeFolder={onMakeFolder}
      onDelete={onDelete}
      onBatchDownload={onBatchDownload}
      formatError={formatErrorMessage}
    />
  );
}
