/**
 * The HttpApi half of the server, end to end through the real `api` app and
 * the real `OrgAuth` implementation, with only the auth chain's leaves mocked.
 *
 * What only this can show: the AsyncLocalStorage scopes the org tree
 * establishes reach promise code called from an Effect handler, for each
 * request separately even when requests interleave, and a request no domain
 * routes gets the API's 404, on the org tree only once the caller is known.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.hoisted(() => {
  process.env["WORKOS_API_KEY"] ??= "sk_test_http_server";
  process.env["WORKOS_CLIENT_ID"] ??= "client_http_server";
});

const seen: Array<{ org: string | undefined; sharingOrg: string | undefined }> = [];

vi.mock("@/http/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/http/auth")>();
  const { HttpFailure } = await import("@/http/errors");
  return {
    ...actual,
    authenticateOrgCaller: (input: { raw: Request; orgId: string | undefined }) =>
      input.raw.headers.get("authorization") === "Bearer good"
        ? Effect.succeed({
            session: { userId: `user-${input.orgId}`, email: "a@example.com" },
            organizationId: input.orgId ?? "",
            permissions: ["budgets:read"],
            role: null,
            elevations: [],
            apiKey: undefined,
            auditPrincipal: undefined,
            refreshedSession: undefined,
          })
        : Effect.fail(new HttpFailure(401, { error: "Unauthorized" })),
  };
});

vi.mock("@infrawrench/server-core/cost/visibility", () => ({
  resolveCostVisibility: vi.fn(async (organizationId: string) => ({
    organizationId,
    restricted: false,
  })),
}));

vi.mock("@/services/object-sharing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/object-sharing")>()),
  resolveSharingPrincipal: async (organizationId: string, userId: string) => ({
    organizationId,
    userId,
    roleId: null,
    override: false,
  }),
}));

vi.mock("@/services/budgets", async () => {
  const { currentCostVisibility } =
    await import("@infrawrench/server-core/cost/visibility-context");
  const { currentSharingPrincipal } = await import("@/services/sharing-context");
  return {
    BudgetValidationError: class extends Error {},
    createBudget: vi.fn(),
    getBudgetWithStatus: vi.fn(),
    listBudgetEvents: vi.fn(),
    softDeleteBudget: vi.fn(),
    updateBudget: vi.fn(),
    listBudgetsWithStatus: async (organizationId: string) => {
      // Yield first so the two concurrent requests interleave before reading.
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push({
        org: currentCostVisibility()?.organizationId,
        sharingOrg: currentSharingPrincipal()?.organizationId,
      });
      return [{ id: `budget-of-${organizationId}` }];
    },
  };
});

const { api } = await import("@/api/index");

const get = (path: string, token = "good") =>
  api.request(path, { headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  seen.length = 0;
});

describe("HttpApi through the api app", () => {
  it("serves a domain route, with the request's scopes visible to the service", async () => {
    const res = await get("/api/org/org-a/budgets");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "budget-of-org-a" }]);
    expect(seen).toEqual([{ org: "org-a", sharingOrg: "org-a" }]);
  });

  it("keeps each interleaved request inside its own scope", async () => {
    const orgs = ["org-a", "org-b", "org-c", "org-d", "org-e", "org-f"];
    const responses = await Promise.all(orgs.map((org) => get(`/api/org/${org}/budgets`)));
    expect(responses.map((r) => r.status)).toEqual(orgs.map(() => 200));
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(bodies).toEqual(orgs.map((org) => [{ id: `budget-of-${org}` }]));
    // Every service call saw a matching pair, and every org was seen once.
    expect(seen.every((s) => s.org === s.sharingOrg)).toBe(true);
    expect(seen.map((s) => s.org).sort()).toEqual(orgs);
  });

  it("answers the auth chain's refusal as it was", async () => {
    const res = await get("/api/org/org-a/budgets", "bad");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("gates on the endpoint's permission before reading the body", async () => {
    const res = await api.request("/api/org/org-a/budgets", {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: budgets:write" });
  });

  it("sends the baseline security headers", async () => {
    const res = await get("/api/org/org-a/budgets");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers a request no domain routes with the 404 it always sent", async () => {
    const res = await api.request("/api/no-such-route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("404 Not Found");
  });

  it("answers a member's unknown org-tree path with the 404, a stranger's with the 401", async () => {
    const member = await get("/api/org/org-a/no-such-route");
    expect(member.status).toBe(404);
    expect(await member.text()).toBe("404 Not Found");
    const stranger = await get("/api/org/org-a/no-such-route", "bad");
    expect(stranger.status).toBe(401);
    expect(await stranger.json()).toEqual({ error: "Unauthorized" });
  });

  it("refuses a scoped caller an org-wide surface before the 404", async () => {
    // `/cost-exports/no-such-route` is under a surface a cost-scoped caller
    // may not reach at all, routed or not.
    const { resolveCostVisibility } = await import("@infrawrench/server-core/cost/visibility");
    vi.mocked(resolveCostVisibility).mockResolvedValueOnce({
      organizationId: "org-a",
      restricted: true,
      userId: "user-org-a",
      layers: [],
    });
    const res = await get("/api/org/org-a/cost-exports/no-such-route");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cost_scope_restricted" });
  });
});
