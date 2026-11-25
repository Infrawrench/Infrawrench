/**
 * CI job tokens (`iwj_...`): what a runner clones with, and what CI reports
 * commit statuses with.
 *
 * Stateless on purpose. A token is its claims and an HMAC-SHA256 over them
 * under `JOB_TOKEN_KEY`, so minting one writes nothing and checking one reads
 * nothing: a run that starts a hundred jobs does not put a hundred rows in
 * Postgres, and a clone does not wait on a query. The price is that a token
 * cannot be revoked one at a time, which is why it is scoped to a single
 * repository, says read or write, and expires soon. Rotating `JOB_TOKEN_KEY`
 * revokes them all.
 *
 * `iwj_<base64url(claims JSON)>.<base64url(HMAC)>`. The MAC covers a domain
 * label and the encoded claims exactly as sent, so nothing is re-serialised
 * before it is checked.
 */
import { JOB_TOKEN_PREFIX } from "./credentials";
import { fromBase64, fromUtf8, hmacSha256, hmacSha256Verify, toBase64Url, utf8 } from "./encoding";

export const JOB_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60;
/** No job outlives this, so no token needs to. */
export const JOB_TOKEN_MAX_TTL_SECONDS = 12 * 60 * 60;

const DOMAIN = "infrawrench-git/job-token/v1";
const MIN_KEY_LENGTH = 32;

export interface JobTokenClaims {
  /** The one repository it reaches (`git_repositories.id`). */
  readonly repositoryId: string;
  /** Push and report statuses, not only clone and fetch. */
  readonly write: boolean;
  /** The `ci_runs.id` it was minted for, when there is one. */
  readonly runId: string | null;
  /** Seconds since the epoch. */
  readonly expiresAt: number;
}

interface WireClaims {
  readonly v: 1;
  readonly repo: string;
  readonly w: boolean;
  readonly run?: string;
  readonly exp: number;
}

const keyBytes = (key: string): Uint8Array<ArrayBuffer> => {
  if (key.length < MIN_KEY_LENGTH) {
    throw new Error(`JOB_TOKEN_KEY must be at least ${MIN_KEY_LENGTH} characters`);
  }
  return utf8(key);
};

const signedBytes = (payload: string): Uint8Array<ArrayBuffer> => utf8(`${DOMAIN}.${payload}`);

export interface MintJobTokenOptions {
  readonly repositoryId: string;
  readonly write: boolean;
  readonly runId?: string | null;
  /** Clamped to {@link JOB_TOKEN_MAX_TTL_SECONDS}. Default {@link JOB_TOKEN_DEFAULT_TTL_SECONDS}. */
  readonly ttlSeconds?: number;
  /** Seconds since the epoch; the current time when omitted. */
  readonly now?: number;
}

export const mintJobToken = async (key: string, options: MintJobTokenOptions): Promise<string> => {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(
    Math.max(1, Math.floor(options.ttlSeconds ?? JOB_TOKEN_DEFAULT_TTL_SECONDS)),
    JOB_TOKEN_MAX_TTL_SECONDS,
  );
  const claims: WireClaims = {
    v: 1,
    repo: options.repositoryId,
    w: options.write,
    ...(options.runId ? { run: options.runId } : {}),
    exp: now + ttl,
  };
  const payload = toBase64Url(utf8(JSON.stringify(claims)));
  const tag = await hmacSha256(keyBytes(key), signedBytes(payload));
  return `${JOB_TOKEN_PREFIX}${payload}.${toBase64Url(tag)}`;
};

const isWireClaims = (value: unknown): value is WireClaims => {
  if (typeof value !== "object" || value === null) return false;
  const claims = value as Record<string, unknown>;
  return (
    claims["v"] === 1 &&
    typeof claims["repo"] === "string" &&
    claims["repo"] !== "" &&
    typeof claims["w"] === "boolean" &&
    typeof claims["exp"] === "number" &&
    Number.isFinite(claims["exp"]) &&
    (claims["run"] === undefined || typeof claims["run"] === "string")
  );
};

/**
 * The claims of a token this key signed and that has not expired; null for
 * anything else. The MAC is checked before the claims are parsed, so nothing
 * an attacker wrote is interpreted.
 */
export const verifyJobToken = async (
  key: string,
  token: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<JobTokenClaims | null> => {
  if (!token.startsWith(JOB_TOKEN_PREFIX)) return null;
  const body = token.slice(JOB_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot !== body.lastIndexOf(".")) return null;
  const payload = body.slice(0, dot);
  const tag = fromBase64(body.slice(dot + 1));
  if (!tag || tag.length !== 32) return null;
  if (!(await hmacSha256Verify(keyBytes(key), tag, signedBytes(payload)))) return null;

  const bytes = fromBase64(payload);
  const text = bytes ? fromUtf8(bytes) : null;
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isWireClaims(parsed)) return null;
  if (parsed.exp <= now) return null;
  return {
    repositoryId: parsed.repo,
    write: parsed.w,
    runId: parsed.run ?? null,
    expiresAt: parsed.exp,
  };
};
