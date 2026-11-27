/**
 * CI job tokens (`iwj_…`). The format, signing and verification live in
 * client-core (`git-job-token.ts`), because server-core mints them for runs
 * and this Worker checks them: two copies of a signed format drift. This
 * module only maps those claims onto the shape the forge's principals use.
 */
import {
  ANY_GIT_JOB_TOKEN_AGENT,
  ANY_GIT_JOB_TOKEN_REF,
  ANY_GIT_JOB_TOKEN_WORKSPACE,
  GIT_JOB_TOKEN_MAX_TTL_SECONDS,
  signGitJobToken,
  verifyGitJobToken,
} from "@infrawrench/client-core";

export const JOB_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60;
export const JOB_TOKEN_MAX_TTL_SECONDS = GIT_JOB_TOKEN_MAX_TTL_SECONDS;

export interface JobTokenClaims {
  readonly repositoryId: string;
  readonly write: boolean;
  readonly runId: string | null;
  readonly expiresAt: number;
  /**
   * The Terraform workspace the token is bound to, or null. A bound token
   * reaches that workspace's state and plans and nothing of the repository;
   * `write` then says whether it may write the state.
   */
  readonly workspaceId: string | null;
  /**
   * The one branch (a full ref name, `refs/heads/...`) the token may push,
   * or null for a token that may push any. A bound token reads the whole
   * repository; the push policy (`repo/do/policy.ts`, `onlyRef`) confines
   * what it writes to creating or updating that branch.
   */
  readonly ref: string | null;
  /**
   * The one branch (a full ref name) whose markers the token writes, or
   * null. Such a token is an agent's, working outside the app: it records
   * the branch's trace, answers its instructions and reports findings on
   * it (`api/agent-token.ts`), and nothing over Git authenticates it.
   */
  readonly agentRef: string | null;
}

export interface MintJobTokenOptions {
  readonly repositoryId: string;
  readonly write: boolean;
  readonly runId?: string | null;
  readonly ttlSeconds?: number;
  /** Seconds since the epoch. */
  readonly now?: number;
  /** Binds the token to one Terraform workspace (its id). */
  readonly workspaceId?: string;
  /** Binds the token to one branch (its full ref name). */
  readonly ref?: string;
  /** Makes it an agent's token for one branch's markers (its full ref name). */
  readonly agent?: string;
}

export interface VerifyJobTokenOptions {
  /** The commit whose archive is being served: the only place a commit-bound token works. */
  readonly commit?: string;
  /**
   * The caller serves Terraform workspaces (the state backend, the plan
   * route) and compares the token's workspace itself. Everything else leaves
   * this out, and a workspace-bound token is then refused: it clones nothing
   * and pushes nothing.
   */
  readonly workspace?: boolean;
  /**
   * The caller confines a push to the token's branch (smart HTTP, through
   * the push policy) or reaches nothing a branch could widen (the API groups
   * a job may call). Everything else leaves this out, and a branch-bound
   * token is then refused: no archive, no raw file, no Terraform state.
   */
  readonly ref?: boolean;
  /**
   * The caller serves a branch's markers and keeps an agent's token to its
   * own branch (the API's trace, instructions and findings paths, and the
   * MCP server, whose tools are those paths). Everything else leaves this
   * out, and an agent's token is then refused: no clone, no push, no
   * archive, no raw file, no Terraform state.
   */
  readonly agent?: boolean;
}

/** Mint a token. The app mints the ones runs use; this exists for tests and forge-side jobs. */
export const mintJobToken = async (key: string, options: MintJobTokenOptions): Promise<string> => {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(
    Math.max(1, Math.floor(options.ttlSeconds ?? JOB_TOKEN_DEFAULT_TTL_SECONDS)),
    JOB_TOKEN_MAX_TTL_SECONDS,
  );
  return signGitJobToken(
    key,
    {
      repositoryId: options.repositoryId,
      access: options.write ? "write" : "read",
      runId: options.runId ?? "forge",
      expiresAt: now + ttl,
      ...(options.workspaceId !== undefined ? { workspace: options.workspaceId } : {}),
      ...(options.ref !== undefined ? { ref: options.ref } : {}),
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
    },
    now * 1000,
  );
};

/**
 * The claims of a valid token, or null. A token minted for one commit's
 * archive (it travels in a URL) verifies only when `commit` names that commit,
 * so it never authenticates a clone or any other read. A token minted for a
 * Terraform workspace verifies only for a caller that serves workspaces, and
 * one minted for a branch only for a caller that confines it to the branch.
 */
export const verifyJobToken = async (
  key: string,
  token: string,
  now: number = Math.floor(Date.now() / 1000),
  expect: VerifyJobTokenOptions = {},
): Promise<JobTokenClaims | null> => {
  const result = await verifyGitJobToken(
    key,
    token,
    {
      ...(expect.commit ? { commit: expect.commit } : {}),
      ...(expect.workspace ? { workspace: ANY_GIT_JOB_TOKEN_WORKSPACE } : {}),
      ...(expect.ref ? { ref: ANY_GIT_JOB_TOKEN_REF } : {}),
      ...(expect.agent ? { agent: ANY_GIT_JOB_TOKEN_AGENT } : {}),
    },
    now * 1000,
  );
  if (!result.ok) return null;
  const { claims } = result;
  // The signer refuses a longer life; so does the reader, in case a minter
  // with the key does not (a token has no issue time, so this is the bound).
  if (claims.expiresAt > now + JOB_TOKEN_MAX_TTL_SECONDS) return null;
  return {
    repositoryId: claims.repositoryId,
    write: claims.access === "write",
    runId: claims.runId === "forge" ? null : claims.runId,
    expiresAt: claims.expiresAt,
    workspaceId: claims.workspace ?? null,
    ref: claims.ref ?? null,
    agentRef: claims.agent ?? null,
  };
};
