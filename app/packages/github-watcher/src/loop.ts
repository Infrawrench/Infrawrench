import { and, eq, isNull } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { githubInstallations, workflows } from "@infrawrench/server-core/db/schema";
import { runOrgWorkflow } from "@infrawrench/server-core/workflows/runner";
import { getBranchHeadSha, isGithubAppConfigured } from "@infrawrench/server-core/github/app";
import { TickLoop } from "@infrawrench/server-core/tick-loop";
import { runPrCheckPass } from "@infrawrench/server-core/pr-checks/pass";
import { runDoraGithubPass } from "@infrawrench/server-core/dora/github-pass";

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
 * Pull request checks are the second pass: cost and blast radius posted as a
 * check run on each new head commit of an open pull request in a repository
 * the org enabled them on. The third pass feeds DORA metrics: commit times and
 * GitHub deployments (`dora/github-pass`).
 */
export class GithubWatcher extends TickLoop {
  constructor(options: LoopOptions = {}) {
    super("github-watcher", options.tickMs ?? TICK_MS);
  }

  protected async runTick(): Promise<void> {
    if (!isGithubAppConfigured()) return;

    await this.workflowPass();
    await runPrCheckPass().catch((e) => console.error("[github-watcher] pr-check pass failed:", e));
    // DORA: commit times for lead time, and deployments other tools made.
    await runDoraGithubPass();
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

    // A trigger's installation id is only honoured if the workflow's own org
    // has it connected. The write paths check this too; this catches rows
    // saved before they did, and installations disconnected since.
    const owned = new Set(
      (
        await db
          .select({
            organizationId: githubInstallations.organizationId,
            installationId: githubInstallations.installationId,
          })
          .from(githubInstallations)
          .where(isNull(githubInstallations.deletedAt))
      ).map((i) => `${i.organizationId}:${i.installationId}`),
    );

    const watches: Watch[] = rows.flatMap((row) => {
      const t = row.trigger as GitTrigger | null;
      if (!t || t.kind !== "git" || !t.repo || !t.installationId || !t.branch) return [];
      if (!owned.has(`${row.organizationId}:${t.installationId}`)) return [];
      const [owner, repo] = t.repo.split("/");
      if (!owner || !repo) return [];
      return [{ row, installationId: t.installationId, owner, repo, branch: t.branch }];
    });

    for (const w of watches) {
      await this.checkOne(w);
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

      // Don't run on the very first observation (i.e. on connect), only on
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
