/**
 * Where a CI run's repository lives: a GitHub repository reached through an
 * App installation, or a repository on git.infrawrench.com.
 *
 * Everything that differs between the two is asked here, so the rest of CI
 * (recording, dispatch, concurrency, retries, billing) reads a run without
 * knowing which it is:
 *
 * - **what the runner clones**: `cloneUrl`, and `cloneToken` for the
 *   credential. A runner fetches one commit over smart HTTP with Basic auth
 *   as `x-access-token:<token>` whatever the host, so a GitHub run sends the
 *   installation's token and a git.infrawrench.com run a job token
 *   (client-core's `git-job-token.ts`, signed here and checked by the
 *   forge's Worker). Fetching rather than downloading an archive is what
 *   keeps `paths:` and `changed()` (a diff against `base`), `changes: fail`
 *   and a pull request's `refs/pull/<n>/head` working exactly as on GitHub,
 *   with no runner or proxy change.
 * - **who owns it on the runners**: `gitOwnerKey`, spelled the way the
 *   runner derives an owner from a clone URL (`<host>-<namespace>`), so the
 *   caches, secrets and usage of `git.infrawrench.com/acme` and
 *   `github.com/acme` never meet.
 * - **where a person looks at it**: `commitUrl`, `pullUrl` (GitHub) and
 *   `gitBranchPageUrl` (the forge, which has branch pages instead).
 *
 * A git.infrawrench.com run is one with `gitRepositoryId`; its
 * `installationId` is {@link GIT_SOURCE_INSTALLATION_ID}.
 */
import {
  ciRepoAllowed,
  formatGitBranchKey,
  gitBranchPagePath,
  signGitJobToken,
  type GitJobTokenAccess,
} from "@infrawrench/client-core";

/** The `installation_id` of a run whose repository is on git.infrawrench.com. GitHub's start at 1. */
export const GIT_SOURCE_INSTALLATION_ID = 0;

export type CiSourceKind = "github" | "git";

/** What of a run (or a schedule row) says where its repository lives. */
export interface CiSourceRef {
  gitRepositoryId?: string | null | undefined;
}

export function sourceKind(row: CiSourceRef): CiSourceKind {
  return typeof row.gitRepositoryId === "string" && row.gitRepositoryId.length > 0
    ? "git"
    : "github";
}

export function isGitSource(row: CiSourceRef): row is CiSourceRef & { gitRepositoryId: string } {
  return sourceKind(row) === "git";
}

const DEFAULT_GIT_BASE_URL = "https://git.infrawrench.com";

/** `GIT_BASE_URL` without a trailing slash; read per call, so a test sees its own. */
export function gitBaseUrl(): string {
  const configured = process.env["GIT_BASE_URL"]?.trim();
  return (configured || DEFAULT_GIT_BASE_URL).replace(/\/+$/, "");
}

/** The forge's host, lowercased, without a port: what the runner names an owner by. */
export function gitHost(): string {
  try {
    return new URL(gitBaseUrl()).hostname.toLowerCase();
  } catch {
    return new URL(DEFAULT_GIT_BASE_URL).hostname;
  }
}

/**
 * The runner's owner key for a namespace of the forge:
 * `git.infrawrench.com-<namespace>`. The same text the runner
 * (`owner_from_url`) and the proxy (`ownerFromUrl`) work out from the clone
 * URL, so a request with or without `owner` lands on one owner.
 */
export function gitOwnerKey(namespace: string): string {
  return `${gitHost()}-${namespace}`
    .toLowerCase()
    .split("")
    .map((c) => (/[a-z0-9._-]/.test(c) ? c : "_"))
    .join("");
}

/**
 * The runner's owner key for a run's or a schedule's repository:
 * `github.com-<login>` or `git.infrawrench.com-<namespace>`.
 */
export function sourceOwnerKey(row: CiSourceRef & { repoFullName: string }): string {
  const owner = row.repoFullName.split("/")[0] ?? "";
  return isGitSource(row) ? gitOwnerKey(owner) : `github.com-${owner.toLowerCase()}`;
}

function encodedPath(repoFullName: string): string {
  return repoFullName.split("/").map(encodeURIComponent).join("/");
}

/** The repository's page on its forge. */
export function repositoryUrl(row: CiSourceRef & { repoFullName: string }): string {
  return isGitSource(row)
    ? `${gitBaseUrl()}/${encodedPath(row.repoFullName)}`
    : `https://github.com/${row.repoFullName}`;
}

/** What the runner clones. Never carries a credential. */
export function cloneUrl(row: CiSourceRef & { repoFullName: string }): string {
  return `${repositoryUrl(row)}.git`;
}

export function commitUrl(row: CiSourceRef & { repoFullName: string }, sha: string): string {
  return `${repositoryUrl(row)}/commit/${encodeURIComponent(sha)}`;
}

/**
 * A GitHub pull request's page. A repository on git.infrawrench.com has no
 * pull requests, only branch pages ({@link gitBranchPageUrl}); for one of
 * those this is the forge's numbered address of a page, `/pulls/<n>`, which
 * the forge redirects to the page's own.
 */
export function pullUrl(row: CiSourceRef & { repoFullName: string }, number: number): string {
  return isGitSource(row)
    ? `${repositoryUrl(row)}/pulls/${number}`
    : `${repositoryUrl(row)}/pull/${number}`;
}

/** A branch's page on git.infrawrench.com, by the page's key (client-core's `git-branch-key.ts`). */
export function gitBranchPageUrl(repoFullName: string, key: string): string {
  const [owner = "", repo = ""] = repoFullName.split("/");
  return `${gitBaseUrl()}${gitBranchPagePath(owner, repo, key)}`;
}

