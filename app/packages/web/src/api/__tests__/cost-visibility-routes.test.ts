/**
 * Every cost route honours the caller's cost visibility scope.
 *
 * The scope is applied by the ClickHouse readers (server-core
 * `cost-visibility-sql.test.ts` proves every reader does), so what a route
 * has to get right is *running inside* the caller's scope. This suite
 * enumerates the route files that reach cost data and proves each one is
 * either mounted on the org tree, behind `costVisibilityMiddleware`, or
 * establishes the scope itself. A cost route added later fails here until it
 * is classified.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const SRC = join(__dirname, "..", "..");
const ROUTES = join(SRC, "api", "routes");
const DOMAINS_DIR = join(SRC, "http", "domains");
const INDEX = readFileSync(join(SRC, "api", "index.ts"), "utf8");

/** Imports that mean "this module reads cost data". */
const COST_DATA = [
  /services\/cost-query/,
  /services\/budgets/,
  /services\/showback/,
  /services\/unit-cost-query/,
  /services\/cost-reports/,
  /services\/cost-anomalies/,
  /services\/cost-anomaly-feedback/,
  /services\/cost-alerts/,
  /services\/efficiency-alerts/,
  /services\/tag-policy/,
  /services\/cost-scenario-query/,
  /services\/custom-graph/,
  /services\/moment/,
  /services\/blast-radius/,
  /clickhouse\/cost-readers/,
  /clickhouse\/commitment-readers/,
  /clickhouse\/network-flow-readers/,
  /credits\/feed/,
  /commitments\/feed/,
  /savings\/realized/,
  /network-flow\/feed/,
  /backups\/feed/,
  /schedules\/feed/,
  /report-delivery/,
  /cost-exports/,
  /cost\/invoices/,
  /cost\/pricing-preview/,
];

/**
 * Route modules mounted outside the org tree that reach cost data, and how
 * each establishes the scope instead. Adding one here needs a reason.
 */
const SELF_SCOPED: Record<string, { reason: string; mustContain: string }> = {
  "slack-inbound.ts": {
    reason: "Resolves the linked member per org and wraps the query.",
    mustContain: "withPrincipalCostVisibility(",
  },
  "anomaly-feedback-link.ts": {
    reason:
      "The session-authed page behind Teams anomaly cards: resolves the signed-in member and wraps every read and write.",
    mustContain: "withPrincipalCostVisibility(",
  },
};

function readsCostData(text: string): boolean {
  const imports = text.match(/from\s+"[^"]+"/g) ?? [];
  return imports.some((imp) => COST_DATA.some((re) => re.test(imp)));
}

function costRouteFiles(): string[] {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => readsCostData(readFileSync(join(ROUTES, f), "utf8")));
}

/** A domain's source: one module, or every module of its folder. */
function domainSource(entry: string): string {
  const path = join(DOMAINS_DIR, entry);
  if (entry.endsWith(".ts")) return readFileSync(path, "utf8");
  return readdirSync(path)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(path, f), "utf8"))
    .join("\n");
}

/** HttpApi domains (`http/domains/<name>.ts` or `<name>/`) that reach cost data. */
function costDomainFiles(): string[] {
  return readdirSync(DOMAINS_DIR, { withFileTypes: true })
    .filter(
      (d) => (d.isFile() && d.name.endsWith(".ts")) || (d.isDirectory() && d.name !== "__tests__"),
    )
    .map((d) => d.name)
    .filter((name) => readsCostData(domainSource(name)));
}

/** The names `api/index.ts` imports a route module under. */
function importedNames(file: string): string[] {
  const base = file.replace(/\.ts$/, "");
  const re = new RegExp(
    `import\\s+(\\{[^}]*\\}|\\w+)\\s+from\\s+"\\./routes/${base}(?:\\.js)?"`,
    "g",
  );
  const names: string[] = [];
  for (const m of INDEX.matchAll(re)) {
    const spec = m[1]!;
    if (spec.startsWith("{")) {
      for (const part of spec.slice(1, -1).split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop();
        if (name) names.push(name);
      }
    } else names.push(spec);
  }
  return names;
}

