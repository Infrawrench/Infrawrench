/**
 * Invariants of the HttpApi migration that no single domain's tests can see.
 *
 * - The HttpApi router answers before Hono and matches by specificity (a
 *   static segment beats a parameter), where Hono matched in registration
 *   order. A domain whose `/:id` caught a path a Hono route still serves would
 *   silently take that route over, so no Hono route may be reachable by a
 *   domain endpoint.
 * - Every domain documents itself, and the domains' components must agree.
 */
import { describe, expect, it, vi } from "vitest";
import { FindMyWay } from "effect/http";

vi.hoisted(() => {
  process.env["WORKOS_API_KEY"] ??= "sk_test_http_domains";
  process.env["WORKOS_CLIENT_ID"] ??= "client_http_domains";
});

const { api } = await import("@/api/index");
const { DOMAINS } = await import("@/http/domains");
const { buildOpenApiFragment } = await import("@/http/openapi");

const isRouterPath = (path: string): path is `/${string}` => path.startsWith("/");

/** A concrete path a Hono route matches: parameters and wildcards filled in. */
const samplePath = (path: string) =>
  path
    .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, "sample")
    .replace(/\*/g, "sample")
    .replace(/\/+$/, "") || "/";

describe("HttpApi domains", () => {
  it("shadow no route still served by Hono", () => {
    const router = FindMyWay.make<string>();
    for (const domain of DOMAINS) {
      for (const endpoint of domain.endpoints()) {
        if (!isRouterPath(endpoint.path)) throw new Error(`unroutable path ${endpoint.path}`);
        router.on(
          endpoint.method,
          endpoint.path,
          `${domain.name}: ${endpoint.method} ${endpoint.path}`,
        );
      }
    }
    const shadowed = api.routes
      // `use()` registrations are middleware, not routes, and arrive as ALL.
      .filter((route) => route.method !== "ALL")
      .flatMap((route) => {
        const hit = router.find(route.method, samplePath(route.path));
        return hit ? [`${route.method} ${route.path} -> ${hit.handler}`] : [];
      });
    expect(shadowed).toEqual([]);
    // The router side must be non-trivial for the check to mean anything. The
    // Hono side shrinks to nothing as routes move, which is the point.
    expect(router.find("GET", "/api/org/sample/budgets/sample")).toBeDefined();
  });

  it("own the prefixes they guard outright", () => {
    // A guarded prefix answers every method and path under it before Hono
    // does (`http/prefix-guard.ts`), so a Hono route there would sit behind
    // the guard's 401.
    const guarded = DOMAINS.flatMap((domain) => domain.guardedPrefixes ?? []);
    expect(guarded.length).toBeGreaterThan(0);
    const under = api.routes
      .filter((route) => route.method !== "ALL")
      .filter((route) =>
        guarded.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`)),
      )
      .map((route) => `${route.method} ${route.path}`);
    expect(under).toEqual([]);
  });

  it("document themselves without conflicting components", () => {
    const fragment = buildOpenApiFragment(DOMAINS);
    expect(fragment.conflicts).toEqual([]);
    expect(Object.keys(fragment.paths).length).toBeGreaterThan(0);
  });

  it("each have a unique name", () => {
    const names = DOMAINS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
