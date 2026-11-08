/**
 * GitHub App webhook deliveries that start CI runs, read into the little
 * CI needs. Pure, so the rules (which events run, what counts as a fork)
 * are tested without a database.
 */

export interface CiPushEvent {
  kind: "push";
  installationId: number;
  repoFullName: string;
  branch: string;
  sha: string;
  defaultBranch: string;
  actorLogin: string | null;
}

export interface CiPullRequestEvent {
  kind: "pull_request";
  installationId: number;
  repoFullName: string;
  number: number;
  headSha: string;
  headRef: string;
  /** Where the head commit lives; `null` when the fork has been deleted. */
  headRepoFullName: string | null;
  baseSha: string;
  defaultBranch: string;
  actorLogin: string | null;
  /** Opened from another repository: needs approval, never gets secrets. */
  fromFork: boolean;
}

export type CiEvent = CiPushEvent | CiPullRequestEvent;

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

const SHA = /^[0-9a-f]{40}$/;
const FULL_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** The pull request actions that mean "there is new code to test". */
const PULL_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/** The CI event in a delivery, or `null` when it starts nothing. */
export function parseCiEvent(event: string | null | undefined, body: unknown): CiEvent | null {
  const o = obj(body);
  const installationId = int(obj(o?.["installation"])?.["id"]);
  const repo = obj(o?.["repository"]);
  const repoFullName = str(repo?.["full_name"]);
  const defaultBranch = str(repo?.["default_branch"]) ?? "main";
  if (!o || installationId === null || !repoFullName || !FULL_NAME.test(repoFullName)) return null;

  if (event === "push") {
    // Branch deletions and tags start nothing.
    if (o["deleted"] === true) return null;
    const ref = str(o["ref"]);
    const sha = str(o["after"]);
    if (!ref?.startsWith("refs/heads/") || !sha || !SHA.test(sha)) return null;
    return {
      kind: "push",
      installationId,
      repoFullName,
      branch: ref.slice("refs/heads/".length),
      sha,
      defaultBranch,
      actorLogin: str(obj(o["sender"])?.["login"]),
    };
  }

  if (event === "pull_request") {
    if (!PULL_ACTIONS.has(str(o["action"]) ?? "")) return null;
    const pr = obj(o["pull_request"]);
    const number = int(pr?.["number"]);
    const head = obj(pr?.["head"]);
    const base = obj(pr?.["base"]);
    const headSha = str(head?.["sha"]);
    const headRef = str(head?.["ref"]);
    const baseSha = str(base?.["sha"]);
    if (number === null || !headSha || !SHA.test(headSha) || !headRef || !baseSha) return null;
    const headRepoFullName = str(obj(head?.["repo"])?.["full_name"]);
    const baseRepoFullName = str(obj(base?.["repo"])?.["full_name"]) ?? repoFullName;
    return {
      kind: "pull_request",
      installationId,
      repoFullName,
      number,
      headSha,
      headRef,
      headRepoFullName,
      baseSha,
      defaultBranch,
      actorLogin: str(obj(o["sender"])?.["login"]),
      // A head in another repository, or one whose repository is gone
      // (a deleted fork), is not this repository's code.
      fromFork:
        headRepoFullName === null ||
        headRepoFullName.toLowerCase() !== baseRepoFullName.toLowerCase(),
    };
  }

  return null;
}

/** The runner's owner key for a repository: `github.com-<owner>`. */
export function ownerKey(repoFullName: string): string {
  return accountOwnerKey(repoFullName.split("/")[0] ?? "");
}

/** The runner's owner key for a GitHub account's login. */
export function accountOwnerKey(login: string): string {
  return `github.com-${login.toLowerCase()}`;
}

/** The runner's repository id: the repository's name. */
export function repoKey(repoFullName: string): string {
  return (repoFullName.split("/")[1] ?? "repo").toLowerCase();
}
