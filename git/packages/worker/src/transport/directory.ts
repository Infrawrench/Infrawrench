/**
 * What the transports need to know about people and repositories, as one
 * interface: who a credential is, which repository a path names, what that
 * principal may do there, and the rules for a push. `./directory-db.ts`
 * answers from Postgres through `src/auth` and `src/db`; the worker tests
 * answer from a fixture, which is how they run without a database.
 *
 * Smart HTTP and SSH both go through `resolveRepository`, so the two cannot
 * disagree about access.
 */
import type { RepoAccess } from "../auth/access";
import type { OfferedSshKey } from "../auth/authenticate";
import type { Principal } from "../auth/principal";
import type { PushPolicy } from "../repo/do/policy";

export interface HttpAuthentication {
  readonly principal: Principal;
  /** A credential was presented and refused: the answer is a 401, never the anonymous one. */
  readonly refused: boolean;
}

export interface ResolvedRepository {
  readonly id: string;
  /** The namespace's slug and the repository's name, as spelled. */
  readonly owner: string;
  readonly name: string;
  readonly archived: boolean;
  /** What the principal may do, from `repoAccess`. */
  readonly access: RepoAccess;
  /** Protected-branch rules and who is pushing. Read only when a push begins. */
  pushPolicy(): Promise<PushPolicy>;
}

/** The parts of a `Request` authentication reads. */
export interface RequestLike {
  readonly url: string;
  readonly method: string;
  readonly headers: { get(name: string): string | null };
}

export interface GitDirectory {
  /**
   * Who an HTTP request is from: Basic or Bearer with one of our tokens, or
   * nobody. A job token bound to one branch is a refused credential unless
   * `refTokens` says the caller confines a push to that branch, which only
   * the smart HTTP routes do (through `pushPolicy`'s `onlyRef`).
   */
  authenticate(
    request: RequestLike,
    options?: { readonly refTokens?: boolean },
  ): Promise<HttpAuthentication>;
  /**
   * The job token of an archive link (`?token=`), which is bound to one
   * commit and good for nothing else. Null when it does not verify.
   */
  authenticateArchiveToken(token: string, commit: string): Promise<Principal | null>;
  /** Whose SSH key this is, or null. `verified` is true once the signature has been checked. */
  authenticateKey(key: OfferedSshKey, verified: boolean): Promise<Principal | null>;
  /** How an SSH greeting names the principal: a username, or a deploy key's repository. */
  describe(principal: Principal): Promise<string>;
  /** The repository at `owner/name` and what `principal` may do there. Null when there is none. */
  resolveRepository(
    owner: string,
    name: string,
    principal: Principal,
  ): Promise<ResolvedRepository | null>;
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `owner/repo`, `owner/repo.git`, either with a leading slash, into its two
 * names. Null for anything else: more or fewer segments, a `~user` path, or
 * a character no namespace or repository name has. Used for the path of an
 * SSH command, where the client chose every byte.
 */
export function parseRepositoryPath(path: string): { owner: string; name: string } | null {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  const segments = trimmed.split("/");
  if (segments.length !== 2) return null;
  const owner = segments[0]!;
  let name = segments[1]!;
  if (name.toLowerCase().endsWith(".git")) name = name.slice(0, -4);
  if (!NAME.test(owner) || !NAME.test(name)) return null;
  if (owner.startsWith(".") || name.startsWith(".") || owner.startsWith("~")) return null;
  return { owner, name };
}
