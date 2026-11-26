/**
 * What a handler runs with, and how promise code is called from Effect here.
 *
 * The handlers are promise code: an `async` function per endpoint that reads
 * Postgres through the query modules (`../db/`) and Git through a
 * `RepoReader`, and refuses by throwing one of the contract's error classes.
 * Effect serves them (`HttpApi` routing, decoding, encoding, middleware), and
 * {@link op} is the bridge: it builds the handler's {@link Cx} from what the
 * middlewares left on the fiber and runs the whole handler as one call inside
 * the invocation's request scope.
 *
 * That one call is the rule that keeps requests apart. `db` resolves through
 * an AsyncLocalStorage scope (`db/client.ts`), Effect does not carry
 * AsyncLocalStorage, and its scheduler can resume a fiber under another
 * request's store. So Effect code here never touches `db`: everything that
 * does goes through {@link inScope}, which re-enters this request's scope
 * explicitly (KNOWLEDGE.md "AsyncLocalStorage and Effect").
 */
import { Context, Effect } from "effect";
import {
  type RequestScope,
  runInRequestScope,
} from "@infrawrench/server-core/runtime/request-scope";
import { type RepoAccessLevel, forbidden } from "@infrawrench/git-contract";
import type { Authenticated } from "../auth/authenticate";
import type { Admit } from "../http/admission";
import { ANONYMOUS, type Principal } from "../auth/principal";
import type { RepositoryWithOwner } from "../db/repositories";
import type { Env } from "../env";
import type { RepoLocator, RepoReader } from "../repo/reader";
import type { RepoReaderFactory } from "../repo/select";
import { type Viewer, resolveViewer } from "./viewer";
import { describeError } from "../http/log";

/** One invocation of the Worker's `fetch`, as the API sees it. */
export interface Invocation {
  readonly env: Env;
  /** The web `Request` as it arrived. */
  readonly request: Request;
  /** `ExecutionContext.waitUntil`: work that outlives the response. */
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** The request scope `withDb` opened, captured where it was the caller's own. */
  readonly scope: RequestScope | undefined;
  readonly readers: RepoReaderFactory;
  /** Resolves the request's credential (`auth/authenticate.ts`); tests pass their own. */
  readonly authenticate: (request: Request, env: Env) => Promise<Authenticated>;
  /** Counts the request against whoever it authenticated as (`http/admission.ts`). */
  readonly admit: Admit;
  /**
   * `Set-Cookie` lines for whatever response this request ends in, refusals
   * included: a refreshed session, a cleared one. The entry (`./server.ts`)
   * appends them to the web `Response`, one header each.
   */
  readonly cookies: string[];
}

export const InvocationRef = Context.Reference<Invocation | null>("infrawrench/git/Invocation", {
  defaultValue: () => null,
});

/** Who the request is from, once `Authentication` has run. */
export interface AuthState extends Authenticated {
  /** The person's username, once they have claimed one. */
  readonly username: string | null;
}

const NOBODY: AuthState = {
  principal: ANONYMOUS,
  refused: false,
  setCookies: [],
  email: null,
  username: null,
};

export const AuthRef = Context.Reference<AuthState>("infrawrench/git/Auth", {
  defaultValue: () => NOBODY,
});

/** The repository `:owner/:repo` resolved to, once `RepositoryAccess` has run. */
export interface RepoState {
  readonly found: RepositoryWithOwner;
  /** `repoAccess` now. Never `none`. */
  readonly access: Exclude<RepoAccessLevel, "none">;
  /** The level before an archived repository's read-only cap. */
  readonly unarchived: RepoAccessLevel;
}

export const RepoRef = Context.Reference<RepoState | null>("infrawrench/git/Repo", {
  defaultValue: () => null,
});

export const invocation = Effect.gen(function* () {
  const current = yield* InvocationRef;
  if (current === null) return yield* Effect.die(new Error("No invocation on this fiber"));
  return current;
});

