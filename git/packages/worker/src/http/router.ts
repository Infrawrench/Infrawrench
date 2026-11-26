/**
 * Which part of the Worker a request is for. One function over the path, so
 * the split between the JSON API, sign-in, the Git transports and the UI is
 * stated once and tested without any of them.
 *
 * | Path                                         | Route             |
 * | -------------------------------------------- | ----------------- |
 * | `/api`, `/api/...`                           | `api`             |
 * | `/auth/sign-in`, `/callback`, `/sign-out`    | `auth`            |
 * | `/auth/t3/callback`                          | `auth`            |
 * | `/:owner/:repo.git/...`                      | `smart-http`      |
 * | `/:owner/:repo/raw/...`                      | `raw`             |
 * | `/:owner/:repo/archive/...`                  | `archive`         |
 * | `/:owner/:repo/terraform/:workspace/state..` | `terraform-state` |
 * | `/:owner/:repo/terraform/:workspace/runs/:id/plan` | `terraform-plan` |
 * | `/-/image`                                   | `image-proxy`     |
 * | everything else                              | `assets` (the UI) |
 *
 * The Git and Terraform routes are the storage's to serve. Until they exist
 * {@link serve} answers them 503 rather than the UI's shell, so `git clone`
 * and `terraform init` fail saying why.
 */
import { AUTH_PATHS, IMAGE_PROXY_PATH } from "@infrawrench/git-contract";
import type { Env } from "../env";
import { requestIdOf, withSecurityHeaders } from "./security-headers";
import { admissionFor } from "./admission";
import { describeError, redact } from "./log";

/** `owner` and `repo` as the path spelled them (`repo` without its `.git`). */
export interface RepoPath {
  readonly owner: string;
  readonly repo: string;
  /** The segments after the route's own, not decoded. */
  readonly rest: readonly string[];
}

export type Route =
  | { readonly kind: "api" }
  | {
      readonly kind: "auth";
      readonly action: "sign-in" | "callback" | "sign-out" | "t3-callback";
    }
  | ({ readonly kind: "smart-http" } & RepoPath)
  | ({ readonly kind: "raw" } & RepoPath)
  | ({ readonly kind: "archive" } & RepoPath)
  | ({ readonly kind: "terraform-state"; readonly workspace: string } & RepoPath)
  | ({
      readonly kind: "terraform-plan";
      readonly workspace: string;
      readonly runId: string;
    } & RepoPath)
  | { readonly kind: "image-proxy" }
  | { readonly kind: "assets" }
  | { readonly kind: "not-found" };

const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export const routeOf = (pathname: string): Route => {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const [first, second, third] = segments;
  if (first === "api") return { kind: "api" };
  // A namespace cannot be called `-` (client-core `git-names.ts`).
  if (first === "-")
    return pathname === IMAGE_PROXY_PATH ? { kind: "image-proxy" } : { kind: "not-found" };
  if (first === "auth") {
    if (pathname === AUTH_PATHS.signIn) return { kind: "auth", action: "sign-in" };
    if (pathname === AUTH_PATHS.callback) return { kind: "auth", action: "callback" };
    if (pathname === AUTH_PATHS.signOut) return { kind: "auth", action: "sign-out" };
    if (pathname === AUTH_PATHS.t3Callback) return { kind: "auth", action: "t3-callback" };
    return { kind: "not-found" };
  }
  if (first === undefined || second === undefined) return { kind: "assets" };
  const owner = decode(first);
  if (second.toLowerCase().endsWith(".git")) {
    return {
      kind: "smart-http",
      owner,
      repo: decode(second).slice(0, -4),
      rest: segments.slice(2),
    };
  }
  const repo = decode(second);
  if (third === "raw") return { kind: "raw", owner, repo, rest: segments.slice(3) };
  if (third === "archive") return { kind: "archive", owner, repo, rest: segments.slice(3) };
  if (third === "terraform" && segments[4] === "state") {
    return {
      kind: "terraform-state",
      owner,
      repo,
      workspace: decode(segments[3] ?? ""),
      rest: segments.slice(5),
    };
  }
  // A run's job posts its plan here, and the app reads what it prices (`terraform/route.ts`).
  if (
    third === "terraform" &&
    segments[4] === "runs" &&
    segments[6] === "plan" &&
    segments.length === 7
  ) {
    return {
      kind: "terraform-plan",
      owner,
      repo,
      workspace: decode(segments[3] ?? ""),
      runId: decode(segments[5] ?? ""),
      rest: [],
    };
  }
  return { kind: "assets" };
};

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

type Handler<R> = (request: Request, env: Env, ctx: Ctx, route: R) => Promise<Response>;

