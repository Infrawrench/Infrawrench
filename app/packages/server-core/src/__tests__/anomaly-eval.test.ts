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

const queryCosts = vi.fn();
const getCostCoverage = vi.fn();
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts, getCostCoverage }));

/** The batched anomaly SMS rides this; the rest of `anomaly-sms.ts` runs real. */
const sendOneShotPage = vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 }));
vi.mock("../twilio-pager", () => ({ sendOneShotPage }));

/**
 * Root-cause hints are mocked at the module boundary: their queries have
 * their own suite (`anomaly-hints.test.ts`), and the fake db below only
 * understands the evaluator's own query shapes. Default: no hints, which is
 * also what a real failure degrades to.
 */
const buildAnomalyHints = vi.fn(async (): Promise<string[]> => []);
vi.mock("../cost/anomaly-hints", () => ({ buildAnomalyHints }));

const ORG_COST_ANOMALY_SETTINGS = {
  organizationId: "organization_id",
  sigmas: "sigmas",
  minDeltaCents: "min_delta_cents",
  newSourceMinCents: "new_source_min_cents",
  smsAlerts: "sms_alerts",
  smsLastPagedAt: "sms_last_paged_at",
};

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
  orgCostAnomalySettings: ORG_COST_ANOMALY_SETTINGS,
}));

/** Every row `detectForDimension` upserted, in order. */
let inserted: Array<Record<string, unknown>> = [];

/**
 * The org's `org_cost_anomaly_settings` row, or `null` for an org that has
 * never opened the form (which reads as the shipped defaults — SMS off).
 */
let settingsRow: Record<string, unknown> | null = null;

/** How many anomaly rows were stamped with `notifiedAt` this pass. */
let stampedCount = 0;

/** Every `hints` array written onto an anomaly row this pass. */
let hintWrites: string[][] = [];

/** Whether the conditional UPDATE that claims the SMS window finds a row. */
let smsWindowFree = true;

/** Every UPDATE ... RETURNING the claim issued, so releases are visible. */
let smsClaimWrites: Array<Date | null> = [];

const db = {
  select: () => ({
    from: (table: unknown) => ({
      where: () =>
        Promise.resolve(
          table === ORG_COST_ANOMALY_SETTINGS ? (settingsRow ? [settingsRow] : []) : [{ n: 0 }],
        ),
    }),
  }),
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
  update: (table: unknown) => ({
    set: (patch: Record<string, unknown>) => {
      if (table === ORG_COST_ANOMALY_SETTINGS) {
        smsClaimWrites.push((patch["smsLastPagedAt"] as Date | null) ?? null);
        const claimed = smsWindowFree;
        // A claim is one conditional UPDATE: it either matches the row or it
        // doesn't. The release that follows a failed send is unconditional in
        // this fake — what matters to a caller is that it was attempted.
        return {
          where: () => ({
            returning: () => Promise.resolve(claimed ? [{ organizationId: "org" }] : []),
          }),
        };
      }
      if (patch["notifiedAt"] instanceof Date) stampedCount += 1;
      if (Array.isArray(patch["hints"])) hintWrites.push(patch["hints"] as string[]);
      return { where: () => Promise.resolve() };
    },
  }),
};
vi.mock("../db/client", () => ({ db }));

/**
 * All three transports sit behind `routeAlert` now, so that is the single seam
 * these tests mock. `alertReached` is the real predicate rather than a stub —
 * it decides whether a cooldown or claim is kept, and faking it would hide
 * exactly the bug it exists to prevent.
 */
// Defaults to a successful delivery: `routeAlert` never throws and always
// returns a result, so a mock that resolves `undefined` would fail tests in a
// way the real function cannot.
const routeAlert = vi.fn(async (..._args: unknown[]) => routed());
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: (r: { succeeded?: number; held?: number } | null | undefined) =>
    (r?.succeeded ?? 0) > 0 || (r?.held ?? 0) > 0,
}));

