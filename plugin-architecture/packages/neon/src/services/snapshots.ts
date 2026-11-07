import { formatBytes, type ResourceInstance } from "@infrawrench/plugin-base";
import type { Api, Snapshot } from "@neondatabase/api-client";
import { readChildren, type ListRun } from "./list-run.js";
import {
  hasStringFields,
  isNotEnabled,
  requireValidRows,
  resourceId,
  validatedObject,
  type BranchRef,
} from "./common.js";

/** The fields the document requires of a snapshot. */
const SNAPSHOT_REQUIRED_FIELDS = ["id", "name", "created_at"] as const;

function isSnapshot(value: unknown): value is Snapshot {
  return hasStringFields(value, SNAPSHOT_REQUIRED_FIELDS);
}

function buildSnapshotResource(
  accountId: string,
  projectId: string,
  snap: Snapshot,
): ResourceInstance {
  const externalId = `${projectId}/${snap.id}`;
  const size = snap.full_size ?? snap.diff_size;
  const sourceBranchId = snap.source_branch_id ?? "";

  return {
    id: resourceId(accountId, "neon-snapshot", externalId),
    pluginId: "neon",
    resourceTypeId: "neon-snapshot",
    accountId,
    displayName: snap.name,
    fields: {
      name: snap.name,
      projectId,
      sourceBranchId,
      manual: snap.manual ?? false,
      size: typeof size === "number" ? formatBytes(size) : "",
      lsn: snap.lsn ?? "",
      timestamp: snap.timestamp ?? "",
      createdAt: snap.created_at,
      expiresAt: snap.expires_at ?? "",
    },
    resolvedOutputs: { snapshotId: snap.id, projectId },
    secretStates: [],
    externalId,
    ...(sourceBranchId
      ? {
          parentResourceId: resourceId(accountId, "neon-branch", `${projectId}/${sourceBranchId}`),
        }
      : {}),
    createdAt: snap.created_at,
    updatedAt: snap.created_at,
  };
}

/** Snapshots are listed per project, unlike the branch-scoped beta services. */
export async function listAllSnapshots(
  run: ListRun,
  accountId: string,
): Promise<ResourceInstance[]> {
  return readChildren(
    await run.projectsToReadChildrenOf(),
    run.budget,
    async (p) => {
      const resp = await run.api.listSnapshots(p.id);
      return requireValidRows(resp.data.snapshots, isSnapshot, {
        vendor: "Neon",
        path: `/projects/${p.id}/snapshots`,
        key: "snapshots",
      }).map((snap) => buildSnapshotResource(accountId, p.id, snap));
    },
    // By id: a snapshot's parent is its source branch, which it can outlive or not have.
    (p) => ({ idPrefixes: [resourceId(accountId, "neon-snapshot", `${p.id}/`)] }),
    { isNone: isNotEnabled },
  );
}

export async function createSnapshot(
  api: Api<unknown>,
  accountId: string,
  ref: BranchRef,
  name: string,
): Promise<ResourceInstance> {
  const resp = await api.createSnapshot({
    projectId: ref.projectId,
    branchId: ref.branchId,
    ...(name ? { name } : {}),
  });
  const snapshot = validatedObject(resp.data, "snapshot", isSnapshot);
  if (!snapshot) {
    throw new Error(
      "Neon plugin: createSnapshot did not return a snapshot; the API response shape has changed.",
    );
  }
  return buildSnapshotResource(accountId, ref.projectId, snapshot);
}

/**
 * Restore into a new branch and leave it unfinalized, so the user can inspect the
 * restored data before moving computes onto it. Finalizing is a separate,
 * destructive step Neon exposes as `finalize_restore`.
 */
export async function restoreSnapshot(
  api: Api<unknown>,
  projectId: string,
  snapshotId: string,
): Promise<void> {
  await api.restoreSnapshot({ projectId, snapshotId }, { finalize_restore: false });
}
