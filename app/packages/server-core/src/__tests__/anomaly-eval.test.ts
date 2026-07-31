import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Anomaly evaluation tests that exercise the *pipeline*, not the maths.
 *
 * The pure detector's own suite can only feed it arrays it invents. This one
 * goes through `detectForDimension`, so the baselines under test are built the
 * way production builds them — `fillDailySeries` zero-filled to a dense 28
 * entries whether or not the org has 28 days of data. That distinction is
 * exactly what a `baseline.length` guard cannot see, and what let every key of
 * a brand-new org alert as a new spend source on day one.
 *
 * ClickHouse and Postgres are mocked at their module boundaries, matching
 * `budget-eval.test.ts`.
 */

const sendPushToOrg = vi.fn(async () => ({ attempted: 0, succeeded: 0 }));
vi.mock("../push/dispatch", () => ({ sendPushToOrg }));

const sendSlackToOrg = vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 }));
vi.mock("../slack", () => ({ sendSlackToOrg }));

const sendMsTeamsToOrg = vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 }));
vi.mock("../msteams", () => ({ sendMsTeamsToOrg }));

const queryCosts = vi.fn();
const getCostCoverage = vi.fn();
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts, getCostCoverage }));

vi.mock("../db/schema", () => ({
  costAnomalies: {
    id: "id",
    organizationId: "organization_id",
    day: "day",
    dimension: "dimension",
    dimensionKey: "dimension_key",
    currency: "currency",
    notifiedAt: "notified_at",
  },
}));

/** Every row `detectForDimension` upserted, in order. */
let inserted: Array<Record<string, unknown>> = [];

const db = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([{ n: 0 }]) }) }),
  insert: () => ({
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return {
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([{ id: `anom${inserted.length}`, notifiedAt: null }]),
        }),
      };
    },
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};
vi.mock("../db/client", () => ({ db }));

let anomalyEval: typeof import("../cost/anomaly-eval");
let addDays: typeof import("../cost/dates").addDays;

const OPTS = { sigmas: 3, minDeltaAbs: 10, minBaselineDays: 7, minNewSourceAbs: 25 };

/** Yesterday is 2026-07-14, so the evaluated days are 07-12 … 07-14. */
const NOW = new Date("2026-07-15T12:00:00Z");
const YESTERDAY = "2026-07-14";

/** Coverage as ClickHouse reports it: one row per account. */
function coverage(...firstDays: string[]) {
  return new Map(
    firstDays.map((firstDay, i) => [`acct${i}`, { firstDay, lastDay: YESTERDAY }] as const),
  );
}

/** A daily series over an inclusive day range, flat at `amount`. */
function flatPoints(from: string, to: string, amount: number) {
  const points: Array<{ bucket: string; amount: number }> = [];
  for (let day = from; day <= to; day = addDays(day, 1)) points.push({ bucket: day, amount });
  return points;
}

/**
 * Answer the provider query with `groups` and the service query with nothing,
 * so a finding count is unambiguous. Both dimensions run every pass.
 */
