/**
 * Where the MCP server and its authorization server meet the Worker: one
 * function per route, each given the Worker's environment and nothing else.
 * `src/index.ts` loads this module on first use.
 *
 * | Route                 | Served by                 |
 * | --------------------- | ------------------------- |
 * | `/mcp`                | `http.ts` `handleMcp`     |
 * | `/oauth/authorize`    | `oauth/authorize.ts`      |
 * | `/oauth/token`, `/register`, `/revoke` | `oauth/endpoints.ts` |
 * | `/.well-known/*`      | `oauth/endpoints.ts` `handleWellKnown` |
 *
 * Everything that reads Postgres runs inside `withDb` (`mcpFetch`,
 * `oauthFetch`); `serveMcp` and `serveOAuth` are the same wiring for a caller
 * that already has a database scope, which is how the database suites run
 * them. The tools call the JSON API in this process (`api.ts`), and the API
 * resolves `db` through the request scope `withDb` opened, so each call
 * re-enters that scope by hand: the SDK's own scheduling between the request
 * and a tool's callback is not relied on to carry it.
 */
import {
  currentRequestScope,
  runInRequestScope,
} from "@infrawrench/server-core/runtime/request-scope";
import type { GitApiHandler } from "../api/server";
import { authenticateRequest } from "../auth/authenticate";
import { withDb } from "../db/client";
import { getNamespaceForUser } from "../db/namespaces";
import { type Env, siteOrigin } from "../env";
import { admissionFor } from "../http/admission";
import type { Ctx } from "../http/router";
import { handleMcp } from "./http";
import { handleAuthorize } from "./oauth/authorize";
import { resolveClient } from "./oauth/clients";
import { handleRegister, handleRevoke, handleToken, handleWellKnown } from "./oauth/endpoints";
import { dbGrantStore } from "./oauth/grants";

export type OAuthAction = "authorize" | "token" | "register" | "revoke";

/** This site's hosts: never where an OAuth client is sent back to, or fetched from. */
const siteHostsOf = (request: Request, env: Env): string[] => [
  ...new Set([new URL(siteOrigin(env)).hostname, new URL(request.url).hostname]),
];

/** `/mcp`, for a caller already inside a database scope. */
export const serveMcp = (
  request: Request,
  env: Env,
  ctx: Ctx,
  api: GitApiHandler,
): Promise<Response> => {
  const scope = currentRequestScope();
  return handleMcp(request, {
    origin: siteOrigin(env),
    // An agent's token for one branch's markers is taken here: the tools it
    // can use are the API's marker paths, which keep it to its branch.
    authenticate: (bare) => authenticateRequest(bare, env, { agentTokens: true }),
    // The transport is counted as a read whatever it carries: what a tool
    // does is counted again, as what it is, by the API it calls.
    admit: (principal) => admissionFor(env).admit({ method: "GET", url: request.url }, principal),
    api: (inner) =>
      scope
        ? runInRequestScope(scope, () => api.handle(inner, env, ctx))
        : api.handle(inner, env, ctx),
  });
};

/** `/oauth/...`, for a caller already inside a database scope. */
export const serveOAuth = (request: Request, env: Env, action: OAuthAction): Promise<Response> => {
  const origin = siteOrigin(env);
  const password = env.WORKOS_COOKIE_PASSWORD;
  const siteHosts = siteHostsOf(request, env);
  switch (action) {
    case "register":
      // Writes nothing and reads nothing: a client id carries its registration.
      return handleRegister(request, { password, siteHosts });
    case "token":
      return handleToken(request, { origin, password, store: dbGrantStore });
    case "revoke":
      return handleRevoke(request, { password, store: dbGrantStore });
    case "authorize":
      return handleAuthorize(request, {
        origin,
        password,
        authenticate: (incoming) => authenticateRequest(incoming, env),
        admit: (principal) => admissionFor(env).admit(request, principal),
        resolveClient: (clientId) =>
          resolveClient(clientId, {
            password,
            siteHosts,
            fetch: (url, init) => fetch(url, init),
          }),
        usernameOf: async (userId) => (await getNamespaceForUser(userId))?.slug ?? null,
      });
  }
};

export const mcpFetch = (
  request: Request,
  env: Env,
  ctx: Ctx,
  api: GitApiHandler,
): Promise<Response> => withDb(env, ctx, () => serveMcp(request, env, ctx, api));

export const oauthFetch = (
  request: Request,
  env: Env,
  ctx: Ctx,
  action: OAuthAction,
): Promise<Response> =>
  // Registering reads no table: it does not open a database client to do it.
  action === "register"
    ? serveOAuth(request, env, action)
    : withDb(env, ctx, () => serveOAuth(request, env, action));

export const wellKnownFetch = (request: Request, env: Env): Promise<Response> =>
  Promise.resolve(handleWellKnown(request, siteOrigin(env)));