/** Call promise code inside the invocation's request scope. A rejection is a defect. */
export const inScope = <A>(fn: (inv: Invocation) => PromiseLike<A> | A): Effect.Effect<A> =>
  Effect.gen(function* () {
    const inv = yield* invocation;
    return yield* Effect.promise(() =>
      Promise.resolve(inv.scope ? runInRequestScope(inv.scope, () => fn(inv)) : fn(inv)),
    );
  });

/** What every handler gets. */
export interface Cx {
  readonly env: Env;
  readonly request: Request;
  readonly auth: AuthState;
  readonly principal: Principal;
  /** The signed-in person's id: a session or a personal token. Null for everything else. */
  readonly userId: string | null;
  readonly username: string | null;
  /** The reader of any repository (a fork's parent, a pull request's head). */
  reader(locator: RepoLocator): RepoReader;
  /** What the caller can see in lists. Resolved once per request. */
  viewer(): Promise<Viewer>;
  /** Work that outlives the response. Failures are logged, never thrown. */
  background(work: Promise<unknown>): void;
  /** A `Set-Cookie` line for the response. */
  setCookie(line: string): void;
}

/** A handler under `/api/repos/:owner/:repo`. */
export interface RepoCx extends Cx {
  readonly repo: RepositoryWithOwner;
  readonly access: Exclude<RepoAccessLevel, "none">;
  readonly unarchived: RepoAccessLevel;
  /** The reader of the repository in the path. */
  readonly git: RepoReader;
}

const makeCx = (inv: Invocation, auth: AuthState): Cx => {
  let viewer: Promise<Viewer> | undefined;
  const principal = auth.principal;
  return {
    env: inv.env,
    request: inv.request,
    auth,
    principal,
    userId: principal.kind === "user" ? principal.userId : null,
    username: auth.username,
    reader: (locator) => inv.readers(inv.env, locator),
    viewer: () => (viewer ??= resolveViewer(principal)),
    background: (work) =>
      inv.waitUntil(
        work.catch((error: unknown) =>
          console.error(`[git] background work failed: ${describeError(error)}`),
        ),
      ),
    setCookie: (line) => void inv.cookies.push(line),
  };
};

/** Methods that change nothing. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether the principal may change anything through the API. A personal
 * token without `repo:write` reads and nothing else: its scope is "clone and
 * read", so it does not comment, open threads, review, star or rename either,
 * which the per-repository level alone (`read` is enough for those) would let
 * it do.
 */
export const mayWriteThroughApi = (principal: Principal): boolean =>
  principal.kind !== "user" ||
  principal.via !== "token" ||
  (principal.scopes ?? []).includes("repo:write");

const runHandler = <A>(build: (cx: Cx) => Promise<A>): Effect.Effect<A> =>
  Effect.gen(function* () {
    const auth = yield* AuthRef;
    return yield* inScope(async (inv) => {
      if (!READS.has(inv.request.method.toUpperCase()) && !mayWriteThroughApi(auth.principal)) {
        throw forbidden("This token can only read: it needs the repo:write scope");
      }
      return build(makeCx(inv, auth));
    });
  });

/** Serve an endpoint with promise code. Throw a contract error class to refuse. */
export const op =
  <I, A>(handler: (cx: Cx, input: I) => Promise<A>) =>
  (input: I): Effect.Effect<A> =>
    runHandler((cx) => handler(cx, input));

export const locatorOf = ({ repository, owner }: RepositoryWithOwner): RepoLocator => ({
  id: repository.id,
  owner: owner.slug,
  name: repository.name,
});

/** {@link op} for an endpoint under `/api/repos/:owner/:repo`. */
export const repoOp =
  <I, A>(handler: (cx: RepoCx, input: I) => Promise<A>) =>
  (input: I): Effect.Effect<A> =>
    Effect.gen(function* () {
      const state = yield* RepoRef;
      if (state === null) return yield* Effect.die(new Error("No repository on this fiber"));
      return yield* runHandler((cx) =>
        handler(
          {
            ...cx,
            repo: state.found,
            access: state.access,
            unarchived: state.unarchived,
            git: cx.reader(locatorOf(state.found)),
          },
          input,
        ),
      );
    });
