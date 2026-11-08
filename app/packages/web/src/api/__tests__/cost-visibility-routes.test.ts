/**
 * Every cost route honours the caller's cost visibility scope.
 *
 * The scope is applied by the ClickHouse readers (server-core
 * `cost-visibility-sql.test.ts` proves every reader does), so what a route
 * has to get right is *running inside* the caller's scope. This suite
 * enumerates the HttpApi domains that reach cost data and proves each one is
 * either served through `OrgAuth`, which runs the handler inside the caller's
 * scope, or establishes the scope itself. A cost domain added later fails
 * here until it is classified.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["WORKOS_API_KEY"] ??= "sk_test_cost_visibility_routes";
  process.env["WORKOS_CLIENT_ID"] ??= "client_cost_visibility_routes";
});

const SRC = join(__dirname, "..", "..");
const DOMAINS_DIR = join(SRC, "http", "domains");
/** Where each domain's endpoint definitions (its groups and their middleware) live. */
const CONTRACT_DOMAINS_DIR = join(SRC, "..", "..", "api-contract", "src", "domains");

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
 * HttpApi domains served outside `OrgAuth` that reach cost data, and how each
 * establishes the scope instead. Adding one here needs a reason.
 */
const SELF_SCOPED_DOMAINS: Record<string, { reason: string; mustContain: string }> = {
  "slack-inbound": {
    reason:
      "Slack's slash commands and buttons: resolves the linked member per org and wraps the query.",
    mustContain: "withPrincipalCostVisibility(",
  },
  "anomaly-feedback-link": {
    reason:
      "The session-authed page behind Teams anomaly cards: resolves the signed-in member and wraps every read and write.",
    mustContain: "withPrincipalCostVisibility(",
  },
};

function readsCostData(text: string): boolean {
  const imports = text.match(/from\s+"[^"]+"/g) ?? [];
  return imports.some((imp) => COST_DATA.some((re) => re.test(imp)));
}

/** A module, or every module of a folder. */
function moduleSource(path: string): string {
  if (path.endsWith(".ts")) return readFileSync(path, "utf8");
  return readdirSync(path)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(path, f), "utf8"))
    .join("\n");
}

/** The contract's definitions of a domain: `domains/<name>.ts` or `domains/<name>/`. */
function definitionSource(entry: string): string {
  const name = entry.replace(/\.ts$/, "");
  const file = join(CONTRACT_DOMAINS_DIR, `${name}.ts`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const dir = join(CONTRACT_DOMAINS_DIR, name);
  return existsSync(dir) ? moduleSource(dir) : "";
}

/** A domain's source: its handlers (one module or a folder) and its endpoint definitions. */
function domainSource(entry: string): string {
  return `${moduleSource(join(DOMAINS_DIR, entry))}\n${definitionSource(entry)}`;
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

describe("cost routes run inside the caller's cost visibility", () => {
  it("finds the cost routes (sanity)", () => {
    const all = costDomainFiles().map((f) => f.replace(/\.ts$/, ""));
    for (const f of ["costs", "budgets", "cost-reports", "credits", "commitments"]) {
      expect(all).toContain(f);
    }
  });

  it("serves every HttpApi cost domain through OrgAuth", () => {
    // `OrgAuthLive` resolves the caller's cost visibility and runs the handler
    // inside it (pinned below); a cost domain served through anything else
    // would read unscoped.
    for (const f of costDomainFiles()) {
      const text = domainSource(f);
      const self = SELF_SCOPED_DOMAINS[f];
      if (self) {
        expect(text, f).toContain(self.mustContain);
        expect(text, f).not.toContain(".middleware(");
        continue;
      }
      expect(text, f).toContain(".middleware(OrgAuth)");
      expect(text, f).not.toContain(".middleware(SessionAuth)");
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
 * `OrgAuth` itself, as the server provides it, with resolution mocked.
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
// The caller is a signed-in member holding everything; who they are is not
// what is under test.
vi.mock("@/http/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/http/auth")>()),
  authenticateOrgCaller: (input: { orgId: string | undefined }) =>
    Effect.succeed({
      session: { userId: "u1", email: "u1@example.com" },
      organizationId: input.orgId ?? "",
      permissions: ["*"],
      role: null,
      elevations: [],
      apiKey: undefined,
      auditPrincipal: undefined,
      refreshedSession: undefined,
    }),
}));

const { costScopeRouteDenial } = await import("@/auth/cost-visibility");
const { currentCostVisibility } = await import("@infrawrench/server-core/cost/visibility-context");
const { makeDomain } = await import("@/http/domain");
const { legacy } = await import("@/http/legacy");
const { OrgAuth, withApiDefaults } = await import("@infrawrench/api-contract");
const { MiddlewareLive } = await import("@/http/middleware-live");
const { makeHttpApiHandler } = await import("@/http/server");

const Seen = Schema.Struct({ visibility: Schema.Unknown });
const VisibilityGroup = HttpApiGroup.make("visibility")
  .add(
    HttpApiEndpoint.post("query", "/costs/query", {
      params: { orgId: Schema.String },
      success: Seen,
    }),
    HttpApiEndpoint.get("exports", "/cost-exports", {
      params: { orgId: Schema.String },
      success: Seen,
    }),
  )
  .prefix("/api/org/:orgId")
  .middleware(OrgAuth);
class VisibilityApi extends withApiDefaults(HttpApi.make("visibility").add(VisibilityGroup)) {}

/** What promise code called from the handler sees, as a cost reader would. */
const seenVisibility = legacy(async () => ({ visibility: currentCostVisibility() ?? null }));

const handler = makeHttpApiHandler(
  [
    makeDomain(
      "visibility",
      VisibilityApi,
      HttpApiBuilder.group(VisibilityApi, "visibility", (h) =>
        h.handle("query", () => seenVisibility).handle("exports", () => seenVisibility),
      ),
    ),
  ],
  MiddlewareLive,
);
const app = () => ({
  request: (path: string, init?: RequestInit) =>
    handler.handle(new Request(`http://localhost${path}`, init)),
});

describe("OrgAuth's cost visibility", () => {
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
