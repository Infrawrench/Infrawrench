/**
 * The github-watcher's pull request pass: for every enabled repository, list
 * its open pull requests, and check each head commit not checked before.
 *
 * Polling, like the rest of the watcher, rather than a webhook: the GitHub
 * App integration has no webhook endpoint and adding one would mean a second
 * secret and a public route for one feature. A commit is checked within a
 * tick or two of being pushed, which is well inside the time a reviewer
 * takes to open the pull request.
 *
 * **Exactly once per commit** comes from the claim: the run row is inserted
 * under a unique (repository, pull, head sha) index before any work, so two
 * replicas (or two overlapping ticks) cannot both post. A run that throws
 * part-way is marked failed and is not retried on its own; the next push
 * gets a fresh check.
 *
 * **Never runs code from the pull request.** The Terraform is read as text;
 * an Infrafile is listed but not executed, because a pull request from a
 * fork would otherwise run its author's code with the org's credentials.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  PR_CHECK_COMMENT_MARKER,
  PR_CHECK_LIMITS,
  PR_CHECK_NAME,
  classifyPrCheckPath,
  pathInPrCheckDirectories,
  prCheckConclusion,
  prCheckTitle,
  type PrCheckConclusion,
  type PrCheckPreview,
  type PrCheckReport,
  type PrCheckRepository,
} from "@infrawrench/client-core";

import { orgAppUrl } from "../app-url.js";
import { db } from "../db/client.js";
import { githubInstallations, prCheckRepositories, prCheckRuns } from "../db/schema.js";
import { isGithubAppConfigured } from "../github/app.js";
import {
  completeCheckRun,
  createCheckRun,
  createPullRequestComment,
  findPullRequestCommentByMarker,
  getFile,
  getMergeBaseSha,
  getPullRequest,
  listOpenPullRequests,
  listPullRequestFiles,
  updatePullRequestComment,
  type GithubOpenPullRequest,
} from "../github/issues-api.js";
import { analyzePrCheck, type PrCheckSourceFile } from "./analyze.js";
import { renderCheckOutput, renderComment, renderReportMarkdown, type RenderLinks } from "./render.js";
import { prunePrCheckRuns } from "./runs.js";
import { toPrCheckRepository } from "./settings.js";

/** Pull requests analysed per tick across all orgs; the rest wait a tick. */
const MAX_CHECKS_PER_TICK = 10;
/** Open pull requests looked at per repository, most recently updated first. */
const MAX_OPEN_PULLS = 30;
/** YAML files fetched just to see whether they are Kubernetes manifests. */
const MAX_YAML_PROBES = 20;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

let lastPrunedAt = 0;

export function prCheckLinks(organizationId: string): RenderLinks {
  return {
    iacUrl: orgAppUrl(organizationId, "settings/pr-checks"),
    resourceUrl: (c) =>
      c.resourceId && c.pluginId && c.resourceTypeId
        ? orgAppUrl(
            organizationId,
            `resources/${encodeURIComponent(c.pluginId)}/${encodeURIComponent(c.resourceTypeId)}/${encodeURIComponent(c.resourceId)}`,
          )
        : null,
  };
}

/**
 * Both sides of every infrastructure file a pull request changes, read at
 * the merge base and the head through the installation.
 */
export async function loadPullRequestSources(
  installationId: number,
  repo: string,
  pull: GithubOpenPullRequest,
  directories: readonly string[],
): Promise<{ files: PrCheckSourceFile[]; notes: string[] }> {
  const notes: string[] = [];
  const listed = await listPullRequestFiles(installationId, repo, pull.number);
  if (listed.truncated) notes.push("The pull request changes more files than the check reads.");
  const base =
    (await getMergeBaseSha(installationId, repo, pull.baseSha, pull.headSha).catch(() => null)) ??
    pull.baseSha;

  const candidates = listed.files.filter((f) => {
    if (!pathInPrCheckDirectories(f.filename, directories)) return false;
    if (classifyPrCheckPath(f.filename)) return true;
    // YAML needs its content to classify; CI workflow files never qualify.
    return /\.ya?ml$/i.test(f.filename) && !f.filename.startsWith(".github/");
  });

  const files: PrCheckSourceFile[] = [];
  let yamlProbes = 0;
  for (const f of candidates) {
    if (files.length >= PR_CHECK_LIMITS.maxFiles) {
      notes.push(`Only the first ${PR_CHECK_LIMITS.maxFiles} infrastructure files were read.`);
      break;
    }
    const isYaml = !classifyPrCheckPath(f.filename);
    if (isYaml && ++yamlProbes > MAX_YAML_PROBES) continue;
    const previous = f.previousFilename ?? f.filename;
    const [after, before] = await Promise.all([
      f.status === "removed"
        ? null
        : getFile(installationId, repo, f.filename, pull.headSha).then((x) => x?.content ?? null),
      f.status === "added"
        ? null
        : getFile(installationId, repo, previous, base).then((x) => x?.content ?? null),
    ]);
    if (before === null && after === null) continue;
    const tooBig = [before, after].some(
      (t) => t !== null && t.length > PR_CHECK_LIMITS.maxFileBytes,
    );
    if (tooBig) {
      notes.push(`${f.filename} is too large to analyse.`);
      continue;
    }
    if (isYaml && !classifyPrCheckPath(f.filename, after ?? before)) continue;
    files.push({ path: f.filename, previousPath: f.previousFilename, before, after });
  }
  return { files, notes };
}

