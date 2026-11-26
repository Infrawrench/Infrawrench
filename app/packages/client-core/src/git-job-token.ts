/**
 * The job token Infrawrench CI reads a git.infrawrench.com repository with.
 *
 * The app mints one when it sends a run to the runners (`server-core`'s
 * `ci/source.ts`); the forge's Worker checks it on smart HTTP, the source
 * archive and the raw file route. Both import this module, so the format has
 * one definition. It is pure (WebCrypto and `TextEncoder` only), so it runs
 * in a Worker, in Node and in a test alike.
 *
 * A token is `iwj_<payload>.<signature>`: the payload is base64url of
 * compact JSON, the signature base64url of HMAC-SHA256 over a label and the
 * payload's text under the shared key (`GIT_JOB_TOKEN_KEY`, on the app and
 * on the Worker alike). Nothing is stored per token: it names one
 * repository by id (so a rename or a transfer changes nothing), says `read`
 * or `write`, names what it was minted for and expires soon after. One
 * minted for a source archive link also names the commit, and is good for
 * that archive alone. One minted for a Terraform run or for the app's own
 * read of a state names the workspace, and is good for that workspace's
 * state and plans alone: it clones nothing and writes nothing to the
 * repository. One minted for an agent's work names a branch (`ref`): it
 * clones the repository and pushes that one branch, and nothing else.
 *
 * Git sends it as the password of Basic auth, with any user name (the
 * runner sends `x-access-token`); every other route takes it as a Bearer
 * token. Like any credential it is never logged.
 */

export const GIT_JOB_TOKEN_PREFIX = "iwj_";

/** Separates this use of the key from any other the same secret may get. */
const LABEL = "infrawrench git job token v1\n";

/** What a token may do with its repository. `write` includes `read`. */
export type GitJobTokenAccess = "read" | "write";

export interface GitJobTokenClaims {
  /** The repository's id (`git_repositories.id`), never its name. */
  repositoryId: string;
  access: GitJobTokenAccess;
  /**
   * What it was minted for: a CI run's id, or a label for a read no run
   * owns (`schedules`, `manual`). For the forge's audit trail only; access
   * is decided by the repository and `access`.
   */
  runId: string;
  /** When it stops working, in seconds since the epoch. */
  expiresAt: number;
  /**
   * Set on a token that is only good for one commit's source archive: the
   * one kind that travels in a URL (a cloud job's machine follows a redirect
   * to it). A verifier that does not say which commit it is serving refuses
   * such a token, so it clones nothing and reads no other file.
   */
  commit?: string;
  /**
   * Set on a token that is only good for one Terraform workspace (its id,
   * `git_terraform_workspaces.id`): the state backend and the plan route of
   * that workspace, and nothing of the repository itself. `access` then says
   * what it may do to the state: `read` reads and locks (a plan), `write`
   * also writes (an apply). A verifier that does not serve workspaces
   * refuses such a token, so a job that holds one can neither clone nor
   * push with it.
   */
  workspace?: string;
  /**
   * Set on a token that pushes one branch only (a full ref name,
   * `refs/heads/<branch>`): what an agent session that works on a pull
   * request holds. It reads the whole repository like any job token, and the
   * forge lets it create or update that branch and nothing else: no other
   * branch, no tag, and never a deletion. A verifier that does not say it
   * enforces that (`expect.ref`) refuses such a token, so it opens no
   * archive, no raw file, no Terraform state and nothing it was not meant
   * for. Cannot be combined with `commit` or `workspace`.
   */
  ref?: string;
}

/**
 * For `expect.ref`: the verifier serves ref-bound tokens and confines a push
 * to the token's ref itself (the forge's push policy), because it learns
 * which refs a push names only after it has authenticated.
 */
export const ANY_GIT_JOB_TOKEN_REF = Symbol.for("infrawrench.git-job-token.any-ref");

/**
 * For `expect.workspace`: the verifier serves Terraform workspaces and
 * compares the token's claim with the workspace it resolved itself (it knows
 * the workspace's name from the path before it knows its id).
 */
export const ANY_GIT_JOB_TOKEN_WORKSPACE = Symbol.for("infrawrench.git-job-token.any-workspace");

