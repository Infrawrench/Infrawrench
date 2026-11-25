/**
 * Downloading and restoring a state version.
 *
 * The contract does not define these yet (`git/packages/terraform/NOTES.md`
 * lists the routes the worker will serve), so they are plain requests to
 * those paths rather than calls through the typed client. The dev mock has no
 * transport for them, so there they go to the mock's state directly; that
 * branch is a build-time constant and is not in a production build.
 */
import { ApiError, fillPath } from "../../api/client";
import type { RepoRef } from "../../lib/paths";

const BASE = "/api/repos/:owner/:repo/terraform/workspaces/:workspace/state-versions/:versionId";

const pathOf = (repo: RepoRef, workspace: string, versionId: string, action: string): string =>
  `${fillPath(BASE, { ...repo, workspace, versionId })}/${action}`;

async function fail(response: Response): Promise<never> {
  let message = `Request failed (${response.status})`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") message = body.error;
    if (typeof body.code === "string") code = body.code;
  } catch {
    // Not JSON: the status says enough.
  }
  throw new ApiError(response.status, message, code);
}

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

/** Saves a state version's document as `<workspace>-<serial>.tfstate`. It holds secrets. */
export async function downloadStateVersion(
  repo: RepoRef,
  workspace: string,
  version: { readonly id: string; readonly serial: number },
): Promise<void> {
  const filename = `${workspace}-${version.serial}.tfstate`;
  if (import.meta.env.VITE_GIT_MOCK === "1") {
    const [{ stateDocument }, { findRepository }] = await Promise.all([
      import("../../mock/terraform-data"),
      import("../../mock/db"),
    ]);
    const text = stateDocument(findRepository(repo.owner, repo.repo), workspace, version.id);
    save(new Blob([text], { type: "application/json" }), filename);
    return;
  }
  const response = await fetch(pathOf(repo, workspace, version.id, "download"), {
    credentials: "same-origin",
  });
  if (!response.ok) await fail(response);
  save(await response.blob(), filename);
}

/** Writes an older version's document again as the newest version, with the next serial. */
export async function restoreStateVersion(
  repo: RepoRef,
  workspace: string,
  versionId: string,
): Promise<void> {
  if (import.meta.env.VITE_GIT_MOCK === "1") {
    const [{ restoreVersion }, { findRepository, requireUser }] = await Promise.all([
      import("../../mock/terraform-data"),
      import("../../mock/db"),
    ]);
    restoreVersion(findRepository(repo.owner, repo.repo), workspace, versionId, requireUser());
    return;
  }
  const response = await fetch(pathOf(repo, workspace, versionId, "restore"), {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) await fail(response);
}