describe("cost routes run inside the caller's cost visibility", () => {
  const files = costRouteFiles();

  it("finds the cost routes (sanity)", () => {
    const all = [...files, ...costDomainFiles()].map((f) => f.replace(/\.ts$/, ""));
    for (const f of ["costs", "budgets", "cost-reports", "credits", "commitments"]) {
      expect(all).toContain(f);
    }
  });

  it("serves every HttpApi cost domain through OrgAuth", () => {
    // `OrgAuthLive` resolves the caller's cost visibility and runs the handler
    // inside it, exactly as `costVisibilityMiddleware` does on the Hono tree;
    // a cost domain served through anything else would read unscoped.
    for (const f of costDomainFiles()) {
      const text = domainSource(f);
      expect(text, f).toContain(".middleware(OrgAuth)");
      expect(text, f).not.toContain(".middleware(SessionAuth)");
    }
  });

  it("registers the middleware before any org route", () => {
    const mw = INDEX.indexOf('orgScoped.use("*", costVisibilityMiddleware)');
    const firstRoute = INDEX.indexOf("orgScoped.route(");
    expect(mw).toBeGreaterThan(-1);
    expect(mw).toBeLessThan(firstRoute);
  });

  it.each(costRouteFiles())("%s is behind the middleware or scopes itself", (file) => {
    const self = SELF_SCOPED[file];
    if (self) {
      expect(readFileSync(join(ROUTES, file), "utf8")).toContain(self.mustContain);
      return;
    }
    const names = importedNames(file);
    expect(names.length, `${file} is not imported by api/index.ts`).toBeGreaterThan(0);
    for (const name of names) {
      const mountedOnOrgTree = new RegExp(`orgScoped\\.route\\("[^"]+",\\s*${name}\\)`).test(INDEX);
      expect(mountedOnOrgTree, `${name} (${file}) must be mounted on orgScoped`).toBe(true);
    }
  });

  it("every tool dispatch site goes through runToolHandler", () => {
    for (const rel of ["mcp/server.ts", "chat/agent.ts"]) {
      const text = readFileSync(join(SRC, rel), "utf8");
      expect(text, rel).not.toMatch(/\btool\.handler\(/);
      expect(text, rel).toContain("runToolHandler(");
    }
  });
});

/* ------------------------------------------------------------------ *
 * The middleware itself, with resolution mocked.
 * ------------------------------------------------------------------ */

const scopedVisibility = {
  organizationId: "org-1",
  restricted: true,
  userId: "u1",
  layers: [
    {
      source: {
        kind: "member",
        label: null,
        costCentreIds: [],
        accountIds: ["a"],
        savedFilterId: null,
      },
      accountIds: ["a"],
      costCentreIds: [],
      rules: [],
      filters: null,
      unresolvable: false,
    },
  ],
};
const mockResolve = vi.fn();
vi.mock("@infrawrench/server-core/cost/visibility", () => ({
  resolveCostVisibility: (...a: unknown[]) => mockResolve(...a),
}));
vi.mock("@/services/object-sharing", () => ({
  resolveSharingPrincipal: async () => ({
    organizationId: "org-1",
    userId: "u1",
    roleId: null,
    override: false,
  }),
  runWithSharingPrincipal: (_p: unknown, fn: () => unknown) => fn(),
}));

const { costVisibilityMiddleware, costScopeRouteDenial } = await import("@/auth/cost-visibility");
const { currentCostVisibility } = await import("@infrawrench/server-core/cost/visibility-context");

function app() {
  const a = new Hono();
  a.use("/api/org/:orgId/*", async (c, next) => {
    c.set("session", { userId: "u1", email: "u1@example.com" });
    c.set("organizationId", c.req.param("orgId"));
    c.set("permissions", ["*"]);
    return next();
  });
  a.use("/api/org/:orgId/*", costVisibilityMiddleware);
  a.all("/api/org/:orgId/*", (c) => c.json({ visibility: currentCostVisibility() ?? null }));
  return a;
}

describe("costVisibilityMiddleware", () => {
  it("runs the handler inside the resolved scope", async () => {
    mockResolve.mockResolvedValueOnce(scopedVisibility);
    const res = await app().request("/api/org/org-1/costs/query", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { visibility: { restricted: boolean } };
    expect(body.visibility.restricted).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith("org-1", {
      userId: "u1",
      apiKeyId: null,
      agentRegistrationId: null,
    });
  });

  it("refuses org-wide surfaces to a scoped caller with a coded 403", async () => {
    mockResolve.mockResolvedValueOnce(scopedVisibility);
    const res = await app().request("/api/org/org-1/cost-exports");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cost_scope_restricted" });
  });

  it("lets an unrestricted caller reach them", async () => {
    mockResolve.mockResolvedValueOnce({ organizationId: "org-1", restricted: false });
    const res = await app().request("/api/org/org-1/cost-exports");
    expect(res.status).toBe(200);
  });
});

describe("costScopeRouteDenial", () => {
  it.each([
    ["GET", "/api/org/o/cost-exports", true],
    ["GET", "/api/org/o/custom-cost-sources", true],
    ["POST", "/api/org/o/custom-cost-sources/s1/uploads", true],
    ["GET", "/api/org/o/invoices/123", true],
    ["POST", "/api/org/o/config/apply", true],
    ["PUT", "/api/org/o/cost-visibility", true],
    ["GET", "/api/org/o/cost-visibility", false],
    ["POST", "/api/org/o/team/roles", true],
    ["PATCH", "/api/org/o/team/members/u2/role", true],
    ["DELETE", "/api/org/o/team/members/u2", false],
    ["POST", "/api/org/o/team/invitations", true],
    ["POST", "/api/org/o/costs/query", false],
    ["GET", "/api/org/o/budgets", false],
  ])("%s %s denied=%s", (method, path, denied) => {
    expect(costScopeRouteDenial(method, path) !== null).toBe(denied);
  });
});
