/**
 * Downloading and restoring a state version, through the API's own endpoints
 * (`terraform.downloadStateVersion`, `terraform.restoreStateVersion`).
 */
import { api } from "../../api/client";
import type { RepoRef } from "../../lib/paths";

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const stateFilename = (workspace: string, serial: number): string =>
  `${workspace}-${serial}.tfstate`;

/**
 * Saves a state version's document as `<workspace>-<serial>.tfstate`, byte for
 * byte as Terraform wrote it. It holds secrets.
 */
export async function downloadStateVersion(
  repo: RepoRef,
  workspace: string,
  version: { readonly id: string; readonly serial: number },
): Promise<void> {
  const text = await api.terraform.downloadStateVersion({
    params: { ...repo, workspace, versionId: version.id },
  });
  save(new Blob([text], { type: "application/json" }), stateFilename(workspace, version.serial));
}

/** Writes an older version's document again as the newest version, with the next serial. */
export async function restoreStateVersion(
  repo: RepoRef,
  workspace: string,
  versionId: string,
): Promise<void> {
  await api.terraform.restoreStateVersion({ params: { ...repo, workspace, versionId } });
}
