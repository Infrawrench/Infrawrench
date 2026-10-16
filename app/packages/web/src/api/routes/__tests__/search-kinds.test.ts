import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

/**
 * `GET /search?kinds=…`: the command palette's index. Every table is a tagged
 * stub so the db mock can answer each loader by the table it selects from,
 * whatever order the loaders run in.
 */
const table = (name: string) =>
  new Proxy({ __table: name } as Record<string, unknown>, {
    get: (t, prop) => (prop in t ? t[prop as string] : `${name}.${String(prop)}`),
  });

vi.mock("@/db/schema", () => {
  const names = [
    "accounts",
    "budgets",
    "businessMetrics",
    "costCanvases",
    "costReportFolders",
    "costReports",
    "costScenarioModels",
    "dashboards",
    "logWorkspaceQueries",
    "queryMonitors",
    "resources",
    "runbooks",
    "savedCostFilters",
    "services",
    "slos",
    "statusPages",
    "syntheticProbes",
    "virtualTags",
    "workflows",
  ];
  return Object.fromEntries(names.map((n) => [n, table(n)]));
});

const rowsByTable = new Map<string, unknown[]>();
const selectedTables: string[] = [];

function chain() {
  let rows: unknown[] = [];
  const c: Record<string, unknown> = {
    from: (t: { __table: string }) => {
      selectedTables.push(t.__table);
      rows = rowsByTable.get(t.__table) ?? [];
      return c;
    },
    where: () => c,
    orderBy: () => c,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return c;
}

vi.mock("@/db/client", () => ({ db: { select: () => chain() } }));
vi.mock("@/plugins/loader", () => ({ getPlugin: async () => null }));

const hidden = new Set<string>();
const filterVisibleObjects = vi.fn(async (_org: string, _type: string, items: { id: string }[]) =>
  items.filter((i) => !hidden.has(i.id)),
);
vi.mock("@/services/object-sharing", () => ({
  filterVisibleObjects: (...a: unknown[]) =>
    filterVisibleObjects(...(a as Parameters<typeof filterVisibleObjects>)),
}));
const visibilityOwnerCondition = vi.fn(() => undefined);
vi.mock("@/services/cost-visibility-filter", () => ({
  visibilityOwnerCondition: () => visibilityOwnerCondition(),
}));

const { searchRoutes, parseSearchKinds } = await import("@/api/routes/search");
const { SEARCH_KIND_PERMISSION } = await import("@/services/palette-search");
const { REQUIRED_PERMISSION } = await import("@/api/openapi/required-permissions");

describe("SEARCH_KIND_PERMISSION", () => {
  // A kind is searchable on exactly the permission its own list route needs:
  // a looser gate would leak names through the palette.
  const listRoutes: Partial<Record<keyof typeof SEARCH_KIND_PERMISSION, string>> = {
    cost_report: "GET /cost-reports",
    cost_report_folder: "GET /cost-report-folders",
    dashboard: "GET /dashboards",
    cost_canvas: "GET /cost-canvases",
    saved_cost_filter: "GET /saved-cost-filters",
    virtual_tag: "GET /virtual-tags",
    business_metric: "GET /business-metrics",
    scenario_model: "GET /cost-scenarios",
    slo: "GET /slos",
    service: "GET /services",
    status_page: "GET /status-pages",
    probe: "GET /probes",
    log_query: "GET /log-workspaces",
  };

  it("matches each kind's list route", () => {
    for (const [kind, route] of Object.entries(listRoutes)) {
      expect([kind, REQUIRED_PERMISSION[route!]]).toEqual([
        kind,
        SEARCH_KIND_PERMISSION[kind as keyof typeof SEARCH_KIND_PERMISSION],
      ]);
    }
  });
});

describe("parseSearchKinds", () => {
  it("takes all, a list, and dedupes", () => {
    expect(parseSearchKinds("all")).toContain("cost_report");
    expect(parseSearchKinds("slo, slo ,dashboard")).toEqual(["slo", "dashboard"]);
  });

  it("refuses unknown kinds", () => {
    expect(parseSearchKinds("slo,nope")).toBeNull();
  });
});

describe("GET /search?kinds=", () => {
  beforeEach(() => {
    rowsByTable.clear();
    selectedTables.length = 0;
    hidden.clear();
    vi.clearAllMocks();
  });

  it("400s on an unknown kind", async () => {
    const res = await buildTestApp(searchRoutes).request("/?q=x&kinds=bogus");
    expect(res.status).toBe(400);
  });

  it("still requires resources:read without kinds", async () => {
    const res = await buildTestApp(searchRoutes, ["costs:read"]).request("/?q=x");
    expect(res.status).toBe(403);
  });

  it("skips kinds the caller's role cannot read instead of refusing", async () => {
    rowsByTable.set("costReports", [{ id: "r1", name: "Team spend", folderId: null }]);
    rowsByTable.set("budgets", [
      { id: "b1", name: "Team budget", amountCents: 100, currency: "USD" },
    ]);
    const res = await buildTestApp(searchRoutes, ["costs:read"]).request(
      "/?q=team&kinds=cost_report,budget",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; kind: string }[];
    expect(body.map((h) => h.kind)).toEqual(["cost_report"]);
    expect(selectedTables).not.toContain("budgets");
  });

  it("narrows sharing-controlled kinds to what the caller could open", async () => {
    rowsByTable.set("dashboards", [
      { id: "d1", name: "Prod overview", isDefault: false },
      { id: "d2", name: "Prod secrets", isDefault: false },
    ]);
    hidden.add("d2");
    const res = await buildTestApp(searchRoutes).request("/?q=prod&kinds=dashboard");
    const body = (await res.json()) as { id: string }[];
    expect(body.map((h) => h.id)).toEqual(["d1"]);
    expect(filterVisibleObjects).toHaveBeenCalledWith(
      "org-1",
      "dashboard",
      expect.any(Array),
      expect.any(Function),
    );
  });

  it("applies the budget visibility predicate", async () => {
    rowsByTable.set("budgets", [{ id: "b1", name: "Infra", amountCents: 250000, currency: "EUR" }]);
    const res = await buildTestApp(searchRoutes).request("/?q=infra&kinds=budget");
    const body = (await res.json()) as { subtitle: string; kind: string; pluginId: string }[];
    expect(visibilityOwnerCondition).toHaveBeenCalled();
    expect(body[0]).toMatchObject({
      kind: "budget",
      pluginId: "__objects__",
      subtitle: "2,500 EUR",
    });
  });

  it("fuzzy-ranks within a kind and orders kinds by their best hit", async () => {
    rowsByTable.set("slos", [
      { id: "s1", name: "Checkout latency", targetPercent: 99.9, description: null },
    ]);
    rowsByTable.set("services", [
      { id: "v1", name: "Payments", slug: "payments", ownerTeam: "checkout" },
      { id: "v2", name: "Checkout", slug: "checkout", ownerTeam: null },
    ]);
    const res = await buildTestApp(searchRoutes).request("/?q=checkout&kinds=slo,service");
    const body = (await res.json()) as { id: string }[];
    // "Checkout" is an exact name match, so services lead and rank it first.
    expect(body.map((h) => h.id)).toEqual(["v2", "v1", "s1"]);
  });

  it("drops hits that do not match every token", async () => {
    rowsByTable.set("runbooks", [
      { id: "rb1", name: "Restart workers", description: "When the queue backs up" },
      { id: "rb2", name: "Rotate keys", description: null },
    ]);
    const res = await buildTestApp(searchRoutes).request("/?q=restart%20queue&kinds=runbook");
    const body = (await res.json()) as { id: string }[];
    expect(body.map((h) => h.id)).toEqual(["rb1"]);
  });

  it("labels status pages by title and probes by url", async () => {
    rowsByTable.set("statusPages", [{ id: "p1", title: "Public status", slug: "acme" }]);
    rowsByTable.set("syntheticProbes", [{ id: "pr1", name: "Homepage", url: "https://acme.test" }]);
    const res = await buildTestApp(searchRoutes).request("/?q=&kinds=status_page,probe");
    const body = (await res.json()) as { displayName: string; subtitle: string }[];
    expect(body).toEqual([
      expect.objectContaining({ displayName: "Public status", subtitle: "acme" }),
      expect.objectContaining({ displayName: "Homepage", subtitle: "https://acme.test" }),
    ]);
  });
});
