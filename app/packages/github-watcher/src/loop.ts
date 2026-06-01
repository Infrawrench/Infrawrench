import { and, eq, isNull } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { workflows } from "@infrawrench/server-core/db/schema";
import { runOrgWorkflow } from "@infrawrench/server-core/workflows/runner";
import { getBranchHeadSha, isGithubAppConfigured } from "@infrawrench/server-core/github/app";

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
 */
export class GithubWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;
  private running = false;
  private readonly tickMs: number;

  constructor(options: LoopOptions = {}) {
    this.tickMs = options.tickMs ?? TICK_MS;
  }

  start(): void {
    if (this.timer) return;
    const scheduleNext = () => {
      if (this.stopping) return;
      this.timer = setTimeout(async () => {
        await this.tick();
        scheduleNext();
      }, this.tickMs);
    };
    void this.tick().then(scheduleNext);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const deadline = Date.now() + 30_000;
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!isGithubAppConfigured()) return;

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
    } catch (e) {
      console.error("[github-watcher] tick failed:", e);
    } finally {
      this.running = false;
    }
  }

  private async checkOne(w: Watch): Promise<void> {
    try {
      const sha = await getBranchHeadSha(w.installationId, w.owner, w.repo, w.branch);
      if (!sha || sha === w.row.gitLastSha) return;

      // Record the new SHA up-front so a slow/failing run isn't re-triggered.
      const firstSight = w.row.gitLastSha == null;
      await db
        .update(workflows)
        .set({ gitLastSha: sha, updatedAt: new Date() })
        .where(eq(workflows.id, w.row.id));

      // Don't run on the very first observation (i.e. on connect) — only on
      // subsequent commits.
      if (firstSight) return;

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