/** Analyse a pull request without posting anything: the CLI and settings preview. */
export async function previewPullRequestCheck(
  organizationId: string,
  repository: PrCheckRepository,
  pullNumber: number,
): Promise<PrCheckPreview | null> {
  const pull = await getPullRequest(repository.installationId, repository.repo, pullNumber);
  if (!pull) return null;
  const sources = await loadPullRequestSources(
    repository.installationId,
    repository.repo,
    pull,
    repository.directories,
  );
  const report = await analyzePrCheck(organizationId, sources.files, {
    repo: repository.repo,
    directories: repository.directories,
  });
  report.notes.push(...sources.notes);
  return toPreview(organizationId, report, repository);
}

/** Analyse files a caller supplied (a local diff from the CLI). */
export async function previewFilesCheck(
  organizationId: string,
  files: PrCheckSourceFile[],
  repository: PrCheckRepository | null,
  repo: string | null,
): Promise<PrCheckPreview> {
  const report = await analyzePrCheck(organizationId, files, {
    repo: repository?.repo ?? repo,
    directories: repository?.directories ?? [],
  });
  return toPreview(organizationId, report, repository);
}

function toPreview(
  organizationId: string,
  report: PrCheckReport,
  repository: PrCheckRepository | null,
): PrCheckPreview {
  const conclusion = repository
    ? prCheckConclusion(report, repository)
    : prCheckConclusion(report, { costThreshold: null, thresholdConclusion: "neutral" });
  return {
    report,
    conclusion,
    title: prCheckTitle(report),
    markdown: renderReportMarkdown(report, prCheckLinks(organizationId)),
  };
}

interface Candidate {
  repository: PrCheckRepository;
  organizationId: string;
}

/** Enabled repositories whose installation is still connected to their org. */
async function loadCandidates(): Promise<Candidate[]> {
  const rows = await db
    .select({ repository: prCheckRepositories })
    .from(prCheckRepositories)
    .innerJoin(
      githubInstallations,
      and(
        eq(githubInstallations.organizationId, prCheckRepositories.organizationId),
        eq(githubInstallations.installationId, prCheckRepositories.installationId),
        isNull(githubInstallations.deletedAt),
      ),
    )
    .where(eq(prCheckRepositories.enabled, true));
  return rows.map((r) => ({
    repository: toPrCheckRepository(r.repository),
    organizationId: r.repository.organizationId,
  }));
}

/** One tick of the pass. Never throws: every repository is independent. */
export async function runPrCheckPass(): Promise<void> {
  if (!isGithubAppConfigured()) return;
  if (Date.now() - lastPrunedAt > PRUNE_EVERY_MS) {
    lastPrunedAt = Date.now();
    await prunePrCheckRuns().catch((e) => console.error("[pr-checks] prune failed:", e));
  }

  let budget = MAX_CHECKS_PER_TICK;
  for (const { repository, organizationId } of await loadCandidates()) {
    if (budget <= 0) return;
    let pulls: GithubOpenPullRequest[];
    try {
      pulls = await listOpenPullRequests(repository.installationId, repository.repo, MAX_OPEN_PULLS);
    } catch (e) {
      console.warn(`[pr-checks] could not list pull requests in ${repository.repo}:`, e);
      continue;
    }
    for (const pull of pulls) {
      if (budget <= 0) return;
      const runId = randomUUID();
      const claimed = await db
        .insert(prCheckRuns)
        .values({
          id: runId,
          organizationId,
          repositoryId: repository.id,
          pullNumber: pull.number,
          pullTitle: pull.title.slice(0, 500),
          pullUrl: pull.htmlUrl || null,
          headSha: pull.headSha,
          baseSha: pull.baseSha,
          status: "running",
        })
        .onConflictDoNothing()
        .returning({ id: prCheckRuns.id });
      if (claimed.length === 0) continue; // checked already, or another replica has it
      budget--;
      await checkPullRequest(organizationId, repository, pull, runId);
    }
  }
}