function providerCosts(groups: unknown[]) {
  queryCosts.mockImplementation(async (_org: string, q: { groupBy: string }) =>
    q.groupBy === "provider" ? groups : [],
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  inserted = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  queryCosts.mockResolvedValue([]);
  getCostCoverage.mockResolvedValue(new Map());
  anomalyEval = await import("../cost/anomaly-eval");
  ({ addDays } = await import("../cost/dates"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectCostAnomaliesForOrg — new-source guard against collection coverage", () => {
  it("stays silent for an org whose collection started two days ago", async () => {
    // The day-one storm: three providers, all material spend, none of which
    // has any history because the org has none. The baseline handed to the
    // detector is still a dense 28 zeros — length alone cannot tell.
    getCostCoverage.mockResolvedValue(coverage("2026-07-13"));
    providerCosts([
      { key: "aws", currency: "USD", points: flatPoints("2026-07-13", YESTERDAY, 4000) },
      { key: "gcp", currency: "USD", points: flatPoints("2026-07-13", YESTERDAY, 900) },
      { key: "cloudflare", currency: "USD", points: flatPoints("2026-07-13", YESTERDAY, 60) },
    ]);

    await anomalyEval.detectCostAnomaliesForOrg("org-young", NOW, OPTS, true);

    expect(inserted).toEqual([]);
    expect(sendPushToOrg).not.toHaveBeenCalled();
    expect(sendSlackToOrg).not.toHaveBeenCalled();
    expect(sendMsTeamsToOrg).not.toHaveBeenCalled();
  });

  it("stays silent on the very first day of collection", async () => {
    getCostCoverage.mockResolvedValue(coverage(YESTERDAY));
    providerCosts([
      { key: "aws", currency: "USD", points: [{ bucket: YESTERDAY, amount: 12_000 }] },
    ]);

    await anomalyEval.detectCostAnomaliesForOrg("org-day-one", NOW, OPTS, true);

    expect(inserted).toEqual([]);
    expect(sendPushToOrg).not.toHaveBeenCalled();
  });

  it("still flags a key that first appears inside an established org", async () => {
    // The feature itself: months of collection, and a provider that shows up
    // yesterday with real money. Per-key history is all zeros — only the
    // *org's* coverage may silence a finding.
    getCostCoverage.mockResolvedValue(coverage("2026-01-01"));
    providerCosts([{ key: "gcp", currency: "USD", points: [{ bucket: YESTERDAY, amount: 5000 }] }]);

    await anomalyEval.detectCostAnomaliesForOrg("org-established", NOW, OPTS, true);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      day: YESTERDAY,
      kind: "new_source",
      dimension: "provider",
      dimensionKey: "gcp",
      actualAmountCents: 500_000,
    });
    expect(sendPushToOrg).toHaveBeenCalledWith(
      "org-established",
      "anomalyAlerts",
      expect.objectContaining({
        title: "New spend source: gcp",
        data: expect.objectContaining({ kind: "new_source", dimensionKey: "gcp" }),
      }),
    );
  });

  it("fires at exactly minBaselineDays of coverage and not a day sooner", async () => {
    const group = {
      key: "gcp",
      currency: "USD",
      points: [{ bucket: YESTERDAY, amount: 5000 }],
    };

    // 2026-07-07 → 2026-07-14 is 7 whole days of coverage: the boundary.
    getCostCoverage.mockResolvedValue(coverage("2026-07-07"));
    providerCosts([group]);
    await anomalyEval.detectCostAnomaliesForOrg("org-at-boundary", NOW, OPTS, true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ kind: "new_source", day: YESTERDAY });

    inserted = [];

    // One day less, and the org is still too young to make the claim.
    getCostCoverage.mockResolvedValue(coverage("2026-07-08"));
    providerCosts([group]);
    await anomalyEval.detectCostAnomaliesForOrg("org-under-boundary", NOW, OPTS, true);
    expect(inserted).toEqual([]);
  });

  it("measures coverage from the org's earliest account, not its newest", async () => {
    // A long-established org that connected a second account yesterday must
    // not be silenced by that account's own short history.
    getCostCoverage.mockResolvedValue(coverage("2026-01-01", YESTERDAY));
    providerCosts([{ key: "gcp", currency: "USD", points: [{ bucket: YESTERDAY, amount: 5000 }] }]);

    await anomalyEval.detectCostAnomaliesForOrg("org-multi-account", NOW, OPTS, true);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ kind: "new_source" });
  });

  it("reads coverage once per pass, not once per dimension or key", async () => {
    getCostCoverage.mockResolvedValue(coverage("2026-01-01"));
    providerCosts([
      { key: "gcp", currency: "USD", points: [{ bucket: YESTERDAY, amount: 5000 }] },
      { key: "fly", currency: "USD", points: [{ bucket: YESTERDAY, amount: 6000 }] },
    ]);

    await anomalyEval.detectCostAnomaliesForOrg("org-one-read", NOW, OPTS, true);

    expect(getCostCoverage).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(2);
  });

  it("keeps detecting spikes when the coverage read fails, and never throws", async () => {
    getCostCoverage.mockRejectedValue(new Error("clickhouse down"));
    providerCosts([
      {
        key: "aws",
        currency: "USD",
        points: [
          ...flatPoints("2026-06-01", "2026-07-13", 100),
          { bucket: YESTERDAY, amount: 900 },
        ],
      },
    ]);

    await expect(
      anomalyEval.detectCostAnomaliesForOrg("org-coverage-fails", NOW, OPTS, true),
    ).resolves.toBeUndefined();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ kind: "spike", day: YESTERDAY });
  });

  it("does not let a young org's spike detection break either", async () => {
    // Spikes are guarded by observed spending days, which the young org has
    // too few of — so a young org is silent in both detectors.
    getCostCoverage.mockResolvedValue(coverage("2026-07-13"));
    providerCosts([
      {
        key: "aws",
        currency: "USD",
        points: [
          { bucket: "2026-07-13", amount: 100 },
          { bucket: YESTERDAY, amount: 9000 },
        ],
      },
    ]);

    await anomalyEval.detectCostAnomaliesForOrg("org-young-spike", NOW, OPTS, true);

    expect(inserted).toEqual([]);
  });
});
