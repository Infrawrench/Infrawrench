/**
 * The web API: every HttpApi domain (`http/domains.ts`) and the org tree's
 * guard on one Effect router (`http/server.ts`).
 *
 * `server.ts` (the Node gateway), the edge Worker (`edge/worker.ts`), the
 * Lambda gateway (`lambda/handler.ts`) and the tests call it through
 * {@link api}: `fetch(request, env?, executionCtx?)` serves a web `Request`,
 * and `request(path, init?)` builds one for a path on `http://localhost`.
 *
 * What runs where, for a request no domain routes, is all on the router:
 *
 * - under `/api/org/:orgId`, the org tree's own auth (`OrgAuth`) first, so an
 *   unknown path answers 401 without a credential, 403 to a non-member, and
 *   the 404 only to a member (`orgTreeGuard` in `http/prefix-guard.ts`;
 *   `authed-scope.test.ts` drives the real `api` to keep it so);
 * - under each session-only prefix (`/api/auth`, `/api/profile`, `/api/orgs`,
 *   `/api/invitations`, `/api/admin`, `/api/push`), `SessionAuth` the same way
 *   (`guardSessionPrefixes`), never reaching the org tree;
 * - anywhere else, `404 Not Found`.
 *
 * Every response carries the baseline security headers
 * (`api/security-headers.ts`), applied by the router's global middleware.
 *
 * The surfaces outside every auth layer (the WorkOS sign-in callback, the
 * OAuth hops, inbound Slack and webhooks, public status pages and calendar
 * feeds, agent registration, the discovery documents and the API's own docs)
 * and those that authenticate themselves (the bearer-only `/api/v1` surface,
 * chat and the push-up surfaces for servers outside Infrawrench) are domains
 * like any other; each one's module says how it decides who may call it.
 */
import { DOMAINS } from "../http/domains";
import { MiddlewareLive } from "../http/middleware-live";
import { orgTreeGuard } from "../http/prefix-guard";
import { makeHttpApiHandler } from "../http/server";

const handler = makeHttpApiHandler([...DOMAINS, orgTreeGuard()], MiddlewareLive);

/** A path on `http://localhost` (the leading slash optional), or an absolute URL. */
function requestUrl(input: string | URL): string {
  if (input instanceof URL) return input.href;
  if (/^https?:\/\//.test(input)) return input;
  return `http://localhost${input.startsWith("/") ? "" : "/"}${input}`;
}

export const api = {
  /**
   * Serve one request. `env` and `executionCtx` are the Worker's bindings and
   * execution context on the edge (read through `Invocation`); Node passes
   * neither.
   */
  fetch(request: Request, env?: unknown, executionCtx?: unknown): Promise<Response> {
    return handler.handle(request, env, executionCtx);
  },

  /** Serve a request for `input`, built with `init`: the tests' entry point. */
  request(input: string | URL | Request, init?: RequestInit, env?: unknown): Promise<Response> {
    const request =
      input instanceof Request
        ? init
          ? new Request(input, init)
          : input
        : new Request(requestUrl(input), init);
    return handler.handle(request, env);
  },
};
