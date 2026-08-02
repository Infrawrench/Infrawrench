import { useCallback } from "react";
import { FileBrowser, formatErrorMessage } from "@infrawrench/ui";
import type { StorageObject } from "@infrawrench/plugin-base";
import { apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

export function StorageBrowser({
  accountId,
  bucketName,
}: {
  accountId: string;
  bucketName: string;
}) {
  const orgId = useOrgId();

  const onList = useCallback(
    (prefix: string) =>
      apiPost<StorageObject[]>(`/api/org/${orgId}/storage/list`, {
        accountId,
        bucket: bucketName,
        prefix,
      }),
    [accountId, bucketName, orgId],
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
        xhr.open("POST", `/api/org/${orgId}/storage/upload`);
        xhr.send(formData);
      });
    },
    [accountId, orgId],
  );

  const onMakeFolder = useCallback(
    async (bucket: string, key: string) => {
      await apiPost(`/api/org/${orgId}/storage/mkdir`, { accountId, bucket, key });
    },
    [accountId, orgId],
  );

  const onDelete = useCallback(
    async (bucket: string, key: string) => {
      await apiPost(`/api/org/${orgId}/storage/delete`, { accountId, bucket, key });
    },
    [accountId, orgId],
  );

  const onBatchDownload = useCallback(
    async (keys: string[]) => {
      // One request carrying the whole selection. The route takes `keys` as a
      // JSON array — it was being sent as a singular `key` per window, which
      // the handler rejects outright (`Missing accountId, bucket, or keys`),
      // so downloads 400'd for every plugin. It also streams a zip for a
      // multi-file selection, which the per-key loop could never produce.
      window.open(
        `/api/org/${orgId}/storage/download?accountId=${encodeURIComponent(accountId)}&bucket=${encodeURIComponent(bucketName)}&keys=${encodeURIComponent(JSON.stringify(keys))}`,
        "_blank",
      );
    },
    [accountId, bucketName, orgId],
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
