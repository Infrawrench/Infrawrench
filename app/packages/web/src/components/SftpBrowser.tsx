import { useCallback } from "react";
import { FileBrowser, formatErrorMessage } from "@infrawrench/ui";
import type { StorageObject } from "@infrawrench/plugin-base";
import { apiPost } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import { useHostKeyTrust } from "@/lib/useHostKeyTrust";
import { tryParseHostKeyTrustResponse } from "@/lib/host-key-trust";

interface SshKeyParams {
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}

export function SftpBrowser({
  accountId,
  initialPath = "/",
  sshKeyId,
  sshHost,
  sshUsername,
}: {
  accountId: string;
  initialPath?: string;
  sshKeyId?: string;
  sshHost?: string;
  sshUsername?: string;
}) {
  const orgId = useOrgId();
  const { promptIfNeeded, withTrustPrompt, dialog: hostKeyDialog } = useHostKeyTrust(orgId);
  const sshParams: SshKeyParams = sshKeyId
    ? {
        sshKeyId,
        ...(sshHost !== undefined ? { sshHost } : {}),
        ...(sshUsername !== undefined ? { sshUsername } : {}),
      }
    : {};

  const onList = useCallback(
    (path: string) =>
      withTrustPrompt(() =>
        apiPost<StorageObject[]>(`/api/org/${orgId}/sftp/list`, {
          accountId,
          path,
          ...sshParams,
        }),
      ),
    [accountId, orgId, sshKeyId, sshHost, sshUsername, withTrustPrompt],
  );

  const onUpload = useCallback(
    async (_bucket: string, key: string, file: File, _onProgress: (pct: number) => void) => {
      const doUpload = async () => {
        const formData = new FormData();
        formData.append("accountId", accountId);
        formData.append("remotePath", key);
        formData.append("file", file);
        if (sshKeyId) formData.append("sshKeyId", sshKeyId);
        if (sshHost) formData.append("sshHost", sshHost);
        if (sshUsername) formData.append("sshUsername", sshUsername);
        const resp = await fetch(`/api/org/${orgId}/v1/sftp/upload`, {
          method: "POST",
          credentials: "include",
          body: formData,
        });
        if (!resp.ok) {
          const trustPayload = await tryParseHostKeyTrustResponse(resp);
          if (trustPayload) {
            const accepted = await promptIfNeeded(trustPayload);
            if (!accepted) throw new Error("Host key was not trusted");
            // Retry once after the user trusted the key.
            await doUpload();
            return;
          }
          throw new Error(await resp.text());
        }
      };
      await doUpload();
    },
    [accountId, orgId, sshKeyId, sshHost, sshUsername, promptIfNeeded],
  );

  const onMakeFolder = useCallback(
    async (_bucket: string, key: string) => {
      await withTrustPrompt(() =>
        apiPost(`/api/org/${orgId}/sftp/mkdir`, { accountId, path: key, ...sshParams }),
      );
    },
    [accountId, orgId, sshKeyId, sshHost, sshUsername, withTrustPrompt],
  );

  const onDelete = useCallback(
    async (_bucket: string, key: string, isDirectory?: boolean) => {
      await withTrustPrompt(() =>
        apiPost(`/api/org/${orgId}/sftp/delete`, {
          accountId,
          path: key,
          isDir: isDirectory ?? false,
          ...sshParams,
        }),
      );
    },
    [accountId, orgId, sshKeyId, sshHost, sshUsername, withTrustPrompt],
  );

  const onBatchDownload = useCallback(
    async (keys: string[], basePath: string) => {
      const params = new URLSearchParams({
        accountId,
        paths: JSON.stringify(keys),
        basePath,
        ...(sshKeyId !== undefined ? { sshKeyId } : {}),
        ...(sshHost !== undefined ? { sshHost } : {}),
        ...(sshUsername !== undefined ? { sshUsername } : {}),
      });
      const url = `/api/org/${orgId}/v1/sftp/download?${params.toString()}`;

      // The backend pre-flights the first file before streaming the zip,
      // so a trust failure surfaces here as a 409 with the structured
      // payload. We probe with a HEAD-ish GET (server still streams on
      // success) and, on 409, prompt the user and retry. On any other
      // success, hand the URL off to the browser to trigger the download.
      const probe = await fetch(url, { method: "GET", credentials: "include" });
      if (!probe.ok) {
        const trustPayload = await tryParseHostKeyTrustResponse(probe);
        if (trustPayload) {
          const accepted = await promptIfNeeded(trustPayload);
          if (!accepted) {
            probe.body?.cancel().catch(() => {});
            throw new Error("Host key was not trusted");
          }
          probe.body?.cancel().catch(() => {});
          window.open(url);
          return;
        }
        const text = await probe.text();
        throw new Error(text || `Download failed (HTTP ${probe.status})`);
      }

      // Stream the response body as a blob so we don't re-fetch and risk
      // the trust state changing between the probe and the real download.
      const blob = await probe.blob();
      const blobUrl = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } finally {
        // Defer revoke so the browser has time to start the download.
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
      }
    },
    [accountId, orgId, sshKeyId, sshHost, sshUsername, promptIfNeeded],
  );

  return (
    <>
      {hostKeyDialog}
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
    </>
  );
}
