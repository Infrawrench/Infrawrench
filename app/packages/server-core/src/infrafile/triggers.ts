/**
 * Deploy-on-push: firing a deployment when a watched branch moves.
 *
 * Lives in server-core because the `github-watcher` service drives it and
 * cannot import web. The web app owns creating and editing triggers; this owns
 * deciding which ones are due and making sure exactly one replica fires each.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { deploymentTriggers } from "../db/deployment-schema.js";
import { getBranchHeadSha } from "../github/app.js";
import { githubInstallations } from "../db/workflow-schema.js";

export interface DueTrigger {
  id: string;
  organizationId: string;
  repo: string;
  branch: string;
  env: string;
  answers: Record<string, string>;
  /** The commit that moved the branch — what this run should deploy. */
  sha: string;
}

/** `owner/name` → its parts, or null when the stored value is malformed. */
function splitRepo(repo: string): { owner: string; name: string } | null {
  const parts = repo.split("/");
  return parts.length === 2 && parts[0] && parts[1]
    ? { owner: parts[0], name: parts[1] }
    : null;
}

/**
 * Every enabled trigger whose branch has moved since we last looked, claimed
 * for this caller.
 *
 * Two properties are load-bearing:
 *
 * 1. **First sight records the SHA without firing.** Enabling a trigger should
 *    not immediately ship whatever happens to be at HEAD — the user asked to
 *    deploy on the *next* push, not this instant.
 * 2. **The claim is a conditional UPDATE.** Competing watcher replicas race for
 *    the row and only the one that actually changed `last_sha` gets to deploy,
 *    so a push never fires twice. Same shape the budget-trigger claim uses.
 */
export async function claimDueDeploymentTriggers(): Promise<DueTrigger[]> {
  const rows = await db
    .select({
      id: deploymentTriggers.id,
      organizationId: deploymentTriggers.organizationId,
      repo: deploymentTriggers.repo,
      branch: deploymentTriggers.branch,
      env: deploymentTriggers.env,
      answers: deploymentTriggers.answers,
      lastSha: deploymentTriggers.lastSha,
    })
    .from(deploymentTriggers)
    .where(eq(deploymentTriggers.enabled, true));

  const due: DueTrigger[] = [];

  for (const row of rows) {
    const parsed = splitRepo(row.repo);
    if (!parsed) continue;

    const installationId = await installationFor(row.organizationId);
    if (installationId === null) continue;

    let head: string | null;
    try {
      head = await getBranchHeadSha(installationId, parsed.owner, parsed.name, row.branch);
    } catch {
      // A rate limit or a transient GitHub failure is not a reason to deploy,
      // nor to disable the trigger. Skip and look again next tick.
      continue;
    }
    if (!head || head === row.lastSha) continue;

    // Claim it. `last_sha IS DISTINCT FROM` makes the write idempotent across
    // replicas: whoever lands first flips it, the rest match zero rows.
    const claimed = await db
      .update(deploymentTriggers)
      .set({ lastSha: head, lastRunAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(deploymentTriggers.id, row.id),
          sql`${deploymentTriggers.lastSha} IS DISTINCT FROM ${head}`,
        ),
      )
      .returning({ id: deploymentTriggers.id });
    if (claimed.length === 0) continue;

    // First sight: the SHA is now recorded, so the next push fires. This one
    // does not.
    if (row.lastSha === null) continue;

    due.push({
      id: row.id,
      organizationId: row.organizationId,
      repo: row.repo,
      branch: row.branch,
      env: row.env,
      answers: row.answers ?? {},
      sha: head,
    });
  }

  return due;
}

/** The org's GitHub App installation, or null when it has none. */
async function installationFor(organizationId: string): Promise<number | null> {
  const [row] = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.organizationId, organizationId),
        isNotNull(githubInstallations.installationId),
      ),
    )
    .limit(1);
  return row?.installationId ?? null;
}
