import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

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

const { billingRulesDomain } = await import("@/http/domains/billing-rules/index");

/** The test app, with the caller's resolved cost visibility as the middleware resolves it. */
function app(restricted: boolean, permissions: string[] = ["*"]) {
  return buildTestApi(billingRulesDomain, {
    basePath: "/api/org/org-1/billing-rules",
    permissions,
    principal: {
      costVisibility: restricted
        ? { organizationId: "org-1", restricted: true, userId: "user-1", layers: [] }
        : { organizationId: "org-1", restricted: false },
    },
  });
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
