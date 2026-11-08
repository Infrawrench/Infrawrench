/**
 * Invariants of the HttpApi domains that no single domain's tests can see.
 *
 * - Every endpoint registers on the one router `api` serves: FindMyWay
 *   refuses a second handler for a method and path, so two domains claiming
 *   the same route fail here rather than in production.
 * - The org tree's guard (`orgTreeGuard`, a wildcard under `/api/org/:orgId`)
 *   only ever answers what no endpoint routes, which holds while no endpoint
 *   sits on the bare prefix or puts a parameter right after it.
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
const { ORG_TREE_PREFIX } = await import("@/http/prefix-guard");

const isRouterPath = (path: string): path is `/${string}` => path.startsWith("/");

describe("HttpApi domains", () => {
  it("register every endpoint on one router", async () => {
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
    // The router side must be non-trivial for the check to mean anything.
    expect(router.find("GET", "/api/org/sample/budgets/sample")).toBeDefined();
    // The real handler builds over every domain and the guards (a duplicate
    // route would fail the build) and answers what nothing routes.
    const res = await api.request("/api/no-such-route");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
  });

  it("leave the org tree's guard only what no endpoint routes", () => {
    const competing = DOMAINS.flatMap((domain) =>
      domain
        .endpoints()
        .filter(
          (endpoint) =>
            endpoint.path === ORG_TREE_PREFIX ||
            endpoint.path.startsWith(`${ORG_TREE_PREFIX}/:`) ||
            endpoint.path.startsWith(`${ORG_TREE_PREFIX}/*`),
        )
        .map((endpoint) => `${domain.name}: ${endpoint.method} ${endpoint.path}`),
    );
    expect(competing).toEqual([]);
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
