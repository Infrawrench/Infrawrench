/**
 * The read side of anomaly contributors: folding what a cost-scoped viewer may
 * not see, and the lazy backfill for findings detected before the breakdown
 * existed (computed unrestricted, stored, never triggered by a scoped caller).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostAnomalyContributor } from "@infrawrench/client-core";

const visible = vi.fn<() => Set<string> | null>();
const runWithCostVisibility = vi.fn((_v: unknown, fn: () => unknown) => fn());
vi.mock("@infrawrench/server-core/cost/visibility-context", () => ({
  isCostScoped: () => visible() !== null,
  scopedViewerUserId: () => undefined,
  strictlyVisibleAccountIds: () => visible(),
  runWithCostVisibility: (v: unknown, fn: () => unknown) => runWithCostVisibility(v, fn),
  unrestrictedCostVisibility: (organizationId: string) => ({ organizationId, restricted: false }),
}));

const computeAnomalyContributors = vi.fn();
vi.mock("@infrawrench/server-core/cost/anomaly-contributors", () => ({
  computeAnomalyContributors: (...args: unknown[]) => computeAnomalyContributors(...args),
}));
vi.mock("@infrawrench/server-core/github-issues/filing", () => ({
  resolveFindingIssues: vi.fn(),
}));

const updates: Array<Record<string, unknown>> = [];
vi.mock("../../db/client", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  },
}));

const { toCostAnomaly, backfillAnomalyContributors } = await import("../cost-anomalies");

function contributor(partial: Partial<CostAnomalyContributor>): CostAnomalyContributor {
  return {
    facet: "resource",
    key: "i-1",
    tagKey: null,
    label: "i-1",
    accountId: "acc-a",
    resource: null,
    actualCents: 10_000,
    baselineCents: 0,
    deltaCents: 10_000,
    share: 0.5,
    ...partial,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "anom-1",
    organizationId: "org-1",
    day: "2026-10-14",
    kind: "spike",
    dimension: "service",
    dimensionKey: "Amazon EC2",
    currency: "USD",
    actualAmountCents: 20_000,
    baselineAmountCents: 1_000,
    thresholdAmountCents: 5_000,
    detectedAt: new Date("2026-10-15T00:00:00Z"),
    notifiedAt: null,
    hints: null,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    explanation: null,
    annotationId: null,
    feedbackVerdict: null,
    feedbackReason: null,
    feedbackNote: null,
    feedbackAt: null,
    feedbackByUserId: null,
    feedbackSuppressionId: null,
    suppressedById: null,
    contributors: null,
    contributorsComputedAt: null,
    ...overrides,
  } as unknown as Parameters<typeof toCostAnomaly>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  visible.mockReturnValue(null);
});

describe("toCostAnomaly contributors", () => {
  const stored = [
    contributor({ key: "i-mine", accountId: "acc-a", share: 0.6 }),
    contributor({ key: "i-theirs", accountId: "acc-b", share: 0.3 }),
    contributor({ facet: "region", key: "us-east-1", accountId: null, share: 0.9 }),
  ];

  it("answers the stored breakdown to an unrestricted caller", () => {
    expect(toCostAnomaly(row({ contributors: stored })).contributors).toEqual(stored);
  });

  it("reads a never-computed breakdown as empty", () => {
    expect(toCostAnomaly(row()).contributors).toEqual([]);
  });

  it("folds what a scoped caller cannot see into one other row per facet", () => {
    visible.mockReturnValue(new Set(["acc-a"]));
    const out = toCostAnomaly(row({ contributors: stored })).contributors ?? [];
    expect(out.map((c) => [c.facet, c.key, c.other ?? false])).toEqual([
      ["resource", "i-mine", false],
      ["resource", "", true],
      ["region", "", true],
    ]);
    expect(JSON.stringify(out)).not.toContain("i-theirs");
  });
});

describe("backfillAnomalyContributors", () => {
  it("computes missing breakdowns unrestricted and stores them on the row", async () => {
    const computed = [contributor({ key: "i-new" })];
    computeAnomalyContributors.mockResolvedValue(computed);
    const rows = [row(), row({ id: "anom-2", contributorsComputedAt: new Date() })];

    await backfillAnomalyContributors("org-1", rows);

    // Only the never-computed row, through an unrestricted visibility.
    expect(computeAnomalyContributors).toHaveBeenCalledTimes(1);
    expect(computeAnomalyContributors).toHaveBeenCalledWith("org-1", {
      day: "2026-10-14",
      dimension: "service",
      dimensionKey: "Amazon EC2",
      currency: "USD",
    });
    expect(runWithCostVisibility.mock.calls[0]![0]).toEqual({
      organizationId: "org-1",
      restricted: false,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]!["contributors"]).toEqual(computed);
    expect(rows[0]!.contributors).toEqual(computed);
  });

  it("does nothing for a cost-scoped caller", async () => {
    visible.mockReturnValue(new Set(["acc-a"]));
    await backfillAnomalyContributors("org-1", [row()]);
    expect(computeAnomalyContributors).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("stores nothing when the breakdown could not be computed, so a later read retries", async () => {
    computeAnomalyContributors.mockResolvedValue(null);
    const rows = [row()];
    await backfillAnomalyContributors("org-1", rows);
    expect(updates).toEqual([]);
    expect(rows[0]!.contributorsComputedAt).toBeNull();
  });

  it("bounds how many rows one read computes", async () => {
    computeAnomalyContributors.mockResolvedValue([]);
    await backfillAnomalyContributors(
      "org-1",
      Array.from({ length: 10 }, (_, i) => row({ id: `anom-${i}` })),
    );
    expect(computeAnomalyContributors).toHaveBeenCalledTimes(4);
  });
});
