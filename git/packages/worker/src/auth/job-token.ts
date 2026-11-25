/**
 * CI job tokens (`iwj_…`). The format, signing and verification live in
 * client-core (`git-job-token.ts`), because server-core mints them for runs
 * and this Worker checks them: two copies of a signed format drift. This
 * module only maps those claims onto the shape the forge's principals use.
 */
import {
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
}

export interface MintJobTokenOptions {
  readonly repositoryId: string;
  readonly write: boolean;
  readonly runId?: string | null;
  readonly ttlSeconds?: number;
  /** Seconds since the epoch. */
  readonly now?: number;
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
    },
    now * 1000,
  );
};

/**
 * The claims of a valid token, or null. A token minted for one commit's
 * archive (it travels in a URL) verifies only when `commit` names that commit,
 * so it never authenticates a clone or any other read.
 */
export const verifyJobToken = async (
  key: string,
  token: string,
  now: number = Math.floor(Date.now() / 1000),
  commit?: string,
): Promise<JobTokenClaims | null> => {
  const result = await verifyGitJobToken(key, token, commit ? { commit } : {}, now * 1000);
  if (!result.ok) return null;
  const { claims } = result;
  return {
    repositoryId: claims.repositoryId,
    write: claims.access === "write",
    runId: claims.runId === "forge" ? null : claims.runId,
    expiresAt: claims.expiresAt,
  };
};
