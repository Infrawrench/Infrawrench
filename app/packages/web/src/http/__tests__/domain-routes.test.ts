/**
 * The edge's lazily loaded API (`api/edge.ts`) answers what `api` answers.
 *
 * That rests on three things, each checked here:
 *
 * - `domain-routes.gen.ts` is current: every route every domain's layer
 *   registers, and a loader for every domain in `DOMAINS`;
 * - for every route, the domain the table picks is one whose own routes (plus
 *   the org tree's guard) still pick that same route, so the handler the edge
 *   builds runs exactly the route the full router would;
 * - end to end, the edge and `api` answer a sample of requests alike.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["WORKOS_API_KEY"] ??= "sk_test_domain_routes";
  process.env["WORKOS_CLIENT_ID"] ??= "client_domain_routes";
});

const { DOMAINS } = await import("@/http/domains");
const { DOMAIN_LOADERS, DOMAIN_ROUTES } = await import("@/http/domain-routes.gen");
const { renderDomainRoutesModule, recordRoutes } = await import("@/http/domain-routes-build");
const { ORG_TREE_GUARD, findRoute, makeRouteTable } = await import("@/http/domain-routes");
const { api } = await import("@/api/index");
const { edgeApi, edgeRouteOwner } = await import("@/api/edge");

const GENERATED = fileURLToPath(new URL("../domain-routes.gen.ts", import.meta.url));

/** A concrete URL a route pattern matches: every parameter and wildcard becomes `sample`. */
const sampleUrl = (path: string) =>
  path.replace(/:[A-Za-z0-9_]+/g, "sample").replace(/\/\*$/, "/sample");

/** One method the route takes, as a request would send it. */
const sampleMethod = (method: string) => (method === "*" ? "GET" : method);

describe("the edge's domain routes", () => {
  it("are current (regenerate with `pnpm --filter @infrawrench/web generate:domain-routes`)", async () => {
    expect(await renderDomainRoutesModule()).toBe(readFileSync(GENERATED, "utf8"));
  });

  it("load every domain by its own name, and only those", async () => {
    expect(Object.keys(DOMAIN_LOADERS).sort()).toEqual(DOMAINS.map((d) => d.name).sort());
    for (const [name, load] of Object.entries(DOMAIN_LOADERS)) {
      const domain = await load();
      expect(domain.name, name).toBe(name);
      expect(DOMAINS, name).toContain(domain);
    }
  });

  it("record every endpoint a domain declares", async () => {
    // The recorder sees the layer, so this is the floor, not the whole list:
    // the prefix guards add routes no endpoint describes.
    const budgets = DOMAINS.find((d) => d.name === "budgets")!;
    const recorded = new Set((await recordRoutes(budgets)).map(([m, p]) => `${m} ${p}`));
    for (const endpoint of budgets.endpoints()) {
      expect(recorded).toContain(`${endpoint.method} ${endpoint.path}`);
    }
    expect(DOMAIN_ROUTES.some(([d, m, p]) => d === "auth" && m === "*" && p.endsWith("/*"))).toBe(
      true,
    );
  });

  it("send every route to a domain whose own routes still pick it", () => {
    const full = makeRouteTable(DOMAIN_ROUTES);
    const subsets = new Map<string, ReturnType<typeof makeRouteTable>>();
    const mismatches: string[] = [];
    for (const [, method, path] of DOMAIN_ROUTES) {
      const url = sampleUrl(path);
      const verb = sampleMethod(method);
      const winner = findRoute(full, verb, url);
      if (!winner) {
        mismatches.push(`${verb} ${url}: nothing matches its own route`);
        continue;
      }
      const owner = winner[0];
      let subset = subsets.get(owner);
      if (!subset) {
        subset = makeRouteTable(DOMAIN_ROUTES.filter(([d]) => d === owner || d === ORG_TREE_GUARD));
        subsets.set(owner, subset);
      }
      const picked = findRoute(subset, verb, url);
      if (picked !== winner) {
        mismatches.push(
          `${verb} ${url}: full picks ${winner.join(" ")}, subset ${picked?.join(" ")}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("route HEAD as GET, ignore the query, and leave unknown paths to the guard", () => {
    const owner = (method: string, path: string) =>
      edgeRouteOwner(new Request(`https://app.example${path}`, { method }));
    expect(owner("GET", "/api/org/o1/team/me")).toBe("team");
    expect(owner("HEAD", "/api/org/o1/team/me")).toBe("team");
    expect(owner("GET", "/api/org/o1/team/me?x=1")).toBe("team");
    expect(owner("GET", "/api/org/o1/no-such-thing")).toBeUndefined();
    expect(owner("GET", "/api/no-such-thing")).toBeUndefined();
    expect(owner("DELETE", "/api/auth/no-such-thing")).toBe("auth");
  });

  it("answer requests as the full API does", async () => {
    for (const [method, path] of [
      ["GET", "/api/no-such-route"],
      ["GET", "/api/org/o1/no-such-route"],
      ["GET", "/api/org/o1/team/me"],
      ["HEAD", "/api/org/o1/team/me"],
      ["POST", "/api/org/o1/budgets"],
      ["GET", "/api/auth/me"],
      ["GET", "/api/profile/no-such-route"],
      ["PUT", "/api/admin"],
    ] as const) {
      const request = () => new Request(`http://localhost${path}`, { method });
      const [full, edge] = await Promise.all([api.fetch(request()), edgeApi.fetch(request())]);
      const label = `${method} ${path}`;
      expect(edge.status, label).toBe(full.status);
      expect(await edge.text(), label).toBe(await full.text());
      expect(edge.headers.get("content-type"), label).toBe(full.headers.get("content-type"));
    }
  });
});
