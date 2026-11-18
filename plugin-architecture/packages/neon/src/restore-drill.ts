/**
 * Automatic restore drills (`manifest.restoreDrill`, see plugin-base
 * `restore-drill.ts`): a Neon branch is copied into a new, isolated branch,
 * either from a point in its history (copy-on-write, so the copy is cheap) or
 * from its newest snapshot, restored unfinalized so the source is untouched.
 *
 * The drill branch gets a read-write compute so the host can connect, and is
 * deleted with everything on it when the drill ends.
 */
import {
  externalIdOf,
  type RestoreDrillDeclaration,
  type RestoreDrillHandle,
  type RestoreDrillRequest,
  type RestoreDrillStatus,
} from "@infrawrench/plugin-base";
import { EndpointType, type Api } from "@neondatabase/api-client";
import { httpStatus, parseBranchExternalId } from "./services/common.js";

export const neonRestoreDrill = {
  copyNoun: "branch",
  targets: [
    {
      resourceTypeId: "neon-branch",
      restorePoints: ["point-in-time", "latest-backup"],
      // Neon's longest restore window, on its paid plans.
      maxLookbackHours: 30 * 24,
      typicalReadyMinutes: 1,
    },
  ],
  cost: {
    summary:
      "A drill branch shares storage with its parent and is billed for its compute time and any data written while it exists.",
    url: "https://neon.com/pricing",
  },
} satisfies RestoreDrillDeclaration;

const refOf = (projectId: string, branchId: string) => `${projectId}/${branchId}`;

function parseRef(ref: string): { projectId: string; branchId: string } {
  const { projectId, branchId } = parseBranchExternalId(ref);
  if (!projectId || !branchId) throw new Error("Neon plugin: malformed drill handle.");
  return { projectId, branchId };
}

export async function startNeonRestoreDrill(
  api: Api<unknown>,
  request: RestoreDrillRequest,
): Promise<RestoreDrillHandle> {
  if (request.resourceTypeId !== "neon-branch") {
    throw new Error(`Neon plugin: ${request.resourceTypeId} cannot be drilled.`);
  }
  const { projectId, branchId } = parseBranchExternalId(externalIdOf(request.resourceId));
  if (!projectId || !branchId) throw new Error("Neon plugin: cannot parse the branch id.");

  if (request.restorePoint.kind === "point-in-time") {
    const at = request.restorePoint.at;
    const created = await api.createProjectBranch(projectId, {
      branch: { name: request.copyName, parent_id: branchId, parent_timestamp: at },
      endpoints: [{ type: EndpointType.ReadWrite }],
    });
    return {
      ref: refOf(projectId, created.data.branch.id),
      restoredFrom: `branch ${branchId} at ${at}`,
      restorePointAt: at,
    };
  }

  const snapshots = (await api.listSnapshots(projectId)).data.snapshots ?? [];
  const latest = snapshots
    .filter((snap) => snap.source_branch_id === branchId)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!latest) throw new Error("This branch has no snapshot to restore.");
  // Unfinalized: Neon makes a new branch from the snapshot and leaves the
  // source alone until a finalize that this drill never sends.
  const restored = await api.restoreSnapshot(
    { projectId, snapshotId: latest.id },
    { name: request.copyName, finalize_restore: false },
  );
  return {
    ref: refOf(projectId, restored.data.branch.id),
    restoredFrom: `snapshot ${latest.name}`,
    restorePointAt: latest.timestamp || latest.created_at,
  };
}

export async function checkNeonRestoreDrill(
  api: Api<unknown>,
  ref: string,
): Promise<RestoreDrillStatus> {
  const { projectId, branchId } = parseRef(ref);
  const branch = (await api.getProjectBranch(projectId, branchId)).data.branch;
  if (branch.current_state !== "ready") {
    return { state: "pending", detail: `Branch is ${branch.current_state}.` };
  }
  const endpoints = (await api.listProjectBranchEndpoints(projectId, branchId)).data.endpoints;
  if (!endpoints.some((e) => e.type === EndpointType.ReadWrite)) {
    // A snapshot restore can come up without a compute; give it one.
    await api.createProjectEndpoint(projectId, {
      endpoint: { branch_id: branchId, type: EndpointType.ReadWrite },
    });
    return { state: "pending", detail: "Starting a compute for the branch." };
  }
  const databases = (await api.listProjectBranchDatabases(projectId, branchId)).data.databases;
  const database = databases.find((d) => d.name === "neondb") ?? databases[0];
  if (!database) return { state: "failed", message: "The restored branch has no database." };
  const uri = await api.getConnectionUri({
    projectId,
    branch_id: branchId,
    database_name: database.name,
    role_name: database.owner_name,
  });
  return {
    state: "ready",
    connection: { driver: "postgres", connectionString: uri.data.uri },
  };
}

export async function endNeonRestoreDrill(api: Api<unknown>, ref: string): Promise<void> {
  const { projectId, branchId } = parseRef(ref);
  try {
    // Only ever a branch a drill made: the name is the proof.
    const branch = (await api.getProjectBranch(projectId, branchId)).data.branch;
    if (!branch.name.startsWith("iw-drill-")) {
      throw new Error(`Neon plugin: refusing to delete ${branch.name}, which no drill made.`);
    }
    await api.deleteProjectBranch({ projectId, branchId });
  } catch (err) {
    if (httpStatus(err) === 404) return;
    throw err;
  }
}
