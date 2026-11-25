/**
 * Who is calling and which repository they named, as the services the
 * worker's middlewares provide to handlers. The tags live here so endpoint
 * definitions can name them; the implementations are the worker's.
 *
 * A client never reads these: a middleware's provided service exists only on
 * the server.
 */
import { Context } from "effect";
import { HttpApi, type HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import type { RepoAccessLevel } from "./annotations";
import { Forbidden, NotFound, Unauthorized } from "./errors";

/**
 * The caller, as far as a handler needs to know. The worker's own `Principal`
 * (`worker/src/auth/principal.ts`) is wider (deploy keys, job tokens); every
 * variant of it projects onto this.
 */
export interface CallerValue {
  /** Null for an anonymous caller, a deploy key and a CI job token. */
  readonly userId: string | null;
  /** The caller's username (their namespace slug), once they have claimed one. */
  readonly username: string | null;
  /** What authenticated the request. */
  readonly via: "anonymous" | "session" | "token" | "ssh-key" | "api-key" | "deploy-key" | "job";
}

export class Caller extends Context.Service<Caller, CallerValue>()("infrawrench/git/Caller") {}

/** The repository `:owner/:repo` resolved to, and what the caller may do to it. */
export interface CurrentRepositoryValue {
  readonly id: string;
  readonly namespaceId: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly archived: boolean;
  readonly defaultBranch: string;
  /** Never `none`: a caller without read access got a 404 before the handler ran. */
  readonly access: Exclude<RepoAccessLevel, "none">;
}

export class CurrentRepository extends Context.Service<CurrentRepository, CurrentRepositoryValue>()(
  "infrawrench/git/CurrentRepository",
) {}

/**
 * Authenticates the request (session cookie, `Authorization: Bearer` or
 * Basic), enforces `RequiresUser` and `RequiredOrgPermission`, and provides
 * {@link Caller}. On every group. Its 401 (nobody signed in) and 403 are
 * every endpoint's, so endpoints do not list them again.
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: Caller }
>()("infrawrench/git/Authentication", { error: [Unauthorized, Forbidden] }) {}

/**
 * Resolves `:owner/:repo`, answers 404 when the caller cannot read it,
 * enforces `RequiredAccess`, and provides {@link CurrentRepository}. On every
 * group whose paths start with `/api/repos/:owner/:repo`, inside
 * {@link Authentication}. Its 404 is every repository endpoint's.
 */
export class RepositoryAccess extends HttpApiMiddleware.Service<
  RepositoryAccess,
  { provides: CurrentRepository; requires: Caller }
>()("infrawrench/git/RepositoryAccess", { error: [Unauthorized, Forbidden, NotFound] }) {}

/** Renders a request that fails its schema as the API's own 400. Outermost on every endpoint. */
export class RequestErrors extends HttpApiMiddleware.Service<RequestErrors>()(
  "infrawrench/git/RequestErrors",
) {}

/**
 * The defaults every `HttpApi` here carries: decode reporting every issue,
 * and {@link RequestErrors} outermost. Call it after the groups are added.
 */
export const withApiDefaults = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
) =>
  api
    .annotate(HttpApi.PayloadParseOptions, { errors: "all" })
    .annotate(HttpApi.QueryParseOptions, { errors: "all" })
    .middleware(RequestErrors);
