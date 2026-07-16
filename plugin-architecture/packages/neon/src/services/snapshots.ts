import { formatBytes, type ResourceInstance } from "@infrawrench/plugin-base";
import type { Api, ProjectListItem, Snapshot } from "@neondatabase/api-client";
import { isServiceUnavailable, resourceId, type BranchRef } from "./common.js";

/**
 * `@neondatabase/api-client@2.7.3` mistypes both snapshot reads as
 * `OperationsResponse`. The published OpenAPI spec documents the real payloads
 * as `{ snapshots }` and `{ snapshot, operations }`, so we re-assert the
 * documented shapes rather than trust the generated types. Revisit when the SDK
 * codegen is fixed.
 */
interface SnapshotListPayload {
  snapshots: Snapshot[];
}
interface SnapshotCreatePayload {
  snapshot: Snapshot;
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
      const payload = resp.data as unknown as SnapshotListPayload;
      for (const snap of payload.snapshots ?? []) {
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
  const payload = resp.data as unknown as SnapshotCreatePayload;
  return buildSnapshotResource(accountId, ref.projectId, payload.snapshot);
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