/** A delivery that reached one Slack channel and one phone. */
function routed(over: Record<string, unknown> = {}) {
  return {
    attempted: 2,
    succeeded: 2,
    byTransport: { push: 1, slack: 1, msTeams: 0 },
    attemptedByTransport: { push: 1, slack: 1, msTeams: 0 },
    held: 0,
    unrouted: false,
    matchedRuleIds: ["rule1"],
    // The tracked-Slack half of the result. Present by default because
    // `byTransport.slack` is 1 — a result claiming a Slack delivery with no
    // message to show for it is a shape the real function never returns.
    slackMessages: [{ installationId: "inst1", channelId: "C1", ts: "1722700000.000100" }],
    deliveryIds: [],
    ...over,
  };
}

/** A delivery that reached nobody — no rule matched, or every channel failed. */
function unroutedResult() {
  return routed({
    attempted: 0,
    succeeded: 0,
    byTransport: { push: 0, slack: 0, msTeams: 0 },
    attemptedByTransport: { push: 0, slack: 0, msTeams: 0 },
    matchedRuleIds: [],
    slackMessages: [],
    unrouted: true,
  });
}

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
  stampedCount = 0;
  hintWrites = [];
  buildAnomalyHints.mockResolvedValue([]);
  smsClaimWrites = [];
  smsWindowFree = true;
  settingsRow = null;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  queryCosts.mockResolvedValue([]);
  sendOneShotPage.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
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
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("stays silent on the very first day of collection", async () => {
    getCostCoverage.mockResolvedValue(coverage(YESTERDAY));
    providerCosts([
      { key: "aws", currency: "USD", points: [{ bucket: YESTERDAY, amount: 12_000 }] },
    ]);

    await anomalyEval.detectCostAnomaliesForOrg("org-day-one", NOW, OPTS, true);

    expect(inserted).toEqual([]);
    expect(routeAlert).not.toHaveBeenCalled();
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
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "anomalyAlerts" }),
      ...[],
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

/**
 * The Twilio leg. The whole point is that it is *not* per anomaly: one pass
 * that flags a provider plus every service under it must produce one text.
 *
 * `anomaly-sms.ts` runs for real here (including the cooldown claim, against
 * the fake db above); only `sendOneShotPage` is mocked, so what is asserted is
 * what Twilio would have been handed.
 */
