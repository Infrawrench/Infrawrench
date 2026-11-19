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
  /**
   * The commit the branch was at before the push, which `paths:` filters
   * diff against. `null` when there is none to compare with: a new branch,
   * or a force push, whose old head the new one need not descend from and
   * the remote may no longer serve.
   */
  baseSha: string | null;
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
/** What GitHub sends as `before` for a branch that did not exist. */
const NO_COMMIT = /^0+$/;
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
    const before = str(o["before"]);
    const comparable =
      before !== null &&
      SHA.test(before) &&
      !NO_COMMIT.test(before) &&
      o["created"] !== true &&
      o["forced"] !== true;
    return {
      kind: "push",
      installationId,
      repoFullName,
      branch: ref.slice("refs/heads/".length),
      sha,
      baseSha: comparable ? before : null,
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

/**
 * Someone asked GitHub to run this app's checks again: "Re-run" on one
 * check (`check_run` `rerequested`) or "Re-run all checks" on the commit
 * (`check_suite` `rerequested`). GitHub sends these to the app whose checks
 * they are; `appId` is kept so the receiver can make sure.
 */
export interface CiCheckRerequest {
  kind: "check_run" | "check_suite";
  installationId: number;
  repoFullName: string;
  /** The app that created the check or the suite. */
  appId: number;
  headSha: string;
  /**
   * The suite's branch, when GitHub knows it; `null` for a fork's commit,
   * which GitHub saw no push of to a branch of this repository.
   */
  headBranch: string | null;
  /** The check asked for (`check_run` only). */
  checkRunId: number | null;
  /**
   * What the check was created with (`check_run` only): the run's id, or
   * `<run>:<pipeline>:<job>` for a job's check.
   */
  externalId: string | null;
  /** Who asked: a GitHub login, or `null` for GitHub's `ghost` stand-in. */
  senderLogin: string | null;
}

/** A `check_run` or `check_suite` delivery asking for the checks again, or `null`. */
export function parseCheckRerequest(
  event: string | null | undefined,
  body: unknown,
): CiCheckRerequest | null {
  if (event !== "check_run" && event !== "check_suite") return null;
  const o = obj(body);
  if (!o || o["action"] !== "rerequested") return null;
  const installationId = int(obj(o["installation"])?.["id"]);
  const repoFullName = str(obj(o["repository"])?.["full_name"]);
  if (installationId === null || !repoFullName || !FULL_NAME.test(repoFullName)) return null;
  const sender = str(obj(o["sender"])?.["login"]);
  const senderLogin = sender === null || sender === "ghost" ? null : sender;

  if (event === "check_run") {
    const check = obj(o["check_run"]);
    const checkRunId = int(check?.["id"]);
    const appId = int(obj(check?.["app"])?.["id"]);
    const headSha = str(check?.["head_sha"]);
    if (checkRunId === null || appId === null || !headSha || !SHA.test(headSha)) return null;
    return {
      kind: "check_run",
      installationId,
      repoFullName,
      appId,
      headSha,
      headBranch: str(obj(check?.["check_suite"])?.["head_branch"]),
      checkRunId,
      externalId: str(check?.["external_id"]),
      senderLogin,
    };
  }

  const suite = obj(o["check_suite"]);
  const appId = int(obj(suite?.["app"])?.["id"]);
  const headSha = str(suite?.["head_sha"]);
  if (appId === null || !headSha || !SHA.test(headSha)) return null;
  return {
    kind: "check_suite",
    installationId,
    repoFullName,
    appId,
    headSha,
    headBranch: str(suite?.["head_branch"]),
    checkRunId: null,
    externalId: null,
    senderLogin,
  };
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The CI run a check's `external_id` names: the run's own check carries the
 * run's id, a job's check `<run>:<pipeline>:<job>`. `null` for anything
 * else, which the receiver then looks up by the check's id instead.
 */
export function runIdOfExternalId(externalId: string | null): string | null {
  if (!externalId) return null;
  const colon = externalId.indexOf(":");
  const id = colon === -1 ? externalId : externalId.slice(0, colon);
  return RUN_ID.test(id) ? id.toLowerCase() : null;
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
