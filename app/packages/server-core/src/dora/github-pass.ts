/**
 * The GitHub half of DORA metrics, run by the github-watcher on its tick.
 *
 * Two jobs, both through the org's existing GitHub App installations (no new
 * permission: the App already holds Contents and Deployments):
 *
 * 1. **Commit times.** Almost no deploy source says when its commit was
 *    written, which lead time needs. For each (repository, SHA) a deploy names
 *    and nobody has resolved, `GET /repos/{repo}/commits/{sha}` is asked once
 *    per installation the org has, and the author date is stored in
 *    `dora_commit_times`. A miss is stored too (null), so a repository the App
 *    cannot see costs one request ever, not one a tick.
 * 2. **GitHub deployments.** Deployments created by any tool on the org's
 *    most recently pushed repositories, with their latest status. Deployments
 *    this App created are skipped: those are Infrafile runs, already counted
 *    from `deployment_runs`.
 *
 * Bounded per tick so a large org cannot spend the installation's hourly
 * budget: `COMMIT_LOOKUPS_PER_TICK` lookups across all orgs, and deployments
 * at most every `DEPLOYMENT_IMPORT_INTERVAL_MS` per org over
 * `REPOS_PER_IMPORT` repositories. The throttle is per replica (an in-memory
 * map), which only ever means a second replica imports early; the writes are
 * upserts.
 */
import { and, eq, gte, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { db } from "../db/client";
import { deployEvents, deploymentRuns, doraCommitTimes, githubInstallations } from "../db/schema";
import { githubAppSlug, githubInstallationFetch } from "../github/app";
import { isOwnerSlashName, normalizeRepository } from "./repository";
import { upsertDeployEvents } from "./record";

export const COMMIT_LOOKUPS_PER_TICK = 60;
export const DEPLOYMENT_IMPORT_INTERVAL_MS = 15 * 60_000;
export const REPOS_PER_IMPORT = 20;
export const DEPLOYMENTS_PER_REPO = 20;
const LOOKBACK_MS = 90 * 24 * 3_600_000;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 3_600_000;

interface Pending {
  organizationId: string;
  repository: string;
  commitSha: string;
}

/**
 * A commit-time row that needs no further lookup: resolved, a definite miss
 * (stored with the attempts exhausted), or a transient miss tried recently.
 */
function settled(retryBefore: Date) {
  // An ISO string, not the Date: a raw `sql` parameter skips drizzle's column
  // mapping, and postgres-js rejects a Date there ("The string argument must
  // be of type string ... Received an instance of Date"), failing every pass.
  return sql`(${doraCommitTimes.committedAt} IS NOT NULL OR ${doraCommitTimes.attempts} >= ${MAX_ATTEMPTS} OR ${doraCommitTimes.checkedAt} > ${retryBefore.toISOString()}::timestamptz)`;
}

async function pendingCommitLookups(since: Date, retryBefore: Date): Promise<Pending[]> {
  const fromEvents = db
    .selectDistinct({
      organizationId: deployEvents.organizationId,
      repository: sql<string>`${deployEvents.repository}`,
      commitSha: sql<string>`${deployEvents.commitSha}`,
    })
    .from(deployEvents)
    .where(
      and(
        isNull(deployEvents.commitAt),
        isNotNull(deployEvents.repository),
        isNotNull(deployEvents.commitSha),
        gte(deployEvents.deployedAt, since),
        notExists(
          db
            .select({ one: sql`1` })
            .from(doraCommitTimes)
            .where(
              and(
                eq(doraCommitTimes.organizationId, deployEvents.organizationId),
                eq(doraCommitTimes.repository, deployEvents.repository),
                eq(doraCommitTimes.commitSha, deployEvents.commitSha),
                settled(retryBefore),
              ),
            ),
        ),
      ),
    )
    .limit(COMMIT_LOOKUPS_PER_TICK);
  const fromRuns = db
    .selectDistinct({
      organizationId: deploymentRuns.organizationId,
      repository: sql<string>`${deploymentRuns.repo}`,
      commitSha: sql<string>`${deploymentRuns.gitSha}`,
    })
    .from(deploymentRuns)
    .where(
      and(
        isNotNull(deploymentRuns.repo),
        isNotNull(deploymentRuns.gitSha),
        gte(deploymentRuns.startedAt, since),
        notExists(
          db
            .select({ one: sql`1` })
            .from(doraCommitTimes)
            .where(
              and(
                eq(doraCommitTimes.organizationId, deploymentRuns.organizationId),
                eq(doraCommitTimes.repository, deploymentRuns.repo),
                eq(doraCommitTimes.commitSha, deploymentRuns.gitSha),
                settled(retryBefore),
              ),
            ),
        ),
      ),
    )
    .limit(COMMIT_LOOKUPS_PER_TICK);
  const [a, b] = await Promise.all([fromEvents, fromRuns]);
  return [...a, ...b].slice(0, COMMIT_LOOKUPS_PER_TICK);
}

async function orgInstallations(organizationId: string): Promise<number[]> {
  const rows = await db
    .select({ installationId: githubInstallations.installationId })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.organizationId, organizationId),
        isNull(githubInstallations.deletedAt),
      ),
    );
  return rows.map((r) => r.installationId);
}

