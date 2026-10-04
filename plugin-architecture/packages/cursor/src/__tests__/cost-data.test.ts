import { describe, expect, it } from "vitest";
import {
  eventCents,
  fetchCursorCostData,
  isUsageBased,
  parseSeatPricing,
  seatRows,
  usageRows,
} from "../cost-data.js";
import { makeHttp } from "./helpers.js";

const range = { fromDate: "2026-10-01", toDate: "2026-10-03" };

function ts(iso: string): string {
  return String(Date.parse(iso));
}

describe("isUsageBased / eventCents", () => {
  it("counts only chargeable usage-based events", () => {
    expect(isUsageBased({ kind: "Usage-based", isChargeable: true })).toBe(true);
    expect(isUsageBased({ kind: "USAGE_BASED" })).toBe(true);
    expect(isUsageBased({ kind: "On-Demand" })).toBe(true);
    expect(isUsageBased({ kind: "Included in Business" })).toBe(false);
    expect(isUsageBased({ kind: "Usage-based", isChargeable: false })).toBe(false);
    expect(isUsageBased({ kind: "Errored, Not Charged" })).toBe(false);
  });

  it("prefers chargedCents (with the token fee) over the raw token cost", () => {
    expect(eventCents({ chargedCents: 21.36, tokenUsage: { totalCents: 20.18 } })).toBe(21.36);
    expect(eventCents({ tokenUsage: { totalCents: 20.18 } })).toBe(20.18);
    expect(eventCents({})).toBe(0);
  });
});

describe("parseSeatPricing", () => {
  it("defaults to the published prices and parses premium emails", () => {
    const p = parseSeatPricing({ premiumSeatEmails: "A@x.com, b@x.com\nc@x.com" });
    expect(p.standardMonthly).toBe(40);
    expect(p.premiumMonthly).toBe(120);
    expect([...p.premiumEmails]).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("falls back on a junk price rather than charging NaN", () => {
    expect(parseSeatPricing({ seatPriceMonthly: "abc" }).standardMonthly).toBe(40);
    expect(parseSeatPricing({ seatPriceMonthly: "32" }).standardMonthly).toBe(32);
  });
});

describe("usageRows", () => {
  it("rolls events up by day, model and member and maps emails to member ids", () => {
    const rows = usageRows(
      [
        {
          timestamp: ts("2026-10-01T10:00:00Z"),
          userEmail: "Dev@Acme.com",
          model: "claude-4.5-sonnet",
          kind: "Usage-based",
          chargedCents: 100,
        },
        {
          timestamp: ts("2026-10-01T23:00:00Z"),
          userEmail: "dev@acme.com",
          model: "claude-4.5-sonnet",
          kind: "Usage-based",
          chargedCents: 50,
        },
        {
          timestamp: ts("2026-10-01T12:00:00Z"),
          userEmail: "dev@acme.com",
          model: "gpt-5",
          kind: "Included in Business",
          chargedCents: 999,
        },
        {
          timestamp: ts("2026-09-30T12:00:00Z"),
          userEmail: "dev@acme.com",
          model: "gpt-5",
          kind: "Usage-based",
          chargedCents: 5,
        },
      ],
      new Map([["dev@acme.com", "user_1"]]),
      range,
    );
    expect(rows).toEqual([
      {
        date: "2026-10-01",
        service: "claude-4.5-sonnet",
        resourceId: "user_1",
        tags: {
          user: "dev@acme.com",
          model: "claude-4.5-sonnet",
          maxMode: "false",
          charge: "usage-based",
        },
        currency: "USD",
        amount: 1.5,
        usageAmount: 2,
        usageUnit: "requests",
      },
    ]);
  });
});

describe("seatRows", () => {
  const pricing = parseSeatPricing({ premiumSeatEmails: "lead@acme.com" });
  const members = [
    { id: "user_1", email: "dev@acme.com", role: "member" },
    { id: "user_2", email: "lead@acme.com", role: "owner" },
    { id: "user_3", email: "it@acme.com", role: "free-owner" },
    { id: "user_4", email: "gone@acme.com", role: "member", isRemoved: true },
  ];

  it("charges paid seats only, from the cycle start, never into the future", () => {
    const rows = seatRows(
      members,
      pricing,
      range,
      Date.parse("2026-10-02T00:00:00Z"),
      "2026-10-02",
    );
    expect(rows.map((r) => [r.date, r.resourceId, r.service, r.amount])).toEqual([
      ["2026-10-02", "user_1", "Standard seat", 1.315068],
      ["2026-10-02", "user_2", "Premium seat", 3.945205],
    ]);
  });

  it("writes nothing without a cycle start", () => {
    expect(seatRows(members, pricing, range, undefined, "2026-10-03")).toEqual([]);
  });
});

describe("fetchCursorCostData", () => {
  it("reads members, spend and every usage-event page", async () => {
    const { http, calls } = makeHttp((url, _method, body) => {
      const b = body as Record<string, number> | undefined;
      switch (url.pathname) {
        case "/teams/members":
          return {
            body: { teamMembers: [{ id: "user_1", email: "dev@acme.com", role: "member" }] },
          };
        case "/teams/spend":
          return {
            body: {
              teamMemberSpend: [],
              subscriptionCycleStart: Date.parse("2026-10-03T00:00:00Z"),
              totalPages: 1,
            },
          };
        case "/teams/filtered-usage-events":
          return {
            body: {
              usageEvents: [
                {
                  timestamp: ts(`2026-10-0${b?.["page"]}T10:00:00Z`),
                  userEmail: "dev@acme.com",
                  model: "gpt-5",
                  kind: "Usage-based",
                  chargedCents: 10,
                },
              ],
              pagination: { hasNextPage: b?.["page"] === 1 },
            },
          };
        default:
          return { status: 404, body: {} };
      }
    });
    const rows = await fetchCursorCostData(
      { apiKey: "crsr_test", http },
      parseSeatPricing({}),
      range,
      Date.parse("2026-10-03T12:00:00Z"),
    );
    expect(calls[0]!.headers["Authorization"]).toBe(`Basic ${btoa("crsr_test:")}`);
    const eventCalls = calls.filter((c) => c.url.pathname === "/teams/filtered-usage-events");
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls[0]!.body).toMatchObject({
      startDate: Date.parse("2026-10-01T00:00:00Z"),
      pageSize: 1000,
    });
    expect(rows.map((r) => [r.date, r.service, r.amount])).toEqual([
      ["2026-10-01", "gpt-5", 0.1],
      ["2026-10-02", "gpt-5", 0.1],
      ["2026-10-03", "Standard seat", 1.315068],
    ]);
  });
});
