/**
 * Who may do what to a workspace's state, as a pure function over what the
 * database says. A state holds every secret its workspace manages, so
 * reading it is not reading the repository.
 *
 * | Principal                     | Read    | Lock and write | Delete, force-unlock |
 * | ----------------------------- | ------- | -------------- | -------------------- |
 * | `write` on the repository     | yes     | yes            | no                   |
 * | `admin` on the repository     | yes     | yes            | yes                  |
 * | `read` (a public repository)  | no      | no             | no                   |
 * | a run's job token (`write`)   | its own workspace, while the run is live       |
 * | the app's service token       | yes     | no             | no                   |
 *
 * A personal access token never passes `write` (`repoAccess` caps it by its
 * scopes), so it reads and writes with `repo:write` and never administers.
 * An archived repository's state can still be read by those who could write
 * it; nothing changes it.
 */
import { SERVICE_TOKEN_PURPOSE, type StateAuth } from "@infrawrench/git-terraform";
import { type RepoAccessDecision, hasAccess } from "../auth/access";
import type { Principal } from "../auth/principal";

const NOTHING = { canRead: false, canWrite: false, canAdmin: false } as const;

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

export interface StateAuthFacts {
  readonly repositoryId: string;
  /** `repoAccess.detail` for the principal. Not asked for a job token. */
  readonly access: RepoAccessDecision | null;
  /** The job token's run is a live run of this workspace. */
  readonly liveRun: boolean;
}

export const decideStateAuth = (principal: Principal, facts: StateAuthFacts): StateAuth => {
  const name = principalName(principal);
  if (principal.kind === "anonymous" || name === null) return { principal: null, ...NOTHING };
  // A deploy key is an SSH credential for git; it never reaches a state.
  if (principal.kind === "deploy-key") return { principal: name, ...NOTHING };
  if (principal.kind === "job") {
    if (principal.repositoryId !== facts.repositoryId) return { principal: name, ...NOTHING };
    if (isServiceToken(principal)) return { principal: name, ...NOTHING, canRead: true };
    const may = principal.write && facts.liveRun;
    return { principal: name, canRead: may, canWrite: may, canAdmin: false };
  }
  const access = facts.access ?? { access: "none", unarchived: "none" };
  return {
    principal: name,
    canRead: hasAccess(access.unarchived, "write"),
    canWrite: hasAccess(access.access, "write"),
    canAdmin: hasAccess(access.access, "admin"),
  };
};