/**
 * Ask each installation for the commit. Returns the author date, null for "no
 * installation can see it" (a definite miss), or undefined when GitHub could
 * not answer (worth another try later).
 */
async function lookupCommit(
  installations: number[],
  repository: string,
  sha: string,
): Promise<Date | null | undefined> {
  let transient = false;
  for (const id of installations) {
    try {
      const res = await githubInstallationFetch(
        id,
        `/repos/${repository}/commits/${encodeURIComponent(sha)}`,
      );
      if (res.ok) {
        const body = (await res.json()) as {
          commit?: { author?: { date?: string }; committer?: { date?: string } };
        };
        const raw = body.commit?.author?.date ?? body.commit?.committer?.date;
        const t = raw ? Date.parse(raw) : NaN;
        return Number.isFinite(t) ? new Date(t) : null;
      }
      // 404: this installation cannot see the repository; 422: no such commit.
      if (res.status !== 404 && res.status !== 422) transient = true;
    } catch {
      transient = true;
    }
  }
  return transient ? undefined : null;
}

export async function resolveCommitTimes(now = new Date()): Promise<number> {
  const pending = await pendingCommitLookups(
    new Date(now.getTime() - LOOKBACK_MS),
    new Date(now.getTime() - RETRY_AFTER_MS),
  );
  const installationCache = new Map<string, number[]>();
  let resolved = 0;
  for (const p of pending) {
    let committedAt: Date | null | undefined = null;
    if (isOwnerSlashName(p.repository)) {
      let installs = installationCache.get(p.organizationId);
      if (!installs) {
        installs = await orgInstallations(p.organizationId);
        installationCache.set(p.organizationId, installs);
      }
      committedAt =
        installs.length > 0 ? await lookupCommit(installs, p.repository, p.commitSha) : null;
    }
    // A definite answer (found, or nobody can see it) is never asked again;
    // a transient failure is retried after RETRY_AFTER_MS until MAX_ATTEMPTS.
    const attempts =
      committedAt === undefined ? sql`${doraCommitTimes.attempts} + 1` : MAX_ATTEMPTS;
    await db
      .insert(doraCommitTimes)
      .values({
        organizationId: p.organizationId,
        repository: p.repository,
        commitSha: p.commitSha,
        committedAt: committedAt ?? null,
        attempts: committedAt === undefined ? 1 : MAX_ATTEMPTS,
        checkedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          doraCommitTimes.organizationId,
          doraCommitTimes.repository,
          doraCommitTimes.commitSha,
        ],
        set: { committedAt: committedAt ?? null, attempts, checkedAt: now },
      });
    if (committedAt) resolved++;
  }
  return resolved;
}

/* ---------------------------- deployments import --------------------------- */

const lastImport = new Map<string, number>();

interface GhRepo {
  full_name: string;
  pushed_at: string | null;
  archived?: boolean;
}

interface GhDeployment {
  id: number;
  sha: string;
  environment: string;
  created_at: string;
  performed_via_github_app?: { slug?: string } | null;
}