describe("detectCostAnomaliesForOrg — batched SMS paging", () => {
  /** A settings row with the SMS opt-in set. Numbers are the shipped defaults. */
  function settings(smsAlerts: "off" | "new_source" | "all", smsLastPagedAt: Date | null = null) {
    settingsRow = {
      sigmas: 3,
      minDeltaCents: 1000,
      newSourceMinCents: 2500,
      smsAlerts,
      smsLastPagedAt,
    };
  }

  /** N brand-new spend sources in one pass — the fan-out this design fears. */
  function manyNewSources(count: number) {
    getCostCoverage.mockResolvedValue(coverage("2026-01-01"));
    providerCosts(
      Array.from({ length: count }, (_, i) => ({
        key: `service-${i}`,
        currency: "USD",
        points: [{ bucket: YESTERDAY, amount: 5000 + i }],
      })),
    );
  }

  it("sends exactly one SMS for a pass that flags many anomalies", async () => {
    settings("all");
    sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
    manyNewSources(12);

    await anomalyEval.detectCostAnomaliesForOrg("org-flood", NOW, OPTS, true);

    expect(inserted).toHaveLength(12);
    expect(sendOneShotPage).toHaveBeenCalledTimes(1);
  });

  it("names at most three and counts the rest", async () => {
    settings("all");
    sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
    manyNewSources(12);

    await anomalyEval.detectCostAnomaliesForOrg("org-overflow", NOW, OPTS, true);

    const [, body] = sendOneShotPage.mock.calls[0]! as unknown as [string, string];
    expect(body).toContain("12 flagged");
    expect(body).toContain("service-0");
    expect(body).toContain("service-2");
    expect(body).not.toContain("service-3");
    expect(body).toContain("and 9 more");
    expect(body.length).toBeLessThanOrEqual(320);
  });

  it("sends nothing at all by default", async () => {
    // No settings row: the org has never opened the form. That is the state
    // every org is in the day this shipped, including the ones that already
    // have Twilio configured for budget alerts.
    manyNewSources(3);

    await anomalyEval.detectCostAnomaliesForOrg("org-default", NOW, OPTS, true);

    expect(inserted).toHaveLength(3);
    expect(sendOneShotPage).not.toHaveBeenCalled();
    expect(smsClaimWrites).toEqual([]);
  });

  it("sends nothing when the toggle is off, and never claims the window", async () => {
    settings("off");
    manyNewSources(3);

    await anomalyEval.detectCostAnomaliesForOrg("org-off", NOW, OPTS, true);

    expect(sendOneShotPage).not.toHaveBeenCalled();
    expect(smsClaimWrites).toEqual([]);
  });

  it("texts only about new sources when that is what was asked for", async () => {
    settings("new_source");
    sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
    getCostCoverage.mockResolvedValue(coverage("2026-01-01"));
    providerCosts([
      // A spike on an established line…
      {
        key: "aws",
        currency: "USD",
        points: [
          ...flatPoints("2026-06-01", "2026-07-13", 100),
          { bucket: YESTERDAY, amount: 900 },
        ],
      },
      // …and something that appeared from nothing.
      { key: "gcp", currency: "USD", points: [{ bucket: YESTERDAY, amount: 5000 }] },
    ]);

    await anomalyEval.detectCostAnomaliesForOrg("org-new-only", NOW, OPTS, true);

    expect(inserted).toHaveLength(2);
    const [, body] = sendOneShotPage.mock.calls[0]! as unknown as [string, string];
    expect(body).toContain("gcp");
    expect(body).not.toContain("aws");
    expect(body).toContain("1 flagged");
  });

  it("stays quiet for a spike-only pass when only new sources page", async () => {
    settings("new_source");
    getCostCoverage.mockResolvedValue(coverage("2026-01-01"));
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

    await anomalyEval.detectCostAnomaliesForOrg("org-spike-only", NOW, OPTS, true);

    expect(inserted).toHaveLength(1);
    expect(sendOneShotPage).not.toHaveBeenCalled();
  });

  it("skips the text while the org's six-hour window is still spent", async () => {
    settings("all", new Date(NOW.getTime() - 60 * 60 * 1000));
    smsWindowFree = false;
    manyNewSources(4);

    await anomalyEval.detectCostAnomaliesForOrg("org-cooling", NOW, OPTS, true);

    // The anomalies are still stored and still fanned out elsewhere.
    expect(inserted).toHaveLength(4);
    expect(sendOneShotPage).not.toHaveBeenCalled();
  });

  it("hands the window back when the text reached nobody", async () => {
    settings("all", null);
    sendOneShotPage.mockResolvedValue({ attempted: 2, succeeded: 0, failed: 2 });
    manyNewSources(2);

    await anomalyEval.detectCostAnomaliesForOrg("org-undelivered", NOW, OPTS, true);

    // Claimed with `now`, then restored to the prior value — an outage must not
    // buy six hours of silence.
    expect(smsClaimWrites).toEqual([NOW, null]);
  });

  it("stamps notifiedAt for an org whose only transport is SMS", async () => {
    // push/Slack/Teams all report zero deliveries (nobody opted in), so the
    // loop stamps nothing. The text is what reached a human, so it stamps.
    settings("all");
    sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
    manyNewSources(3);

    await anomalyEval.detectCostAnomaliesForOrg("org-sms-only", NOW, OPTS, true);

    expect(stampedCount).toBe(3);
  });

  it("does not double-stamp what push already delivered", async () => {
    settings("all");
    routeAlert.mockResolvedValue(routed());
    sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
    manyNewSources(3);

    await anomalyEval.detectCostAnomaliesForOrg("org-both", NOW, OPTS, true);

    expect(stampedCount).toBe(3);
  });

  it("keeps the SMS free of hints — its length budget is spent on the anomalies", async () => {
    settings("all");
    buildAnomalyHints.mockResolvedValue(["47 gce-instance resources appeared"]);
    sendOneShotPage.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
    manyNewSources(2);

    await anomalyEval.detectCostAnomaliesForOrg("org-sms-no-hints", NOW, OPTS, true);

    const [, body] = sendOneShotPage.mock.calls[0]! as unknown as [string, string];
    expect(body).not.toContain("gce-instance");
  });

  it("cannot break the pass, or the stamping, when Twilio throws", async () => {
    settings("all");
    routeAlert.mockResolvedValue(routed());
    sendOneShotPage.mockRejectedValue(new Error("twilio down"));
    manyNewSources(3);

    await expect(
      anomalyEval.detectCostAnomaliesForOrg("org-twilio-throws", NOW, OPTS, true),
    ).resolves.toBeUndefined();

    expect(inserted).toHaveLength(3);
    expect(stampedCount).toBe(3);
  });
});