async function previousComment(
  repositoryId: string,
  pullNumber: number,
): Promise<number | null> {
  const [row] = await db
    .select({ commentId: prCheckRuns.commentId })
    .from(prCheckRuns)
    .where(
      and(
        eq(prCheckRuns.repositoryId, repositoryId),
        eq(prCheckRuns.pullNumber, pullNumber),
        isNotNull(prCheckRuns.commentId),
      ),
    )
    .orderBy(desc(prCheckRuns.createdAt))
    .limit(1);
  return row?.commentId ?? null;
}

/** Keep one summary comment per pull request: edit it, or post it once. */
async function upsertComment(
  repository: PrCheckRepository,
  pullNumber: number,
  body: string,
): Promise<{ id: number; htmlUrl: string | null }> {
  const { installationId, repo } = repository;
  const known =
    (await previousComment(repository.id, pullNumber)) ??
    (await findPullRequestCommentByMarker(installationId, repo, pullNumber, PR_CHECK_COMMENT_MARKER))
      ?.id ??
    null;
  if (known !== null) {
    const updated = await updatePullRequestComment(installationId, repo, known, body);
    if (updated) return updated;
  }
  return createPullRequestComment(installationId, repo, pullNumber, body);
}

async function checkPullRequest(
  organizationId: string,
  repository: PrCheckRepository,
  pull: GithubOpenPullRequest,
  runId: string,
): Promise<void> {
  const { installationId, repo } = repository;
  const links = prCheckLinks(organizationId);
  const detailsUrl = links.iacUrl;
  let checkRun: { id: number; htmlUrl: string | null } | null = null;
  try {
    checkRun = await createCheckRun(installationId, repo, {
      name: PR_CHECK_NAME,
      headSha: pull.headSha,
      externalId: runId,
      detailsUrl,
    });
    await db
      .update(prCheckRuns)
      .set({ checkRunId: checkRun.id, checkRunUrl: checkRun.htmlUrl })
      .where(eq(prCheckRuns.id, runId));

    const sources = await loadPullRequestSources(
      installationId,
      repo,
      pull,
      repository.directories,
    );
    const report = await analyzePrCheck(organizationId, sources.files, {
      repo,
      directories: repository.directories,
    });
    report.notes.push(...sources.notes);
    const conclusion: PrCheckConclusion = prCheckConclusion(report, repository);

    await completeCheckRun(installationId, repo, checkRun.id, {
      conclusion,
      output: renderCheckOutput(report, links),
      detailsUrl,
    });

    // The comment is for pull requests that touch infrastructure; on every
    // other pull request the check alone says "nothing to see".
    let comment: { id: number; htmlUrl: string | null } | null = null;
    if (repository.commentEnabled && report.files.length > 0) {
      comment = await upsertComment(
        repository,
        pull.number,
        renderComment(report, conclusion, links, pull.headSha),
      ).catch((e) => {
        console.warn(`[pr-checks] comment failed on ${repo}#${pull.number}:`, e);
        report.notes.push("The summary comment could not be posted.");
        return null;
      });
    }

    await db
      .update(prCheckRuns)
      .set({
        status: "completed",
        conclusion,
        report,
        commentId: comment?.id ?? null,
        commentUrl: comment?.htmlUrl ?? null,
        completedAt: new Date(),
      })
      .where(eq(prCheckRuns.id, runId));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[pr-checks] check failed on ${repo}#${pull.number}:`, e);
    if (checkRun) {
      await completeCheckRun(installationId, repo, checkRun.id, {
        conclusion: "neutral",
        output: {
          title: "Infrawrench could not analyse this pull request",
          summary: `The check stopped before it finished: ${message.slice(0, 1_000)}`,
        },
        detailsUrl,
      }).catch(() => {});
    }
    await db
      .update(prCheckRuns)
      .set({ status: "failed", error: message.slice(0, 2_000), completedAt: new Date() })
      .where(eq(prCheckRuns.id, runId))
      .catch(() => {});
  }
}