/**
 * The key of the branch page a forge run of a page's event belongs to: the
 * head branch, after the fork it is in when that is another repository
 * (`owner/name:branch`, `-:branch` once the fork is gone). Bare, so it names
 * the head's open page, or its newest when none is open: an older page of a
 * name used again is reached from there.
 */
export function gitRunPageKey(row: {
  headRef: string;
  headRepoFullName: string | null;
  fromFork: boolean;
}): string {
  if (!row.fromFork) return formatGitBranchKey({ branch: row.headRef });
  const [owner, name, ...rest] = (row.headRepoFullName ?? "").split("/");
  const fork = owner && name && rest.length === 0 ? { owner, name } : ("gone" as const);
  return formatGitBranchKey({ fork, branch: row.headRef });
}

/**
 * The name a repository goes by in a list of repositories something is lent
 * to (`ci_connection_access.repos`, a grant's `repos`). A GitHub repository
 * is `owner/name`, as those lists have always spelled it. One on
 * git.infrawrench.com is `git.infrawrench.com/namespace/name`: a namespace
 * and a GitHub account may share a name, and a list written for
 * `acme/web` on GitHub must not lend the same things to whoever can push
 * to `acme/web` here. A list of `null` (every repository the organization
 * runs CI for) covers both.
 */
export function grantRepoName(row: CiSourceRef & { repoFullName: string }): string {
  return isGitSource(row) ? `${gitHost()}/${row.repoFullName}` : row.repoFullName;
}

/**
 * Whether a list of repositories something is lent to covers a run's
 * repository. `null` is every repository of the organization's, which a
 * person's own repository connected to it (`git/workspace.ts`, `personal`)
 * is not: its owner alone decides what its branches hold, so it is lent
 * only what names it. Every check of such a list goes through here.
 */
export function grantCoversRepo(
  repos: readonly string[] | null | undefined,
  run: CiSourceRef & { repoFullName: string; personal?: boolean | undefined },
): boolean {
  if (run.personal === true && (repos === null || repos === undefined)) return false;
  return ciRepoAllowed(repos, grantRepoName(run));
}

/** Whether `name` is a repository of the forge as a list of repositories spells it. */
export function isGitGrantRepoName(name: string): boolean {
  const prefix = `${gitHost()}/`;
  return (
    name.toLowerCase().startsWith(prefix) &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name.slice(prefix.length))
  );
}

/** The server has the key the forge's Worker checks job tokens with. */
export function gitJobTokenConfigured(): boolean {
  return (process.env["GIT_JOB_TOKEN_KEY"] ?? "").length >= 32;
}

/** Thrown when a job token is needed and the server cannot sign one. */
export class GitJobTokenUnavailable extends Error {
  constructor() {
    super(
      "This server cannot read git.infrawrench.com repositories for CI: GIT_JOB_TOKEN_KEY is not set.",
    );
    this.name = "GitJobTokenUnavailable";
  }
}

/** As long as a GitHub installation token lasts, which is what a run's clone was written for. */
export const CLONE_TOKEN_TTL_SECONDS = 60 * 60;
/** For a read the app makes itself, or a link a machine follows at once. */
export const SHORT_TOKEN_TTL_SECONDS = 10 * 60;

/**
 * A job token for one repository of the forge. `purpose` is the run's id,
 * or a word for a read no run owns. Read-only unless asked: nothing CI does
 * by itself writes to a repository.
 */
export async function mintGitJobToken(
  repositoryId: string,
  purpose: string,
  opts: {
    access?: GitJobTokenAccess;
    ttlSeconds?: number;
    /** Good for this commit's source archive alone: for a token that goes in a link. */
    commit?: string;
    /**
     * Good for this Terraform workspace's state and plans alone (its id):
     * the forge refuses such a token everywhere else, so it clones nothing
     * and pushes nothing. `access` is then about the state.
     */
    workspace?: string;
    /**
     * Pushes this one branch only (a full ref name, `refs/heads/<branch>`):
     * the forge lets the token read the repository and create or update that
     * branch, and refuses it everywhere else (archive, raw files, Terraform,
     * every other ref). What an agent session working on a pull request holds.
     */
    ref?: string;
  } = {},
): Promise<string> {
  const key = process.env["GIT_JOB_TOKEN_KEY"] ?? "";
  if (key.length < 32) throw new GitJobTokenUnavailable();
  const now = Date.now();
  return signGitJobToken(
    key,
    {
      repositoryId,
      access: opts.access ?? "read",
      runId: purpose,
      expiresAt: Math.floor(now / 1000) + (opts.ttlSeconds ?? CLONE_TOKEN_TTL_SECONDS),
      ...(opts.commit !== undefined ? { commit: opts.commit } : {}),
      ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
      ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
    },
    now,
  );
}

/**
 * The credential a runner clones the repository with: the App
 * installation's token for GitHub, a read-only job token for the forge.
 * The runner uses it to fetch and never hands it to a job. Throws what the
 * caller reports as "could not get a token" and retries.
 */
export async function cloneToken(
  row: CiSourceRef & { installationId: number },
  purpose: string,
): Promise<string> {
  if (isGitSource(row)) return mintGitJobToken(row.gitRepositoryId, purpose);
  const { getInstallationToken } = await import("../github/app.js");
  return getInstallationToken(row.installationId);
}

/** Who refused the token, for the reason a run or a read shows. */
export function tokenRefusal(row: CiSourceRef, err: unknown): string {
  return isGitSource(row)
    ? err instanceof GitJobTokenUnavailable
      ? err.message
      : `Could not sign a job token: ${String(err)}`
    : `GitHub refused an installation token: ${String(err)}`;
}
