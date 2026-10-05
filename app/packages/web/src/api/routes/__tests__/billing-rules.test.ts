import { Hono } from "hono";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

/**
 * `POST /billing-rules/preview` with a `managedAccountId` is that customer's
 * invoice, previewed. `/invoices` and `/managed-accounts` are refused outright
 * to a caller with scoped cost access (`COST_SCOPE_DENY_RULES`), so the
 * customer form of the preview must be too, or it is a way around them. The
 * org-wide form stays open: its cost reads run inside the caller's scope.
 */

const mockPreview = vi.fn();
vi.mock("@infrawrench/server-core/cost/pricing-preview", () => ({
  previewPricing: (...a: unknown[]) => mockPreview(...a),
}));

class BillingRuleError extends Error {}
class BillingRuleNameConflictError extends Error {}
vi.mock("@infrawrench/server-core/cost/billing-rules", () => ({
  BillingRuleError,
  BillingRuleNameConflictError,
  createBillingRule: vi.fn(),
  deleteBillingRule: vi.fn(),
  getBillingRule: vi.fn(),
  listBillingRules: vi.fn(),
  reorderBillingRules: vi.fn(),
  updateBillingRule: vi.fn(),
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
// The real `requestIsCostScoped` runs; only the modules behind the middleware
// it sits beside (which open the database) are stubbed.
vi.mock("@infrawrench/server-core/cost/visibility", () => ({ resolveCostVisibility: vi.fn() }));
vi.mock("@/services/object-sharing", () => ({
  resolveSharingPrincipal: vi.fn(),
  runWithSharingPrincipal: (_p: unknown, fn: () => unknown) => fn(),
}));

const { billingRuleRoutes } = await import("../billing-rules");

/** The test app, with the caller's resolved cost visibility set the way the middleware sets it. */
function app(restricted: boolean, permissions: string[] = ["*"]) {
  const outer = new Hono();
  outer.use("*", async (c, next) => {
    c.set(
      "costVisibility",
      restricted
        ? { organizationId: "org-1", restricted: true, userId: "user-1", layers: [] }
        : { organizationId: "org-1", restricted: false },
    );
    return next();
  });
  outer.route("/", buildTestApp(billingRuleRoutes, permissions));
  return outer;
}

function preview(body: Record<string, unknown>) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  mockPreview.mockReset();
  mockPreview.mockResolvedValue({ month: "2026-09", lines: [] });
});

describe("POST /billing-rules/preview", () => {
  it("refuses a managed account's preview to a scoped caller with a coded 403", async () => {
    const res = await app(true).request("/preview", preview({ managedAccountId: "ma-1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cost_scope_restricted" });
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("still serves the org-wide preview to a scoped caller", async () => {
    const res = await app(true).request("/preview", preview({ month: "2026-09" }));
    expect(res.status).toBe(200);
    expect(mockPreview).toHaveBeenCalledWith("org-1", { month: "2026-09" });
  });

  it("serves a managed account's preview to an unrestricted caller", async () => {
    const res = await app(false).request("/preview", preview({ managedAccountId: "ma-1" }));
    expect(res.status).toBe(200);
    expect(mockPreview).toHaveBeenCalledWith("org-1", { managedAccountId: "ma-1" });
  });

  it("needs invoices:read for a managed account's preview", async () => {
    const res = await app(false, ["costs:read"]).request(
      "/preview",
      preview({ managedAccountId: "ma-1" }),
    );
    expect(res.status).toBe(403);
    expect(mockPreview).not.toHaveBeenCalled();
  });
});
