import { useCallback } from "react";
import { FileBrowser, formatErrorMessage } from "@infrawrench/ui";
import type { StorageObject } from "@infrawrench/plugin-base";
import { apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";

/** Mirrors `MAX_BULK_KEYS` in `api/routes/storage.ts`, which rejects above it. */
const MAX_BULK_DOWNLOAD_KEYS = 100;

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
        xhr.open("POST", `/api/org/${orgId}/v1/storage/upload`);
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
      // Two things were wrong here and only one of them was visible. The route
      // takes `keys` as a JSON array, not a singular `key` per window — but it
      // also lives under `/v1/storage` (`api/index.ts`), where only
      // list/mkdir/delete are also served unversioned from
      // `connection-features.ts`. So the old request 404'd before it could
      // even 400, and fixing the payload alone would not have helped.
      //
      // Chunked at MAX_BULK_KEYS: the server rejects a larger selection
      // outright, and FileBrowser expands a selected folder to a flat key list
      // first, so one folder of >100 files would otherwise fail wholesale
      // rather than download.
      for (let i = 0; i < keys.length; i += MAX_BULK_DOWNLOAD_KEYS) {
        const batch = keys.slice(i, i + MAX_BULK_DOWNLOAD_KEYS);
        window.open(
          `/api/org/${orgId}/v1/storage/download?accountId=${encodeURIComponent(accountId)}&bucket=${encodeURIComponent(bucketName)}&keys=${encodeURIComponent(JSON.stringify(batch))}`,
          "_blank",
        );
      }
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
