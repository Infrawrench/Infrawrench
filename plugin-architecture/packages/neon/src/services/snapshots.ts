import { formatBytes, type ResourceInstance } from "@infrawrench/plugin-base";
import type { Api, ProjectListItem, Snapshot } from "@neondatabase/api-client";
import {
  hasStringFields,
  isServiceUnavailable,
  resourceId,
  validatedArray,
  validatedObject,
  type BranchRef,
} from "./common.js";

/**
 * `@neondatabase/api-client@2.7.3` mistypes both snapshot reads as
 * `OperationsResponse`. The published OpenAPI spec documents the real payloads
 * as `{ snapshots }` and `{ snapshot, operations }`, so we have to look past the
 * generated types — but we validate at runtime rather than assert, so a drifting
 * SDK or API surfaces as a missing snapshot instead of a `TypeError` inside
 * `buildSnapshotResource`. Revisit when the SDK codegen is fixed.
 */
const SNAPSHOT_REQUIRED_FIELDS = ["id", "name", "created_at"] as const;

function isSnapshot(value: unknown): value is Snapshot {
  return hasStringFields(value, SNAPSHOT_REQUIRED_FIELDS);
}

export function buildSnapshotResource(
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
  api: Api<unknown>,
  accountId: string,
  projects: ProjectListItem[],
): Promise<ResourceInstance[]> {
  const results: ResourceInstance[] = [];
  for (const p of projects) {
    try {
      const resp = await api.listSnapshots(p.id);
      for (const snap of validatedArray(resp.data, "snapshots", isSnapshot)) {
        results.push(buildSnapshotResource(accountId, p.id, snap));
      }
    } catch (err) {
      if (!isServiceUnavailable(err)) throw err;
    }
  }
  return results;
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
      "Neon plugin: createSnapshot did not return a snapshot — the API response shape has changed.",
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