/**
 * The hints leg. `buildAnomalyHints` itself is tested in
 * `anomaly-hints.test.ts`; what matters here is what the evaluator does with
 * its answer — store it, put it in the right transports' bodies, and survive
 * it failing.
 */
describe("detectCostAnomaliesForOrg — root-cause hints", () => {
  const HINTS = ["12 gce-instance resources appeared", 'Astrid ran workflow "Nightly rebuild"'];

  /** One new spend source inside an established org — one pending anomaly. */
  function oneNewSource() {
    getCostCoverage.mockResolvedValue(coverage("2026-01-01"));
    providerCosts([{ key: "gcp", currency: "USD", points: [{ bucket: YESTERDAY, amount: 5000 }] }]);
  }

  it("stores the hints on the anomaly row and asks with the anomaly's own scope", async () => {
    buildAnomalyHints.mockResolvedValue(HINTS);
    oneNewSource();

    await anomalyEval.detectCostAnomaliesForOrg("org-hints-stored", NOW, OPTS, true);

    expect(buildAnomalyHints).toHaveBeenCalledWith("org-hints-stored", {
      day: YESTERDAY,
      dimension: "provider",
      dimensionKey: "gcp",
    });
    expect(hintWrites).toEqual([HINTS]);
  });

  it("appends every hint to the Slack and Teams bodies", async () => {
    buildAnomalyHints.mockResolvedValue(HINTS);
    oneNewSource();

    await anomalyEval.detectCostAnomaliesForOrg("org-hints-body", NOW, OPTS, true);

    // Slack and Teams share `body`; only push gets the shortened `pushBody`.
    const [event] = routeAlert.mock.calls[0]! as unknown as [{ body: string; teamsBody?: string }];
    for (const body of [event.body, event.teamsBody ?? event.body]) {
      expect(body).toContain("Around then:");
      expect(body).toContain(HINTS[0]);
      expect(body).toContain(HINTS[1]);
    }
  });

  it("gives the push notification only the top hint", async () => {
    buildAnomalyHints.mockResolvedValue(HINTS);
    oneNewSource();

    await anomalyEval.detectCostAnomaliesForOrg("org-hints-push", NOW, OPTS, true);

    const [event] = routeAlert.mock.calls[0]! as unknown as [{ pushBody: string }];
    expect(event.pushBody).toContain(HINTS[0]);
    expect(event.pushBody).not.toContain(HINTS[1]);
  });

  it("leaves the bodies un-annotated when nothing notable happened", async () => {
    buildAnomalyHints.mockResolvedValue([]);
    oneNewSource();

    await anomalyEval.detectCostAnomaliesForOrg("org-hints-none", NOW, OPTS, true);

    expect(hintWrites).toEqual([]);
    const [event] = routeAlert.mock.calls[0]! as unknown as [{ body: string }];
    expect(event.body).not.toContain("Around then:");
  });

  it("still delivers the alert when the hint build rejects", async () => {
    // The module contract is "never throws", but the evaluator guards anyway:
    // hints must never cost a delivery.
    buildAnomalyHints.mockRejectedValue(new Error("hint query exploded"));
    routeAlert.mockResolvedValue(routed());
    oneNewSource();

    await expect(
      anomalyEval.detectCostAnomaliesForOrg("org-hints-fail", NOW, OPTS, true),
    ).resolves.toBeUndefined();

    expect(routeAlert).toHaveBeenCalledTimes(1);
    expect(stampedCount).toBe(1);
  });
});