/** What `src/index.ts` wires in. Each is one module of the Worker. */
export interface Routes {
  readonly api: Handler<Extract<Route, { kind: "api" }>>;
  readonly auth: Handler<Extract<Route, { kind: "auth" }>>;
  /**
   * INSERTION POINT (storage): `/<owner>/<repo>.git/info/refs`,
   * `git-upload-pack`, `git-receive-pack`. Resolve the repository and the
   * principal (`auth/authenticate.ts`, `auth/repo-access.ts`; job tokens per
   * NOTES-ci.md section 2), then hand the body to the repository's Durable
   * Object.
   */
  readonly smartHttp?: Handler<Extract<Route, { kind: "smart-http" }>>;
  /** INSERTION POINT (storage): `/<owner>/<repo>/raw/<ref>/<path>` (`urls.ts`, NOTES-ci.md section 3). */
  readonly raw?: Handler<Extract<Route, { kind: "raw" }>>;
  /** INSERTION POINT (storage): `/<owner>/<repo>/archive/<ref>.tar.gz|.zip` (`?token=` on this route alone). */
  readonly archive?: Handler<Extract<Route, { kind: "archive" }>>;
  /**
   * INSERTION POINT (Terraform): `/<owner>/<repo>/terraform/<workspace>/state`
   * with `/lock` and `/unlock`, over `@infrawrench/git-terraform`'s
   * `handleStateRequest`.
   */
  readonly terraformState?: Handler<Extract<Route, { kind: "terraform-state" }>>;
  /** `/<owner>/<repo>/terraform/<workspace>/runs/<run id>/plan`: a run's plan, posted by its job. */
  readonly terraformPlan?: Handler<Extract<Route, { kind: "terraform-plan" }>>;
  /** `/-/image?url=`: an image from another site (`images/proxy.ts`). */
  readonly imageProxy?: Handler<Extract<Route, { kind: "image-proxy" }>>;
}

const text = (body: string, status: number, headers: Record<string, string> = {}): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });

const notReady = (what: string): Response =>
  text(`${what} is not available yet\n`, 503, { "retry-after": "60", "cache-control": "no-store" });

/** The built UI, with `index.html` for a path that is one of its routes. */
const assets = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text("Method Not Allowed\n", 405, { allow: "GET, HEAD" });
  }
  if (!env.ASSETS) return text("Not Found\n", 404);
  // The `assets` binding's `not_found_handling: "single-page-application"`
  // answers `index.html` for a navigation to a path it has no file for.
  const response = await env.ASSETS.fetch(request as never);
  return response as unknown as Response;
};

const dispatch = (request: Request, env: Env, ctx: Ctx, routes: Routes): Promise<Response> => {
  const route = routeOf(new URL(request.url).pathname);
  switch (route.kind) {
    case "api":
      return routes.api(request, env, ctx, route);
    case "auth":
      return routes.auth(request, env, ctx, route);
    case "smart-http":
      return routes.smartHttp
        ? routes.smartHttp(request, env, ctx, route)
        : Promise.resolve(notReady("Git over HTTPS"));
    case "raw":
      return routes.raw
        ? routes.raw(request, env, ctx, route)
        : Promise.resolve(notReady("Raw file access"));
    case "archive":
      return routes.archive
        ? routes.archive(request, env, ctx, route)
        : Promise.resolve(notReady("Archive download"));
    case "terraform-state":
      return routes.terraformState
        ? routes.terraformState(request, env, ctx, route)
        : Promise.resolve(notReady("The Terraform state backend"));
    case "terraform-plan":
      return routes.terraformPlan
        ? routes.terraformPlan(request, env, ctx, route)
        : Promise.resolve(notReady("Terraform runs"));
    case "image-proxy":
      return routes.imageProxy
        ? routes.imageProxy(request, env, ctx, route)
        : Promise.resolve(text("Not Found\n", 404));
    case "assets":
      return assets(request, env);
    case "not-found":
      return Promise.resolve(text("Not Found\n", 404));
  }
};

/** Serve a request: route it, and put the security headers and the request id on the answer. */
export const serve = async (
  request: Request,
  env: Env,
  ctx: Ctx,
  routes: Routes,
): Promise<Response> => {
  const requestId = requestIdOf(request);
  // The UI's own files are not counted; everything that reaches code is.
  const counted = routeOf(new URL(request.url).pathname).kind !== "assets";
  const admission = counted ? admissionFor(env) : null;
  let response: Response;
  try {
    response = (await admission?.refuse(request)) ?? (await dispatch(request, env, ctx, routes));
    if (admission) ctx.waitUntil(admission.record(request, response));
  } catch (error) {
    // The path only: a query string can carry a token (the archive route's).
    console.error(
      `[git] ${request.method} ${redact(new URL(request.url).pathname, 300)} failed requestId=${requestId}: ${describeError(error)}`,
    );
    response = text("Internal Server Error\n", 500);
  }
  return withSecurityHeaders(response, request, env, requestId);
};
