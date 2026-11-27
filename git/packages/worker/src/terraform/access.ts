/**
 * Who may do what to a workspace's state, as a pure function over what the
 * database says. A state holds every secret its workspace manages, and a
 * write to it decides what the next apply destroys, so using it is not
 * reading or writing the repository: every member of an organisation writes
 * its repositories, and only its administrators reach a state.
 *
 * | Principal                          | Read | Lock | Write | Delete, force-unlock |
 * | ---------------------------------- | ---- | ---- | ----- | -------------------- |
 * | `admin` on the repository          | yes  | yes  | yes   | yes                  |
 * | `write` or less                    | no   | no   | no    | no                   |
 * | a plan's job token (`read`)        | yes  | yes  | no    | no                   |
 * | an apply's job token (`write`)     | yes  | yes  | yes   | no                   |
 * | the app's service token            | yes  | no   | no    | no                   |
 *
 * - **A personal access token** works when the person behind it is an
 *   `admin` of the repository and the token carries `repo:write`. It never
 *   administers (`repoAccess` caps a token at `write`), so deleting the state
 *   and unlocking without the lock's id are done signed in, from the UI.
 * - **A job token** works only when it names this workspace (its `workspace`
 *   claim, which the forge's other routes refuse) and its run is a live run
 *   of this workspace. A token without the claim is refused here, whatever
 *   else it may do.
 * - **An archived repository's** state can still be read by those who could
 *   use it; nothing changes it.
 */
import { SERVICE_TOKEN_PURPOSE, type StateAuth } from "@infrawrench/git-terraform";
import { type RepoAccessDecision, hasAccess } from "../auth/access";
import type { Principal } from "../auth/principal";
import type { PlanAccess } from "./route";

const NOTHING = { canRead: false, canLock: false, canWrite: false, canAdmin: false } as const;

/** How a principal is recorded on a lock and a state version. */
export const principalName = (principal: Principal): string | null => {
  switch (principal.kind) {
    case "anonymous":
      return null;
    case "user":
      return principal.via === "token" && principal.credentialId
        ? `token:${principal.credentialId}`
        : `user:${principal.userId}`;
    case "api-key":
      return `api-key:${principal.apiKeyId}`;
    case "deploy-key":
      return `deploy-key:${principal.keyId}`;
    case "job":
      return principal.runId === SERVICE_TOKEN_PURPOSE
        ? "service:infrawrench"
        : `ci:${principal.runId ?? "forge"}`;
  }
};

/** The app's own token: minted by server-core for the linking and pricing pass. */
export const isServiceToken = (principal: Principal): boolean =>
  principal.kind === "job" && principal.runId === SERVICE_TOKEN_PURPOSE;

/**
 * The principal whose own level on the repository decides: the person behind
 * a personal access token, its scopes aside. A token is capped at `write`,
 * so asking the token itself could never find an administrator.
 */
export const stateHolder = (principal: Principal): Principal =>
  principal.kind === "user" && principal.scopes !== null
    ? { ...principal, scopes: null }
    : principal;

export interface StateAuthFacts {
  readonly repositoryId: string;
  readonly workspaceId: string;
  /** `repoAccess.detail` for the principal. Not asked for a job token. */
  readonly access: RepoAccessDecision | null;
  /** `repoAccess.detail` for {@link stateHolder}. Not asked for a job token. */
  readonly holder: RepoAccessDecision | null;
  /** The job token's run is a live run of this workspace. */
  readonly liveRun: boolean;
}

/** A job token that names this workspace of this repository. Any other reaches no state. */
const forWorkspace = (
  principal: Extract<Principal, { kind: "job" }>,
  facts: { readonly repositoryId: string; readonly workspaceId: string },
): boolean =>
  principal.repositoryId === facts.repositoryId &&
  typeof principal.workspaceId === "string" &&
  principal.workspaceId === facts.workspaceId;

export const decideStateAuth = (principal: Principal, facts: StateAuthFacts): StateAuth => {
  const name = principalName(principal);
  if (principal.kind === "anonymous" || name === null) return { principal: null, ...NOTHING };
  // A deploy key is an SSH credential for git; it never reaches a state.
  if (principal.kind === "deploy-key") return { principal: name, ...NOTHING };
  if (principal.kind === "job") {
    if (!forWorkspace(principal, facts)) return { principal: name, ...NOTHING };
    if (isServiceToken(principal)) return { principal: name, ...NOTHING, canRead: true };
    const live = facts.liveRun;
    return {
      principal: name,
      canRead: live,
      canLock: live,
      // A plan's token is `read`: it locks and reads and never writes.
      canWrite: live && principal.write,
      canAdmin: false,
    };
  }
  const none: RepoAccessDecision = { access: "none", unarchived: "none" };
  const access = facts.access ?? none;
  const holder = facts.holder ?? none;
  // The person administers the repository, and the credential may write it.
  const use = hasAccess(holder.access, "admin") && hasAccess(access.access, "write");
  return {
    principal: name,
    canRead: hasAccess(holder.unarchived, "admin") && hasAccess(access.unarchived, "write"),
    canLock: use,
    canWrite: use,
    canAdmin: hasAccess(access.access, "admin"),
  };
};

export interface PlanAccessFacts {
  readonly repositoryId: string;
  readonly workspaceId: string;
  /** The Terraform run the job token's CI run is, while it is live; null otherwise. */
  readonly liveRunId: string | null;
}

/**
 * What a principal is to one run's plan: the run's own job posts it (a
 * plan's token is `read`, so writing the repository is not what is asked),
 * the app reads what it will price, and nobody else does either.
 */
export const decidePlanAccess = (
  principal: Principal,
  facts: PlanAccessFacts,
  runId: string,
): PlanAccess => {
  if (principal.kind !== "job" || !forWorkspace(principal, facts)) return { kind: "none" };
  if (isServiceToken(principal)) return { kind: "service" };
  return principal.runId !== null && facts.liveRunId !== null && facts.liveRunId === runId
    ? { kind: "job", ciRunId: principal.runId }
    : { kind: "none" };
};
