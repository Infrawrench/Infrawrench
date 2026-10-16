import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts: vi.fn() }));
vi.mock("../alerts/route", () => ({ routeAlert: vi.fn(), alertReached: vi.fn() }));
vi.mock("../paging/providers", () => ({ listPagingProviders: vi.fn() }));
vi.mock("../alerts/email", () => ({ getAlertEmailOptions: vi.fn() }));

const { findReportAnomalies } = await import("../cost/report-anomaly-alerts");
const { canonicalDestination, destinationShapeError, foreignDestinationError } =
  await import("../alerts/destinations");

/** 28 baseline days at `base` (with a little noise), then `days` judged. */
function series(base: number, judged: Record<string, number>): Map<string, number> {
  const byDay = new Map<string, number>();
  const start = Date.parse("2026-09-01T00:00:00Z");
  for (let i = 0; i < 31; i++) {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    byDay.set(day, base + (i % 2 === 0 ? 1 : -1));
  }
  for (const [day, amount] of Object.entries(judged)) byDay.set(day, amount);
  return byDay;
}

describe("findReportAnomalies", () => {
  const days = ["2026-09-29", "2026-09-30", "2026-10-01"];

  it("flags a day whose scope total clears both the sigma bar and the floor", () => {
    const found = findReportAnomalies(
      new Map([["USD", series(100, { "2026-09-30": 400 })]]),
      days,
      { sigmas: 3, minDeltaCents: 1000 },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ day: "2026-09-30", currency: "USD", actual: 400 });
    expect(found[0]!.mean).toBeGreaterThan(95);
  });

  it("stays quiet below the alert's own floor, in the series' own units", () => {
    // +$30 is many sigmas over a flat series, but under a $50 floor.
    const found = findReportAnomalies(
      new Map([["USD", series(100, { "2026-09-30": 130 })]]),
      days,
      { sigmas: 3, minDeltaCents: 5000 },
    );
    expect(found).toEqual([]);
  });

  it("judges each currency on its own series, never summed together", () => {
    const found = findReportAnomalies(
      new Map([
        ["USD", series(100, {})],
        ["EUR", series(50, { "2026-10-01": 500 })],
      ]),
      days,
      { sigmas: 3, minDeltaCents: 1000 },
    );
    expect(found.map((f) => [f.currency, f.day])).toEqual([["EUR", "2026-10-01"]]);
  });

  it("does not judge a scope without a week of history", () => {
    const thin = new Map([
      ["2026-09-28", 10],
      ["2026-09-30", 900],
    ]);
    expect(
      findReportAnomalies(new Map([["USD", thin]]), days, { sigmas: 1, minDeltaCents: 100 }),
    ).toEqual([]);
  });
});

describe("alert destinations", () => {
  it("refuses a destination that would route nowhere", () => {
    expect(destinationShapeError({ kind: "slack", channelId: "" }, "destination")).toMatch(
      /needs a channelId/,
    );
    expect(destinationShapeError({ kind: "pigeon" } as never, "destination")).toMatch(
      /Unknown destination "pigeon"/,
    );
    expect(destinationShapeError({ kind: "push" }, "destination")).toBeNull();
  });

  it("lowercases extra addresses", () => {
    expect(canonicalDestination({ kind: "email-address", address: "Finance@Example.com" })).toEqual(
      {
        kind: "email-address",
        address: "finance@example.com",
      },
    );
  });

  it("refuses another org's channel, a former member, and an address outside the policy", () => {
    const owned = {
      channelIds: new Set(["c1"]),
      webhookIds: new Set<string>(),
      scheduleIds: new Set<string>(),
      memberIds: new Set(["u1"]),
      emailOptions: {
        members: [],
        emailAvailable: true,
        settings: { allowExternal: false, allowedDomains: [] },
        memberDomains: ["example.com"],
      },
      pagingById: new Map(),
    } as unknown as Parameters<typeof foreignDestinationError>[0];
    expect(foreignDestinationError(owned, [{ kind: "slack", channelId: "c1" }])).toBeNull();
    expect(foreignDestinationError(owned, [{ kind: "slack", channelId: "c2" }])).toMatch(
      /not connected/,
    );
    expect(foreignDestinationError(owned, [{ kind: "email-member", userId: "u2" }])).toMatch(
      /no longer a member/,
    );
    expect(
      foreignDestinationError(owned, [{ kind: "email-address", address: "x@elsewhere.test" }]),
    ).toMatch(/outside the domains/);
  });
});
