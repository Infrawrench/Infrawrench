/**
 * Serving an HttpApi domain in a route test, as a fixed caller.
 *
 * The counterpart of `api/routes/__tests__/test-utils.ts`'s `buildTestApp`:
 * the caller is `user-1` in `org-1` holding `permissions` (everything by
 * default), the permission gate and the error renderer are the real ones, and
 * nothing reaches the auth chain or the database.
 *
 * ```ts
 * const app = buildTestApi(budgetsDomain, { basePath: "/api/org/org-1/budgets" });
 * const res = await app.request("/b1/events", { method: "GET" });
 * ```
 */
import { Effect, Layer } from "effect";
import { unrestrictedCostVisibility } from "@infrawrench/server-core/cost/visibility-context";
import type { Domain } from "./domain";
import { OrgAuth, RequestErrorsLive, serveAsOrgCaller, SessionAuth } from "./middleware";
import { SessionPrincipal, type OrgPrincipalValue } from "./principal";
import { makeHttpApiHandler } from "./server";

export interface TestCaller {
  /** Defaults to `["*"]`: pass a list to prove a 403 boundary. */
  readonly permissions?: readonly string[];
  /** Prefixed to every path given to `request`, e.g. `/api/org/org-1/budgets`. */
  readonly basePath?: string;
  /** Overrides on the principal, such as an API key or a restricted cost visibility. */
  readonly principal?: Partial<OrgPrincipalValue>;
}

export const TEST_SESSION = { userId: "user-1", email: "test@example.com" } as const;
export const TEST_ORG_ID = "org-1";

export function testPrincipal(caller: TestCaller = {}): OrgPrincipalValue {
  return {
    session: TEST_SESSION,
    organizationId: TEST_ORG_ID,
    permissions: caller.permissions ?? ["*"],
    role: null,
    elevations: [],
    apiKey: undefined,
    costVisibility: unrestrictedCostVisibility(TEST_ORG_ID),
    ...caller.principal,
  };
}

/** The middleware implementations a test runs a domain with. */
export function testMiddleware(caller: TestCaller = {}) {
  const principal = testPrincipal(caller);
  return Layer.mergeAll(
    Layer.succeed(OrgAuth)((httpEffect, { endpoint }) =>
      serveAsOrgCaller(httpEffect, endpoint, {
        principal,
        sharing: undefined,
        auditPrincipal: undefined,
      }),
    ),
    Layer.succeed(SessionAuth)((httpEffect) =>
      Effect.provideService(httpEffect, SessionPrincipal, principal.session),
    ),
    RequestErrorsLive,
  );
}

export interface TestApi {
  /**
   * Hono's `app.request`: a path under `basePath`, or a full URL, and the
   * Worker bindings to serve it with (read through `Invocation`).
   */
  request(path: string, init?: RequestInit, env?: unknown): Promise<Response>;
}

export function buildTestApi(domain: Domain, caller: TestCaller = {}): TestApi {
  const handler = makeHttpApiHandler([domain], testMiddleware(caller));
  return {
    async request(path, init, env) {
      const url = path.startsWith("http")
        ? path
        : `http://localhost${caller.basePath ?? ""}${path}`;
      const headers = new Headers(init?.headers);
      if (typeof init?.body === "string" && !headers.has("content-type")) {
        // Hono's `app.request` callers rarely set it, and HttpApi decodes JSON by content type.
        // Only a string body: a `FormData` or `Blob` carries its own type (and a
        // multipart boundary) that the request derives when none is set.
        headers.set("content-type", "application/json");
      }
      const response = await handler.handle(new Request(url, { ...init, headers }), env);
      return response ?? new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    },
  };
}
