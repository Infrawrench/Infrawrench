import { safeRelativePathSegments } from "@infrawrench/client-core";

export interface SftpDownloadPlan {
  downloads: { remotePath: string; relativePath: string }[];
  /** Remote paths whose names cannot be written safely under the destination. */
  skipped: string[];
}

/**
 * Maps the remote files of a batch download to paths relative to the chosen
 * destination folder, keeping the layout beneath `basePath`. Remote names are
 * untrusted (a server can list `..`, and `..\x` is a legal Linux name that
 * Windows reads as a parent hop), so any entry that is not a plain relative
 * path is skipped for the caller to report. The main process re-validates.
 */
export function planSftpDownloads(remotePaths: string[], basePath: string): SftpDownloadPlan {
  const normalizedBase = basePath.endsWith("/") ? basePath : basePath ? `${basePath}/` : "";
  const plan: SftpDownloadPlan = { downloads: [], skipped: [] };
  for (const remotePath of remotePaths) {
    const relativePath =
      normalizedBase && remotePath.startsWith(normalizedBase)
        ? remotePath.slice(normalizedBase.length)
        : (remotePath.split("/").pop() ?? remotePath);
    if (safeRelativePathSegments(relativePath)) {
      plan.downloads.push({ remotePath, relativePath });
    } else {
      plan.skipped.push(remotePath);
    }
  }
  return plan;
}
