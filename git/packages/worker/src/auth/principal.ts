/**
 * Who a request, an SSH session or a job is acting as. Every transport
 * resolves its credential to one of these and hands it to `repoAccess`, so
 * HTTP, SSH and the API cannot disagree about what a credential may do.
 */
import type { CallerValue } from "@infrawrench/git-contract";
import type { GitTokenScope } from "@infrawrench/server-core/db/schema";
import type { GitEventActor } from "../env";

/** Nobody: a signed-out browser, or `git clone` of a public repository without credentials. */
export interface AnonymousPrincipal {
  readonly kind: "anonymous";
}

/**
 * A person. `via` says what proved it, and it matters:
 *
 * - `session`: the sealed cookie. The whole of what the person may do.
 * - `ssh-key`: one of their `git_user_keys`. The whole of what they may do,
 *   over a transport that only reads and writes repositories.
 * - `token`: a personal access token. Never more than its `scopes` allow,
 *   and never above `write`.
 */
export interface UserPrincipal {
  readonly kind: "user";
  readonly userId: string;
  readonly via: "session" | "token" | "ssh-key";
  /** A token's scopes. Null for a session and an SSH key, which carry none. */
  readonly scopes: readonly GitTokenScope[] | null;
  /** The token's or the SSH key's id. Null for a session. */
  readonly credentialId: string | null;
}

/**
 * An Infrawrench API key (`iwk_`): the organisation's repositories, with the
 * key's own permissions, already intersected with its owner's role.
 */
export interface ApiKeyPrincipal {
  readonly kind: "api-key";
  readonly apiKeyId: string;
  readonly organizationId: string;
  /** The key's owner, who audit rows name. Never used to widen what the key may do. */
  readonly userId: string;
  readonly permissions: readonly string[];
}

/** A deploy key: one repository, no person. */
export interface DeployKeyPrincipal {
  readonly kind: "deploy-key";
  readonly keyId: string;
  readonly repositoryId: string;
  readonly readOnly: boolean;
}

/** A CI job token: one repository, read or write, for as long as the job may run. */
export interface JobPrincipal {
  readonly kind: "job";
  readonly repositoryId: string;
  readonly write: boolean;
  readonly runId: string | null;
  /**
   * Set on a token bound to one Terraform workspace: it is that workspace's
   * state and plans it reaches, and `write` is about the state. Such a
   * principal has no access to the repository itself (`repoAccess`), and
   * only the Terraform routes authenticate one at all.
   */
  readonly workspaceId?: string | null;
  /**
   * Set on a token bound to one branch (a full ref name): an agent session
   * working on a pull request. It reads the repository like any job, and its
   * pushes are confined to creating or updating that branch by the push
   * policy (`onlyRef`, `repo/do/policy.ts`). Only smart HTTP and the API
   * authenticate one at all; the archive, raw files and Terraform refuse it.
   */
  readonly ref?: string | null;
  /**
   * Set on an agent's token for one branch's markers (a full ref name): it
   * records that branch's trace, answers its instructions and reports
   * findings on it, and reaches nothing else (`api/agent-token.ts`). Only
   * the API's marker paths and the MCP server authenticate one at all.
   */
  readonly agentRef?: string | null;
}

export type Principal =
  AnonymousPrincipal | UserPrincipal | ApiKeyPrincipal | DeployKeyPrincipal | JobPrincipal;

export const ANONYMOUS: AnonymousPrincipal = { kind: "anonymous" };

/** The person behind a principal, when it is a person acting as themselves. */
export const principalUserId = (principal: Principal): string | null =>
  principal.kind === "user" ? principal.userId : null;

/** The contract's `Caller`, which is all a handler sees of a principal. */
export const toCaller = (principal: Principal, username: string | null): CallerValue => {
  switch (principal.kind) {
    case "anonymous":
      return { userId: null, username: null, via: "anonymous" };
    case "user":
      return { userId: principal.userId, username, via: principal.via };
    case "api-key":
      return { userId: null, username: null, via: "api-key" };
    case "deploy-key":
      return { userId: null, username: null, via: "deploy-key" };
    case "job":
      return { userId: null, username: null, via: "job" };
  }
};

/** Who a push event says pushed. Null for an anonymous principal, which cannot push. */
export const principalActor = (principal: Principal): GitEventActor | null => {
  switch (principal.kind) {
    case "anonymous":
      return null;
    case "user":
      return { kind: "user", userId: principal.userId, credentialId: principal.credentialId };
    case "api-key":
      return { kind: "api-key", userId: principal.userId, credentialId: principal.apiKeyId };
    case "deploy-key":
      return { kind: "deploy-key", userId: null, credentialId: principal.keyId };
    case "job":
      return { kind: "job", userId: null, credentialId: principal.runId };
  }
};