/** Why a token was refused. `expired` is the only one a caller may want to say out loud. */
export type GitJobTokenRefusal = "malformed" | "signature" | "expired" | "repository" | "access";

export type GitJobTokenResult =
  { ok: true; claims: GitJobTokenClaims } | { ok: false; reason: GitJobTokenRefusal };

/** The longest a token may live: a run's clone, and a cloud job's start, are minutes away. */
export const GIT_JOB_TOKEN_MAX_TTL_SECONDS = 6 * 60 * 60;

/** A token's whole length is bounded, so a hostile header costs nothing to refuse. */
const MAX_TOKEN_LENGTH = 1024;
const MAX_FIELD_LENGTH = 200;
/** The key must be worth signing with. */
const MIN_KEY_LENGTH = 32;

const COMMIT = /^[0-9a-f]{40}$/;
/**
 * A branch's full ref name. Deliberately narrower than what Git allows: no
 * `..`, no `@{`, no control characters or spaces, no leading or trailing
 * slash or dot in a component, no `.lock` suffix.
 */
const BRANCH_REF =
  /^refs\/heads\/(?!.*\.\.)(?!.*\/\.)(?!.*\/\/)(?!.*\.lock$)(?!.*[/.]$)[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

/** Whether `ref` is a branch name a ref-bound token may carry. */
export function isGitJobTokenRef(ref: string): boolean {
  return ref.length <= MAX_FIELD_LENGTH && BRANCH_REF.test(ref);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error(`The git job token key must be at least ${MIN_KEY_LENGTH} characters.`);
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function validField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/**
 * Signs a token for `claims`. Throws on claims no verifier would take (an
 * empty repository, an expiry further off than
 * {@link GIT_JOB_TOKEN_MAX_TTL_SECONDS}) and on a key too short to sign with,
 * so a misconfigured server fails loudly instead of minting junk.
 */
export async function signGitJobToken(
  secret: string,
  claims: GitJobTokenClaims,
  now: number = Date.now(),
): Promise<string> {
  if (!validField(claims.repositoryId) || !validField(claims.runId)) {
    throw new Error("A git job token names a repository and what it is for.");
  }
  if (claims.access !== "read" && claims.access !== "write") {
    throw new Error("A git job token's access is read or write.");
  }
  if (claims.commit !== undefined && !COMMIT.test(claims.commit)) {
    throw new Error("A git job token's commit is a full commit id.");
  }
  if (claims.workspace !== undefined && !validField(claims.workspace)) {
    throw new Error("A git job token's workspace is a workspace id.");
  }
  if (claims.workspace !== undefined && claims.commit !== undefined) {
    throw new Error("A git job token is for a commit's archive or for a workspace, not both.");
  }
  if (claims.ref !== undefined && !isGitJobTokenRef(claims.ref)) {
    throw new Error("A git job token's ref is a branch's full ref name.");
  }
  if (claims.ref !== undefined && (claims.commit !== undefined || claims.workspace !== undefined)) {
    throw new Error(
      "A git job token bound to a branch is not also bound to a commit or a workspace.",
    );
  }
  const nowSeconds = Math.floor(now / 1000);
  if (
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= nowSeconds ||
    claims.expiresAt > nowSeconds + GIT_JOB_TOKEN_MAX_TTL_SECONDS
  ) {
    throw new Error("A git job token expires within the next six hours.");
  }
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        v: 1,
        repo: claims.repositoryId,
        access: claims.access,
        run: claims.runId,
        exp: claims.expiresAt,
        ...(claims.commit !== undefined ? { sha: claims.commit } : {}),
        ...(claims.workspace !== undefined ? { ws: claims.workspace } : {}),
        ...(claims.ref !== undefined ? { ref: claims.ref } : {}),
      }),
    ),
  );
  const key = await hmacKey(secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(LABEL + payload));
  return `${GIT_JOB_TOKEN_PREFIX}${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Whether `text` looks like a job token, before anything is checked: for routing a credential. */
export function isGitJobToken(text: string): boolean {
  return text.startsWith(GIT_JOB_TOKEN_PREFIX);
}

/**
 * Checks a token: its signature (in constant time, by WebCrypto), then its
 * expiry, then, when `expect` says, that it is for that repository and
 * grants at least that access. A token bound to a commit passes only for
 * `expect.commit` equal to it: every caller that is not serving that
 * commit's archive leaves `commit` out and so refuses it. A token bound to a
 * workspace passes only for `expect.workspace` equal to it (or
 * {@link ANY_GIT_JOB_TOKEN_WORKSPACE}, for a verifier that compares the
 * claim itself): every caller that is not serving a workspace's state or
 * plans leaves `workspace` out and so refuses it. A verifier that names a
 * workspace refuses a token without the claim. A token bound to a branch
 * passes only for `expect.ref` equal to it (or {@link ANY_GIT_JOB_TOKEN_REF},
 * for a verifier that confines the push itself): every caller that does not
 * enforce the branch leaves `ref` out and so refuses it. Unlike a workspace,
 * naming `ref` does not refuse a token without the claim, which may already
 * write any branch. The claims of a refused token are never returned, so
 * nothing is decided from an unsigned payload.
 */
export async function verifyGitJobToken(
  secret: string,
  token: string,
  expect: {
    repositoryId?: string;
    access?: GitJobTokenAccess;
    commit?: string;
    workspace?: string | typeof ANY_GIT_JOB_TOKEN_WORKSPACE;
    ref?: string | typeof ANY_GIT_JOB_TOKEN_REF;
  } = {},
  now: number = Date.now(),
): Promise<GitJobTokenResult> {
  const refused = (reason: GitJobTokenRefusal): GitJobTokenResult => ({ ok: false, reason });
  if (
    typeof token !== "string" ||
    token.length > MAX_TOKEN_LENGTH ||
    !token.startsWith(GIT_JOB_TOKEN_PREFIX)
  ) {
    return refused("malformed");
  }
  const body = token.slice(GIT_JOB_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot !== body.lastIndexOf(".")) return refused("malformed");
  const payload = body.slice(0, dot);
  const signature = fromBase64Url(body.slice(dot + 1));
  const payloadBytes = fromBase64Url(payload);
  if (!signature || !payloadBytes || signature.length !== 32) return refused("malformed");

  const key = await hmacKey(secret, "verify");
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(LABEL + payload));
  if (!valid) return refused("signature");

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return refused("malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refused("malformed");
  }
  const { v, repo, access, run, exp, sha, ws, ref } = parsed as Record<string, unknown>;
  if (
    v !== 1 ||
    !validField(repo) ||
    !validField(run) ||
    (access !== "read" && access !== "write") ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(exp) ||
    (sha !== undefined && (typeof sha !== "string" || !COMMIT.test(sha))) ||
    (ws !== undefined && (!validField(ws) || sha !== undefined)) ||
    (ref !== undefined &&
      (typeof ref !== "string" || !isGitJobTokenRef(ref) || sha !== undefined || ws !== undefined))
  ) {
    return refused("malformed");
  }
  if (exp <= Math.floor(now / 1000)) return refused("expired");
  if (expect.repositoryId !== undefined && expect.repositoryId !== repo) {
    return refused("repository");
  }
  if (expect.access === "write" && access !== "write") return refused("access");
  // An archive token reads its commit's archive and nothing else.
  if (sha !== undefined && (access !== "read" || expect.commit !== sha)) return refused("access");
  // A workspace token reaches its workspace's state and plans and nothing else,
  // and a workspace is reached with no other kind of token.
  if (ws !== undefined) {
    if (expect.workspace === undefined) return refused("access");
    if (expect.workspace !== ANY_GIT_JOB_TOKEN_WORKSPACE && expect.workspace !== ws) {
      return refused("access");
    }
  } else if (expect.workspace !== undefined) {
    return refused("access");
  }
  // A branch token goes only where the push is confined to its branch.
  if (ref !== undefined) {
    if (expect.ref === undefined) return refused("access");
    if (expect.ref !== ANY_GIT_JOB_TOKEN_REF && expect.ref !== ref) return refused("access");
  }
  return {
    ok: true,
    claims: {
      repositoryId: repo,
      access,
      runId: run,
      expiresAt: exp,
      ...(sha !== undefined ? { commit: sha } : {}),
      ...(ws !== undefined ? { workspace: ws } : {}),
      ...(ref !== undefined ? { ref } : {}),
    },
  };
}
