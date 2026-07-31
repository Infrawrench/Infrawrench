import { describe, expect, it } from "vitest";
import {
  composeWeeklyDigest,
  digestLines,
  digestTitle,
  digestWindow,
  formatDigestSlackBody,
  isDigestDue,
  type DigestCostGroup,
  type DigestInput,
} from "../digest/compose";

/**
 * The composer is deliberately pure — these tests pin down the window math
 * (Mondays, UTC), the week-over-week arithmetic (totals, deltas, movers,
 * currency separation), and the formatting both transports share.
 */

const WINDOW = {
  weekStart: "2026-07-20",
  weekEnd: "2026-07-26",
  prevWeekStart: "2026-07-13",
  prevWeekEnd: "2026-07-19",
};

/** A group with one point per week, in the middle of each week. */
function group(
  key: string,
  currency: string,
  prevAmount: number,
  currentAmount: number,
): DigestCostGroup {
  return {
    key,
    currency,
    points: [
      { bucket: "2026-07-15", amount: prevAmount },
      { bucket: "2026-07-22", amount: currentAmount },
    ],
  };
}

function input(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    window: WINDOW,
    byProvider: [],
    byService: [],
    syncIncidentsOpened: 0,
    resourcesAdded: 0,
    resourcesRemoved: 0,
    ...overrides,
  };
}

describe("digestWindow", () => {
  it("on a Monday reports the week that just ended", () => {
    // 2026-07-27 is a Monday.
    const w = digestWindow(new Date("2026-07-27T08:00:00Z"));
    expect(w).toEqual(WINDOW);
  });

  it("mid-week still reports the last complete week", () => {
    // Thursday of the following week.
    const w = digestWindow(new Date("2026-07-30T15:30:00Z"));
    expect(w).toEqual(WINDOW);
  });

  it("on a Sunday the current week is not complete yet", () => {
    const w = digestWindow(new Date("2026-07-26T23:00:00Z"));
    expect(w.weekStart).toBe("2026-07-13");
    expect(w.weekEnd).toBe("2026-07-19");
  });
});

describe("isDigestDue", () => {
  it("is not due before Monday 07:00 UTC", () => {
    expect(isDigestDue(new Date("2026-07-27T06:59:59Z"), WINDOW)).toBe(false);
  });

  it("is due from Monday 07:00 UTC", () => {
    expect(isDigestDue(new Date("2026-07-27T07:00:00Z"), WINDOW)).toBe(true);
  });

  it("stays due later in the week (catch-up after downtime)", () => {
    expect(isDigestDue(new Date("2026-07-29T02:00:00Z"), WINDOW)).toBe(true);
  });
});

describe("composeWeeklyDigest", () => {
  it("totals per currency with delta and percentage", () => {
    const digest = composeWeeklyDigest(
      input({ byProvider: [group("aws", "USD", 100, 150), group("gcp", "USD", 50, 25)] }),
    );
    expect(digest.totals).toEqual([
      {
        currency: "USD",
        currentAmount: 175,
        previousAmount: 150,
        delta: 25,
        deltaPct: expect.closeTo(16.666, 2),
      },
    ]);
  });

  it("reports a null percentage when last week was zero", () => {
    const digest = composeWeeklyDigest(input({ byProvider: [group("aws", "USD", 0, 40)] }));
    expect(digest.totals[0]?.deltaPct).toBeNull();
  });

  it("keeps currencies separate and sorts by current spend", () => {
    const digest = composeWeeklyDigest(
      input({ byProvider: [group("hetzner", "EUR", 10, 20), group("aws", "USD", 100, 90)] }),
    );
    expect(digest.totals.map((t) => t.currency)).toEqual(["USD", "EUR"]);
  });

  it("ranks movers by absolute delta in the primary currency only", () => {
    const digest = composeWeeklyDigest(
      input({
        byProvider: [
          group("aws", "USD", 100, 160), // +60
          group("gcp", "USD", 100, 20), // -80
          group("fly", "USD", 10, 15), // +5
          group("vercel", "USD", 30, 31), // +1
          group("hetzner", "EUR", 0, 90), // non-primary currency, excluded
        ],
      }),
    );
    expect(digest.topProviderMovers.map((m) => m.key)).toEqual(["gcp", "aws", "fly"]);
    expect(digest.topProviderMovers[0]?.delta).toBe(-80);
  });

  it("ignores flat groups and empty keys", () => {
    const digest = composeWeeklyDigest(
      input({ byProvider: [group("aws", "USD", 50, 50), group("", "USD", 10, 90)] }),
    );
    expect(digest.topProviderMovers).toEqual([]);
  });

  it("only counts points inside each week", () => {
    const digest = composeWeeklyDigest(
      input({
        byProvider: [
          {
            key: "aws",
            currency: "USD",
            points: [
              { bucket: "2026-07-12", amount: 999 }, // before prev week
              { bucket: "2026-07-13", amount: 10 }, // prev week (first day)
              { bucket: "2026-07-26", amount: 30 }, // current week (last day)
              { bucket: "2026-07-27", amount: 999 }, // after window
            ],
          },
        ],
      }),
    );
    expect(digest.totals[0]).toMatchObject({ currentAmount: 30, previousAmount: 10 });
  });
});

describe("formatting", () => {
  it("titles with the reported week's range", () => {
    const digest = composeWeeklyDigest(input());
    expect(digestTitle(digest)).toBe("Weekly digest · Jul 20 – Jul 26");
  });

  it("renders spend, movers, incidents and resource churn", () => {
    const digest = composeWeeklyDigest(
      input({
        byProvider: [group("aws", "USD", 100, 150)],
        byService: [group("AmazonEC2", "USD", 60, 110)],
        syncIncidentsOpened: 2,
        resourcesAdded: 5,
        resourcesRemoved: 1,
      }),
    );
    const body = formatDigestSlackBody(digest);
    expect(body).toContain("*Spend: $150.00*");
    expect(body).toContain("+$50.00 (+50.0%) vs $100.00 the week before");
    expect(body).toContain("*Top movers by provider*");
    expect(body).toContain("• aws: $150.00 (+$50.00 vs last week)");
    expect(body).toContain("• AmazonEC2: $110.00 (+$50.00 vs last week)");
    expect(body).toContain("2 sync incidents opened");
    expect(body).toContain("5 added, 1 removed");
  });

  it("explains an empty cost week instead of printing zeros", () => {
    const lines = digestLines(composeWeeklyDigest(input()), (s) => s);
    expect(lines[0]).toContain("No cost data was recorded for last week");
  });

  it("labels currencies when an org spends in more than one", () => {
    const digest = composeWeeklyDigest(
      input({ byProvider: [group("aws", "USD", 1, 2), group("hetzner", "EUR", 1, 2)] }),
    );
    const body = formatDigestSlackBody(digest);
    expect(body).toContain("Spend (USD)");
    expect(body).toContain("Spend (EUR)");
  });
});
