/**
 * Deployments — the web app's slice.
 *
 * The runner moved to `@infrawrench/server-core/infrafile/runner` so
 * `github-watcher` can fire deploy-on-push triggers without importing web. It is
 * re-exported here so routes and the websocket session are unchanged, exactly as
 * `services/workflow-runner.ts` re-exports `runOrgWorkflow`.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "@infrawrench/server-core/db/client";
import { deploymentTriggers } from "@infrawrench/server-core/db/schema";
import { DeploymentError, resolveInfrafile } from "@infrawrench/server-core/infrafile/runner";

export {
  DeploymentError,
  getDeploymentRun,
  listDeployableRepos,
  listDeploymentRuns,
  recordCliRun,
  resolveInfrafile,
  rollbackDeployment,
  runDeployment,
} from "@infrawrench/server-core/infrafile/runner";

/* --------------------------------------------------------- deploy on push -- */

export interface DeployTriggerRow {
  id: string;
  repo: string;
  branch: string;
  env: string;
  enabled: boolean;
  lastSha: string | null;
  lastRunAt: Date | null;
}

const TRIGGER_COLUMNS = {
  id: deploymentTriggers.id,
  repo: deploymentTriggers.repo,
  branch: deploymentTriggers.branch,
  env: deploymentTriggers.env,
  enabled: deploymentTriggers.enabled,
  lastSha: deploymentTriggers.lastSha,
  lastRunAt: deploymentTriggers.lastRunAt,
};

export async function listDeployTriggers(organizationId: string): Promise<DeployTriggerRow[]> {
  return db
    .select(TRIGGER_COLUMNS)
    .from(deploymentTriggers)
    .where(eq(deploymentTriggers.organizationId, organizationId))
    .orderBy(deploymentTriggers.repo, deploymentTriggers.branch);
}

/**
 * Create or update a trigger.
 *
 * The repo and env are validated against the Infrafile at that branch head
 * before the row is written — a trigger naming an environment the file does not
 * declare would otherwise sit there failing silently on every push, and the
 * first anyone would know is a deploy that never happened.
 */
export async function upsertDeployTrigger(
  organizationId: string,
  userId: string | undefined,
  input: { repo: string; branch: string; env: string; answers?: Record<string, string> },
): Promise<DeployTriggerRow> {
  const resolved = await resolveInfrafile(organizationId, input.repo, input.branch);
  const envs = declaredEnvs(resolved.source);
  if (envs.length > 0 && !envs.includes(input.env)) {
    throw new DeploymentError(
      `${resolved.fullName}@${input.branch} declares no environment named "${input.env}". ` +
        `It declares: ${envs.join(", ")}.`,
    );
  }

  const [row] = await db
    .insert(deploymentTriggers)
    .values({
      id: randomUUID(),
      organizationId,
      repo: resolved.fullName,
      branch: input.branch,
      env: input.env,
      answers: input.answers ?? {},
      // Recorded, not deployed: enabling a trigger should fire on the NEXT
      // push, not ship whatever happens to be at HEAD right now.
      lastSha: resolved.sha,
      ...(userId ? { createdByUserId: userId } : {}),
    })
    .onConflictDoUpdate({
      target: [
        deploymentTriggers.organizationId,
        deploymentTriggers.repo,
        deploymentTriggers.branch,
        deploymentTriggers.env,
      ],
      set: {
        enabled: true,
        answers: input.answers ?? {},
        // Re-stamped on every upsert, not just the first insert. Re-arming a
        // disabled trigger with a stale lastSha would make the next watcher
        // poll deploy whatever is ALREADY at HEAD — the exact thing recording
        // the SHA at arm time exists to prevent.
        lastSha: resolved.sha,
        updatedAt: new Date(),
      },
    })
    .returning(TRIGGER_COLUMNS);
  return row!;
}

export async function setDeployTriggerEnabled(
  organizationId: string,
  id: string,
  enabled: boolean,
): Promise<DeployTriggerRow> {
  const [row] = await db
    .update(deploymentTriggers)
    .set({ enabled, updatedAt: new Date() })
    .where(
      and(eq(deploymentTriggers.organizationId, organizationId), eq(deploymentTriggers.id, id)),
    )
    .returning(TRIGGER_COLUMNS);
  if (!row) throw new DeploymentError("Deploy trigger not found.", 404);
  return row;
}

export async function deleteDeployTrigger(organizationId: string, id: string): Promise<void> {
  await db
    .delete(deploymentTriggers)
    .where(
      and(eq(deploymentTriggers.organizationId, organizationId), eq(deploymentTriggers.id, id)),
    );
}

/**
 * The environments an Infrafile declares.
 *
 * Parsed, never executed: listing what a file offers must not run anybody's
 * code, and `envs` is a literal array by definition.
 */
export function declaredEnvs(source: string): string[] {
  const match = source.match(/envs\s*:\s*\[([^\]]*)\]/);
  return match?.[1] ? [...match[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!) : [];
}
