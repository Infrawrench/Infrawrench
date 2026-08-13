import { and, eq, isNull } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { workflows } from "@infrawrench/server-core/db/schema";
import { runOrgWorkflow } from "@infrawrench/server-core/workflows/runner";
import { runDeployment } from "@infrawrench/server-core/infrafile/runner";
import {
  claimDueDeploymentTriggers,
  type DueTrigger,
} from "@infrawrench/server-core/infrafile/triggers";
import { getBranchHeadSha, isGithubAppConfigured } from "@infrawrench/server-core/github/app";
import { TickLoop } from "@infrawrench/server-core/tick-loop";

const TICK_MS = 30_000;

/** The git-trigger fields the watcher reads from a workflow's `trigger` jsonb. */
interface GitTrigger {
  kind?: string;
  repo?: string;
  branch?: string;
  installationId?: number;
}

interface WatchedRow {
  id: string;
  organizationId: string;
  trigger: unknown;
  gitLastSha: string | null;
}

interface Watch {
  row: WatchedRow;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
}

interface LoopOptions {
  tickMs?: number;
}

/**
 * Polls each enabled git-triggered workflow's repo for a new commit on the
 * configured branch (via the org's GitHub App installation) and runs the
 * workflow when the head SHA changes. First sight of a SHA is recorded without
 * running, so connecting a repo doesn't fire immediately.
 *
 * Deploy-on-push triggers ride the same tick: two independent passes over the
 * same installations, so one slow deploy never delays a workflow (or the
 * reverse) beyond the tick it is in.
 */
export class GithubWatcher extends TickLoop {
  constructor(options: LoopOptions = {}) {
    super("github-watcher", options.tickMs ?? TICK_MS);
  }

  protected async runTick(): Promise<void> {
    if (!isGithubAppConfigured()) return;

    await this.workflowPass();
    await this.deploymentPass();
  }

  private async workflowPass(): Promise<void> {
    const rows: WatchedRow[] = await db
      .select({
        id: workflows.id,
        organizationId: workflows.organizationId,
        trigger: workflows.trigger,
        gitLastSha: workflows.gitLastSha,
      })
      .from(workflows)
      .where(and(eq(workflows.enabled, true), isNull(workflows.deletedAt)));

    const watches: Watch[] = rows.flatMap((row) => {
      const t = row.trigger as GitTrigger | null;
      if (!t || t.kind !== "git" || !t.repo || !t.installationId || !t.branch) return [];
      const [owner, repo] = t.repo.split("/");
      if (!owner || !repo) return [];
      return [{ row, installationId: t.installationId, owner, repo, branch: t.branch }];
    });

    for (const w of watches) {
      await this.checkOne(w);
    }
  }

  /**
   * Deploy-on-push. The claim (first sight, and the conditional UPDATE that
   * stops replicas double-firing) lives in server-core; this pass only runs
   * what it hands back.
   */
  private async deploymentPass(): Promise<void> {
    // Claiming *consumes* the push — the claim advances `last_sha` as it hands
    // the trigger over. With no runner wired that commit would be recorded as
    // deployed and never deployed, so don't claim at all until there is one.
    const runner = runDeployment;
    if (!runner) return;

    const due = await claimDueDeploymentTriggers();
    // One failure must not strand the rest: every org's deploys are unrelated.
    await Promise.allSettled(due.map((t) => this.deployOne(t, runner)));
  }

  private async deployOne(t: DueTrigger, runner: typeof runDeployment): Promise<void> {
    const at = `${t.repo}@${t.sha.slice(0, 7)}`;
    try {
      // Deploy the commit that was claimed, not the branch name: by now the
      // branch may have moved again, and two pushes must ship two commits
      // rather than the newer one twice.
      const { runId } = await runner({
        organizationId: t.organizationId,
        repo: t.repo,
        branch: t.sha,
        env: t.env,
        answers: t.answers,
        interactive: false,
        // Recorded as `trigger`, not `web` — the audit trail has to say a
        // push fired this, and the paid-plan refusal has to name the feature
        // that was refused rather than a screen nobody was on.
        origin: "trigger",
      });
      console.log(`[github-watcher] deployed ${at} to ${t.env} (run ${runId})`);
    } catch (e) {
      console.error(`[github-watcher] deploy failed for trigger ${t.id} (${at} → ${t.env}):`, e);
    }
  }

  private async checkOne(w: Watch): Promise<void> {
    try {
      const sha = await getBranchHeadSha(w.installationId, w.owner, w.repo, w.branch);
      if (!sha || sha === w.row.gitLastSha) return;

      // Record the new SHA up-front so a slow/failing run isn't re-triggered.
      // The compare-and-swap on the observed SHA makes this transition atomic
      // across watcher instances: only the one whose UPDATE matches gets to run
      // the workflow, so a commit fires exactly once even with N replicas (or
      // two instances overlapping during a rolling deploy).
      const observed = w.row.gitLastSha;
      const claimed = await db
        .update(workflows)
        .set({ gitLastSha: sha, updatedAt: new Date() })
        .where(
          and(
            eq(workflows.id, w.row.id),
            observed == null ? isNull(workflows.gitLastSha) : eq(workflows.gitLastSha, observed),
          ),
        )
        .returning({ id: workflows.id });
      if (claimed.length === 0) return; // another instance claimed this transition

      // Don't run on the very first observation (i.e. on connect) — only on
      // subsequent commits.
      if (observed == null) return;

      await runOrgWorkflow({
        organizationId: w.row.organizationId,
        workflowId: w.row.id,
        triggerSource: "git",
      });
    } catch (e) {
      console.error(`[github-watcher] check failed for workflow ${w.row.id}:`, e);
    }
  }
}