interface GhDeploymentStatus {
  state: string;
  created_at: string;
  environment_url?: string;
  log_url?: string;
}

async function recentRepos(installationId: number): Promise<GhRepo[]> {
  const repos: GhRepo[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await githubInstallationFetch(
      installationId,
      `/installation/repositories?per_page=100&page=${page}`,
    );
    if (!res.ok) break;
    const body = (await res.json()) as { repositories?: GhRepo[] };
    const list = body.repositories ?? [];
    repos.push(...list.filter((r) => !r.archived));
    if (list.length < 100) break;
  }
  return repos;
}

function statusOf(state: string | undefined): "success" | "failure" | "in_progress" | "canceled" {
  switch (state) {
    case "success":
    // `inactive` is a deployment that was live and has since been replaced.
    case "inactive":
      return "success";
    case "failure":
    case "error":
      return "failure";
    default:
      return "in_progress";
  }
}

async function importOrgDeployments(
  organizationId: string,
  installations: number[],
): Promise<number> {
  const ownSlug = githubAppSlug();
  let written = 0;
  for (const installationId of installations) {
    const repos = (await recentRepos(installationId))
      .filter((r) => r.pushed_at)
      .sort((a, b) => Date.parse(b.pushed_at!) - Date.parse(a.pushed_at!))
      .slice(0, REPOS_PER_IMPORT);
    for (const repo of repos) {
      const res = await githubInstallationFetch(
        installationId,
        `/repos/${repo.full_name}/deployments?per_page=${DEPLOYMENTS_PER_REPO}`,
      );
      if (!res.ok) continue;
      const deployments = ((await res.json()) as GhDeployment[]).filter(
        (d) => !(ownSlug && d.performed_via_github_app?.slug === ownSlug),
      );
      const rows: (typeof deployEvents.$inferInsert)[] = [];
      for (const d of deployments) {
        const sres = await githubInstallationFetch(
          installationId,
          `/repos/${repo.full_name}/deployments/${d.id}/statuses?per_page=1`,
        );
        const latest = sres.ok ? ((await sres.json()) as GhDeploymentStatus[])[0] : undefined;
        const status = statusOf(latest?.state);
        rows.push({
          id: crypto.randomUUID(),
          organizationId,
          source: "github",
          externalKey: `github:${repo.full_name}#${d.id}`,
          kind: "deployment",
          name: repo.full_name,
          environment: d.environment,
          repository: normalizeRepository(repo.full_name),
          commitSha: d.sha,
          deployedAt: new Date(status === "success" && latest ? latest.created_at : d.created_at),
          status,
          isRollback: false,
          url: latest?.log_url || latest?.environment_url || null,
          updatedAt: new Date(),
        });
      }
      await upsertDeployEvents(rows);
      written += rows.length;
    }
  }
  return written;
}

export async function importGithubDeployments(now = Date.now()): Promise<number> {
  const rows = await db
    .select({
      organizationId: githubInstallations.organizationId,
      installationId: githubInstallations.installationId,
    })
    .from(githubInstallations)
    .where(isNull(githubInstallations.deletedAt));
  const byOrg = new Map<string, number[]>();
  for (const r of rows) {
    const list = byOrg.get(r.organizationId);
    if (list) list.push(r.installationId);
    else byOrg.set(r.organizationId, [r.installationId]);
  }
  let total = 0;
  for (const [org, installs] of byOrg) {
    const last = lastImport.get(org) ?? 0;
    if (now - last < DEPLOYMENT_IMPORT_INTERVAL_MS) continue;
    lastImport.set(org, now);
    try {
      total += await importOrgDeployments(org, installs);
    } catch (err) {
      console.error(`[dora] GitHub deployments import for org ${org} failed:`, err);
    }
  }
  return total;
}

/** The github-watcher's DORA pass. Never throws. */
export async function runDoraGithubPass(): Promise<void> {
  try {
    await importGithubDeployments();
  } catch (err) {
    console.error("[dora] GitHub deployments pass failed:", err);
  }
  try {
    await resolveCommitTimes();
  } catch (err) {
    console.error("[dora] commit time pass failed:", err);
  }
}
