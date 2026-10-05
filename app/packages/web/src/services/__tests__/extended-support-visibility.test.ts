import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtendedSupportFinding } from "@infrawrench/client-core";

const listExtendedSupport = vi.fn();
const visible = vi.fn<() => Set<string> | null>();

vi.mock("@infrawrench/server-core/extended-support/feed", () => ({
  listExtendedSupport: (...args: unknown[]) => listExtendedSupport(...args),
}));
vi.mock("@infrawrench/server-core/cost/visibility-context", () => ({
  isCostScoped: () => visible() !== null,
  scopedViewerUserId: () => undefined,
  strictlyVisibleAccountIds: () => visible(),
}));
vi.mock("../plugin-clients", () => ({ getClientForAccount: vi.fn() }));

const { summarizeExtendedSupport } = await import("@infrawrench/client-core");
const { listExtendedSupportWithBilling } = await import("../extended-support");

function finding(accountId: string, monthly: number): ExtendedSupportFinding {
  // Upcoming and uncharged: no billing read, so the list is the scan as-is.
  return {
    resourceId: `r-${accountId}`,
    accountId,
    accountName: accountId,
    status: "upcoming",
    charged: false,
    currency: "USD",
    monthlySurcharge: monthly,
  } as unknown as ExtendedSupportFinding;
}

describe("listExtendedSupportWithBilling visibility", () => {
  beforeEach(() => {
    listExtendedSupport.mockReset();
  });

  it("returns the whole org's findings to an unrestricted caller", async () => {
    visible.mockReturnValue(null);
    listExtendedSupport.mockResolvedValue(
      summarizeExtendedSupport([finding("a1", 10), finding("a2", 20)], {
        leadDays: 90,
        generatedAt: "2026-10-05T00:00:00Z",
      }),
    );
    const res = await listExtendedSupportWithBilling("org-open");
    expect(res.findings.map((f) => f.accountId).sort()).toEqual(["a1", "a2"]);
  });

  it("narrows findings and their counts to a scoped caller's accounts", async () => {
    visible.mockReturnValue(new Set(["a2"]));
    listExtendedSupport.mockResolvedValue(
      summarizeExtendedSupport([finding("a1", 10), finding("a2", 20)], {
        leadDays: 90,
        generatedAt: "2026-10-05T00:00:00Z",
      }),
    );
    const res = await listExtendedSupportWithBilling("org-scoped");
    expect(res.findings.map((f) => f.accountId)).toEqual(["a2"]);
    expect(res.totalCount).toBe(1);
    expect(res.counts.upcoming).toBe(1);
    expect(res.leadDays).toBe(90);
  });
});
