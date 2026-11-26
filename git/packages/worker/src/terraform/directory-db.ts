/**
 * `TerraformDirectory` over Postgres: `src/auth` for credentials and access,
 * the Terraform tables for workspaces, runs and the state's mirror. Each call
 * opens its own database client, as the Git transports' directory does.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  gitTerraformRuns,
  gitTerraformStateVersions,
  gitTerraformWorkspaces,
} from "@infrawrench/server-core/db/schema";
import { authenticateRequest } from "../auth/authenticate";
import type { Principal } from "../auth/principal";
import { repoAccess } from "../auth/repo-access";
import { getWorkspace } from "../db/automation";
import { type WaitUntil, db, withDb } from "../db/client";
import { getRepository, toRepoForAccess } from "../db/repositories";
import type { Env } from "../env";
import { decideStateAuth, isServiceToken, principalName } from "./access";
import type { TerraformDirectory } from "./route";
import type { StateHeadReport } from "./state-serve";

/** Statuses in which a run's job may still be using its workspace. */
const LIVE = ["queued", "running", "planned"] as const;

/** The live run of a workspace that a CI run is, or null. */
const liveRun = async (workspaceId: string, ciRunId: string | null) => {
  if (ciRunId === null) return null;
  const [row] = await db
    .select({ id: gitTerraformRuns.id })
    .from(gitTerraformRuns)
    .where(
      and(
        eq(gitTerraformRuns.workspaceId, workspaceId),
        eq(gitTerraformRuns.ciRunId, ciRunId),
        inArray(gitTerraformRuns.status, [...LIVE]),
      ),
    )
    .limit(1);
  return row ?? null;
};

/**
 * Mirrors the state's head onto Postgres: the version a write stored, the
 * workspace's current version and its lock. The Durable Object is the truth;
 * this is what listings and the app read.
 */
export const recordStateHead = async (
  workspaceId: string,
  report: StateHeadReport,
  principal: Principal | null,
  actor?: string,
): Promise<void> => {
  const { written, version, lock } = report;
  if (written) {
    const run = principal?.kind === "job" ? await liveRun(workspaceId, principal.runId) : null;
    await db
      .insert(gitTerraformStateVersions)
      .values({
        id: written.id,
        workspaceId,
        serial: written.serial,
        lineage: written.lineage,
        r2Key: written.r2Key,
        size: written.size,
        sha256: written.sha256,
        terraformVersion: written.terraformVersion,
        resourceCount: written.resourceCount,
        createdBy: written.createdBy || (actor ?? "unknown"),
        createdByUserId: principal?.kind === "user" ? principal.userId : null,
        runId: run?.id ?? null,
        createdAt: new Date(written.createdAt),
      })
      .onConflictDoNothing();
  }
  await db
    .update(gitTerraformWorkspaces)
    .set({
      currentStateVersionId: version?.id ?? null,
      currentSerial: version?.serial ?? null,
      lockId: lock?.info.ID ?? null,
      lockInfo: lock?.info ?? null,
      lockedBy: lock?.heldBy ?? null,
      lockedAt: lock ? new Date(lock.lockedAt) : null,
      updatedAt: new Date(),
    })
    .where(eq(gitTerraformWorkspaces.id, workspaceId));
};

export function terraformDirectory(env: Env, ctx: WaitUntil): TerraformDirectory {
  const run = <T>(fn: () => Promise<T>): Promise<T> => withDb(env, ctx, fn);
  return {
    authenticate: (request) =>
      run(async () => {
        const { principal, refused } = await authenticateRequest(request, env);
        return { principal, refused };
      }),

    workspace: (owner, repo, name, principal) =>
      run(async () => {
        const found = await getRepository(owner, repo);
        if (!found) return null;
        const workspace = await getWorkspace(found.repository.id, name);
        if (!workspace) return null;
        const isJob = principal.kind === "job";
        const auth = decideStateAuth(principal, {
          repositoryId: found.repository.id,
          access: isJob ? null : await repoAccess.detail(principal, toRepoForAccess(found)),
          liveRun:
            isJob && !isServiceToken(principal)
              ? (await liveRun(workspace.id, principal.runId)) !== null
              : false,
        });
        return { id: workspace.id, auth };
      }),

    recordHead: (workspaceId, report, principal) =>
      run(() => recordStateHead(workspaceId, report, principal, principalName(principal) ?? "")),

    planAccess: (workspaceId, runId, principal) =>
      run(async () => {
        if (principal.kind !== "job") return { kind: "none" as const };
        if (isServiceToken(principal)) return { kind: "service" as const };
        if (!principal.write || principal.runId === null) return { kind: "none" as const };
        const live = await liveRun(workspaceId, principal.runId);
        return live?.id === runId
          ? { kind: "job" as const, ciRunId: principal.runId }
          : { kind: "none" as const };
      }),

    recordPlan: ({ runId, ciRunId, summary }) =>
      run(async () => {
        const { recordTerraformPlan } = await import("@infrawrench/server-core/ci/terraform");
        return (await recordTerraformPlan({ runId, ciRunId, summary })) !== null;
      }),
  };
}
