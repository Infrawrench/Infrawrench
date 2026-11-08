/**
 * The 400 a request that fails its schema gets: the route's sentence and the
 * issues, as every Zod-validated route sent. Decoding fails as a typed error
 * inside the middleware stack, which an empty framework 400 would otherwise
 * answer.
 */
import { describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

vi.mock("@/services/budgets", () => ({
  BudgetValidationError: class extends Error {},
  createBudget: vi.fn(),
  getBudgetWithStatus: vi.fn(),
  listBudgetEvents: vi.fn(),
  listBudgetsWithStatus: vi.fn(),
  softDeleteBudget: vi.fn(),
  updateBudget: vi.fn(),
}));
vi.mock("@/services/budget-alert-notes", () => ({
  BudgetAlertNoteError: class extends Error {},
  noteBudgetAlertEvent: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const { budgetsDomain } = await import("@/http/domains/budgets/index");
const app = buildTestApi(budgetsDomain, { basePath: "/api/org/org-1/budgets" });

describe("schema failures", () => {
  it("answer a bad payload with the route's sentence and every issue", async () => {
    const res = await app.request("/", { method: "POST", body: JSON.stringify({ name: 5 }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: Array<{ path: unknown[] }> };
    expect(body.error).toBe("Invalid budget");
    const paths = body.issues.map((i) => i.path.join("."));
    expect(paths).toContain("name");
    expect(paths).toContain("thresholds");
  });

  it("answer a body that is not JSON with a 400 too", async () => {
    const res = await app.request("/", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });

  it("read a body sent as text/plain or a form type as JSON, as Hono did", async () => {
    for (const type of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded"]) {
      const res = await app.request("/", {
        method: "POST",
        headers: { "content-type": type },
        body: JSON.stringify({ name: 5 }),
      });
      // Decoded (and refused on its fields), not a 415.
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Invalid budget");
    }
  });

  it("render an API error class that reaches them undeclared with its own status", async () => {
    const { Effect, Schema } = await import("effect");
    const { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } =
      await import("effect/http-api");
    const { makeDomain, withApiDefaults } = await import("@/http/domain");
    const { OrgAuth } = await import("@/http/middleware-tags");
    const { requirePermission } = await import("@/http/principal");
    // No `error: Forbidden` on the endpoint, and the refusal arrives as a
    // defect (how a loosely typed path delivers it): it must still be a 403.
    const Group = HttpApiGroup.make("undeclared")
      .add(HttpApiEndpoint.get("gated", "/", { success: Schema.String }))
      .prefix("/api/org/:orgId/undeclared")
      .middleware(OrgAuth);
    class UndeclaredApi extends withApiDefaults(HttpApi.make("undeclared").add(Group)) {}
    const domain = makeDomain(
      "undeclared",
      UndeclaredApi,
      HttpApiBuilder.group(UndeclaredApi, "undeclared", (h) =>
        h.handle("gated", () =>
          Effect.gen(function* () {
            yield* Effect.orDie(requirePermission("costs:write"));
            return "ok";
          }),
        ),
      ),
    );
    const gated = buildTestApi(domain, {
      basePath: "/api/org/org-1/undeclared",
      permissions: ["costs:read"],
    });
    const res = await gated.request("/");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: costs:write" });
  });
});
