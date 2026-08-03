import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildCloudflarePolicyTemplate,
  cloudflarePreflight,
  runCloudflarePreflight,
} from "../preflight.js";

describe("cloudflarePreflight declaration", () => {
  it("declares resources/metrics/costs with dashboard permission-group names", () => {
    expect(cloudflarePreflight.capabilities.map((c) => c.id)).toEqual([
      "resources",
      "metrics",
      "costs",
    ]);
    const costs = cloudflarePreflight.capabilities.find((c) => c.id === "costs")!;
    expect(costs.requiredPermissions.map((p) => p.id)).toEqual(["Billing Read"]);
    expect(cloudflarePreflight.templateFormat?.language).toBe("text");
  });
});

describe("buildCloudflarePolicyTemplate", () => {
  it("builds the documented token-creator deep link with the selected scopes", () => {
    const tpl = buildCloudflarePolicyTemplate(["costs"]);
    expect(tpl.helpLink?.url).toContain("https://dash.cloudflare.com/profile/api-tokens?");
    const url = new URL(tpl.helpLink!.url);
    const keys = JSON.parse(url.searchParams.get("permissionGroupKeys")!) as Array<{
      key: string;
      type: string;
    }>;
    expect(keys).toEqual([{ key: "billing", type: "read" }]);
    expect(url.searchParams.get("accountId")).toBe("*");
    expect(url.searchParams.get("zoneId")).toBe("all");
  });

  it("lists human-readable permission groups in the document", () => {
    const tpl = buildCloudflarePolicyTemplate(["metrics", "costs"]);
    expect(tpl.document).toContain("Analytics · Read");
    expect(tpl.document).toContain("Account Analytics · Read");
    expect(tpl.document).toContain("Billing · Read");
    // resources scopes must not leak in
    expect(tpl.document).not.toContain("Workers Scripts");
  });
});

interface Route {
  status: number;
  body: unknown;
}

function stubFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, route] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(route.body), { status: route.status });
      }
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
}

const okEnvelope = (result: unknown) => ({ success: true, result, errors: [] });
const authFail = {
  success: false,
  result: null,
  errors: [{ code: 9109, message: "Unauthorized" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runCloudflarePreflight", () => {
  it("reports all capabilities ok for a fully-scoped active token", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/user/tokens/verify": { status: 200, body: okEnvelope({ id: "tok1", status: "active" }) },
        "/zones?per_page=1": { status: 200, body: okEnvelope([]) },
        "/accounts?per_page=1": { status: 200, body: okEnvelope([{ id: "acc1" }]) },
        "/graphql": { status: 200, body: { data: { viewer: { budget: 100 } } } },
        "/billable-usage/info": { status: 200, body: okEnvelope({ covered: true }) },
      }),
    );
    const result = await runCloudflarePreflight("t");
    expect(result.identity).toBe("API token tok1");
    expect(result.checks.map((c) => [c.capabilityId, c.status])).toEqual([
      ["resources", "ok"],
      ["metrics", "ok"],
      ["costs", "ok"],
    ]);
  });

  it("marks costs missing Billing Read when billable-usage is unauthorized", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/user/tokens/verify": { status: 200, body: okEnvelope({ id: "tok1", status: "active" }) },
        "/zones?per_page=1": { status: 200, body: okEnvelope([]) },
        "/accounts?per_page=1": { status: 200, body: okEnvelope([{ id: "acc1" }]) },
        "/graphql": { status: 200, body: { data: { viewer: { budget: 100 } } } },
        "/billable-usage/info": { status: 403, body: authFail },
      }),
    );
    const result = await runCloudflarePreflight("t");
    const costs = result.checks.find((c) => c.capabilityId === "costs")!;
    expect(costs.status).toBe("missing");
    expect(costs.status === "missing" && costs.missingPermissions.map((p) => p.id)).toEqual([
      "Billing Read",
    ]);
  });

  it("reports which resource scope is missing when zone listing is denied", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/user/tokens/verify": { status: 200, body: okEnvelope({ id: "tok1", status: "active" }) },
        "/zones?per_page=1": { status: 403, body: authFail },
        "/accounts?per_page=1": { status: 200, body: okEnvelope([{ id: "acc1" }]) },
        "/graphql": { status: 403, body: { data: null } },
        "/billable-usage/info": { status: 200, body: okEnvelope({ covered: true }) },
      }),
    );
    const result = await runCloudflarePreflight("t");
    const resources = result.checks.find((c) => c.capabilityId === "resources")!;
    expect(resources.status).toBe("missing");
    expect(resources.status === "missing" && resources.missingPermissions.map((p) => p.id)).toEqual(
      ["Zone Read"],
    );
    expect(result.checks.find((c) => c.capabilityId === "metrics")!.status).toBe("missing");
  });

  it("flags an expired token across every capability", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/user/tokens/verify": { status: 200, body: okEnvelope({ id: "tok1", status: "expired" }) },
      }),
    );
    const result = await runCloudflarePreflight("t");
    expect(result.checks).toHaveLength(3);
    for (const check of result.checks) {
      expect(check.status).toBe("missing");
      expect(check.status === "missing" && check.message).toContain("expired");
    }
  });

  it("marks resources unknown (not ok) when a probe fails without an auth error", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/user/tokens/verify": { status: 200, body: okEnvelope({ id: "tok1", status: "active" }) },
        "/zones?per_page=1": {
          status: 500,
          body: { success: false, result: null, errors: [{ code: 1, message: "server error" }] },
        },
        "/accounts?per_page=1": { status: 200, body: okEnvelope([{ id: "acc1" }]) },
        "/graphql": { status: 200, body: { data: { viewer: { budget: 100 } } } },
        "/billable-usage/info": { status: 200, body: okEnvelope({ covered: true }) },
      }),
    );
    const result = await runCloudflarePreflight("t");
    const resources = result.checks.find((c) => c.capabilityId === "resources")!;
    expect(resources.status).toBe("unknown");
    expect(resources.status === "unknown" && resources.message).toContain("server error");
  });

  it("prefers missing over unknown when one resource probe is denied and the other errors", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/user/tokens/verify": { status: 200, body: okEnvelope({ id: "tok1", status: "active" }) },
        "/zones?per_page=1": { status: 403, body: authFail },
        "/accounts?per_page=1": { status: 500, body: { success: false, errors: [] } },
        "/graphql": { status: 200, body: { data: { viewer: { budget: 100 } } } },
      }),
    );
    const result = await runCloudflarePreflight("t");
    const resources = result.checks.find((c) => c.capabilityId === "resources")!;
    expect(resources.status).toBe("missing");
    expect(resources.status === "missing" && resources.missingPermissions.map((p) => p.id)).toEqual(
      ["Zone Read"],
    );
  });

  it("marks metrics unknown on a non-auth GraphQL failure instead of missing", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/user/tokens/verify": { status: 200, body: okEnvelope({ id: "tok1", status: "active" }) },
        "/zones?per_page=1": { status: 200, body: okEnvelope([]) },
        "/accounts?per_page=1": { status: 200, body: okEnvelope([{ id: "acc1" }]) },
        "/graphql": {
          status: 200,
          body: { data: null, errors: [{ message: "internal server error" }] },
        },
        "/billable-usage/info": { status: 200, body: okEnvelope({ covered: true }) },
      }),
    );
    const result = await runCloudflarePreflight("t");
    const metrics = result.checks.find((c) => c.capabilityId === "metrics")!;
    expect(metrics.status).toBe("unknown");
    expect(metrics.status === "unknown" && metrics.message).toContain("internal server error");
  });

  it("marks metrics unknown on a partial GraphQL response (viewer AND errors)", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/user/tokens/verify": { status: 200, body: okEnvelope({ id: "tok1", status: "active" }) },
        "/zones?per_page=1": { status: 200, body: okEnvelope([]) },
        "/accounts?per_page=1": { status: 200, body: okEnvelope([{ id: "acc1" }]) },
        "/graphql": {
          status: 200,
          body: {
            data: { viewer: { budget: 100 } },
            errors: [{ message: "quota exceeded for analytics" }],
          },
        },
        "/billable-usage/info": { status: 200, body: okEnvelope({ covered: true }) },
      }),
    );
    const result = await runCloudflarePreflight("t");
    const metrics = result.checks.find((c) => c.capabilityId === "metrics")!;
    expect(metrics.status).toBe("unknown");
    expect(metrics.status === "unknown" && metrics.message).toContain("quota exceeded");
  });

  it("marks costs unknown when no account id could be resolved", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/user/tokens/verify": { status: 200, body: okEnvelope({ id: "tok1", status: "active" }) },
        "/zones?per_page=1": { status: 200, body: okEnvelope([]) },
        "/accounts?per_page=1": { status: 403, body: authFail },
        "/graphql": { status: 200, body: { data: { viewer: { budget: 100 } } } },
      }),
    );
    const result = await runCloudflarePreflight("t");
    expect(result.checks.find((c) => c.capabilityId === "costs")!.status).toBe("unknown");
    // and Account Settings Read shows up under resources
    const resources = result.checks.find((c) => c.capabilityId === "resources")!;
    expect(resources.status === "missing" && resources.missingPermissions.map((p) => p.id)).toEqual(
      ["Account Settings Read"],
    );
  });
});
