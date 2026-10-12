import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CursorClient } from "../client.js";
import { MAX_SEAT_WINDOW_DAYS, seatWindowDays } from "../seats.js";
import type { Reply } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const DAY = 86_400_000;

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterAll(() => {
  vi.useRealTimers();
});

const MEMBERS = [
  { id: "user_dev", name: "Dev", email: "Dev@Acme.com", role: "member", isRemoved: false },
  { id: "user_idle", name: "Idle", email: "idle@acme.com", role: "owner", isRemoved: false },
  { id: "user_it", name: "IT", email: "it@acme.com", role: "free-owner", isRemoved: false },
  { id: "user_gone", name: "Gone", email: "gone@acme.com", role: "member", isRemoved: true },
  { id: "user_new", name: "New", email: "new@acme.com", role: "member", isRemoved: false },
  { id: "user_fresh", name: "Fresh", email: "fresh@acme.com", role: "member", isRemoved: false },
  { id: "user_pro", name: "Pro", email: "pro@acme.com", role: "member", isRemoved: false },
];

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * One paginated row per member per day of membership, the way Cursor returns
 * them: `dev` and `pro` active 3 days ago, `idle` never active, `new` joined 5
 * days ago and never active, `fresh` has no rows yet.
 */
function usageRows(startMs: number, endMs: number) {
  const rows: Array<Record<string, unknown>> = [];
  for (let t = startMs; t <= endMs; t += DAY) {
    const day = isoDay(t);
    const age = Math.floor((NOW - t) / DAY);
    for (const email of ["dev@acme.com", "idle@acme.com", "pro@acme.com", "new@acme.com"]) {
      if (email === "new@acme.com" && age > 5) continue;
      const active = age === 3 && (email === "dev@acme.com" || email === "pro@acme.com");
      rows.push({ email, day, isActive: active, agentRequests: active ? 4 : 0 });
    }
  }
  return rows;
}

function client(
  opts: {
    enterprise?: boolean;
    credentials?: Record<string, string>;
    route?: (url: URL, method: string, body: unknown) => Reply | undefined;
  } = {},
) {
  const { http, calls } = makeHttp((url, method, body) => {
    const custom = opts.route?.(url, method, body);
    if (custom) return custom;
    switch (url.pathname) {
      case "/teams/members":
        return { body: { teamMembers: MEMBERS } };
      case "/teams/spend":
        return { body: { teamMemberSpend: [], totalPages: 1 } };
      case "/teams/daily-usage-data": {
        const { startDate, endDate } = body as { startDate: number; endDate: number };
        return {
          body: { data: usageRows(startDate, endDate), pagination: { hasNextPage: false } },
        };
      }
      default:
        if (url.pathname.startsWith("/analytics/")) {
          return opts.enterprise ? { body: { data: [] } } : { status: 403, body: {} };
        }
        return { status: 404, body: { error: "not found" } };
    }
  });
  const c = new CursorClient(
    { apiKey: "crsr_test", premiumSeatEmails: "pro@acme.com", ...opts.credentials },
    { http } as never,
  );
  c.setRetryDelayMs(0);
  return { c, calls };
}

describe("seatWindowDays", () => {
  it("reads at least one 30-day window and at most 90 days", () => {
    expect(seatWindowDays(7)).toBe(30);
    expect(seatWindowDays(45)).toBe(45);
    expect(seatWindowDays(365)).toBe(MAX_SEAT_WINDOW_DAYS);
  });
});

describe("fetchSeats", () => {
  it("maps paid members on a Teams plan with list prices and usage-window evidence", async () => {
    const { c } = client();
    const seats = await c.fetchSeats("acc", { lookbackDays: 30 });
    const byId = Object.fromEntries(seats.map((s) => [s.memberId, s]));

    // Unpaid admins and removed members hold no seat.
    expect(Object.keys(byId).sort()).toEqual([
      "user_dev",
      "user_fresh",
      "user_idle",
      "user_new",
      "user_pro",
    ]);
    expect(byId["user_dev"]).toEqual({
      memberId: "user_dev",
      name: "Dev",
      email: "dev@acme.com",
      product: "Cursor",
      category: "ai-coding",
      seatType: "Standard",
      price: {
        monthly: 40,
        currency: "USD",
        source: "list-price",
        note: "cursor.com/pricing, 2026-10 (Teams, billed monthly)",
      },
      activity: {
        basis: "usage-window",
        lastActiveAt: isoDay(NOW - 3 * DAY),
        windowDays: 30,
        source: "Cursor daily usage (editor, agent, Tab or Bugbot activity)",
      },
      assignedAt: null,
      removable: false,
      removalNote:
        "Cursor's API removes members on Enterprise plans only; remove them from the Members page of the team dashboard.",
      downgrade: null,
      resource: { resourceTypeId: "team-member", externalId: "user_dev" },
    });
    expect(byId["user_pro"]).toMatchObject({
      seatType: "Premium",
      price: { monthly: 120, source: "list-price" },
    });
    expect(byId["user_idle"]!.activity).toMatchObject({
      basis: "usage-window",
      lastActiveAt: null,
      windowDays: 30,
    });
    expect(byId["user_idle"]!.assignedAt).toBeNull();
    // The first row of membership is the join day.
    expect(byId["user_new"]!.assignedAt).toBe(isoDay(NOW - 5 * DAY));
    expect(byId["user_fresh"]!.activity).toEqual({
      basis: "none",
      lastActiveAt: null,
      source: "No daily usage reported for this member yet",
    });
  });

  it("uses configured prices, and no Teams figure for an unconfigured Enterprise tier", async () => {
    const { c } = client({ enterprise: true, credentials: { seatPriceMonthly: "32" } });
    const seats = await c.fetchSeats("acc", { lookbackDays: 30 });
    const byId = Object.fromEntries(seats.map((s) => [s.memberId, s]));
    expect(byId["user_dev"]!.price).toEqual({ monthly: 32, currency: "USD", source: "configured" });
    expect(byId["user_pro"]!.price).toBeNull();
    expect(byId["user_dev"]!.removable).toBe(true);
    // An owner stays removable while another admin (here the unpaid one) remains.
    expect(byId["user_idle"]!.removable).toBe(true);
  });

  it("keeps the last admin and the last paid member", async () => {
    const { c } = client({
      enterprise: true,
      route: (url) =>
        url.pathname === "/teams/members"
          ? {
              body: {
                teamMembers: [
                  { id: "user_a", email: "a@acme.com", role: "owner" },
                  { id: "user_b", email: "b@acme.com", role: "member" },
                ],
              },
            }
          : undefined,
    });
    const seats = await c.fetchSeats("acc", { lookbackDays: 30 });
    expect(seats.map((s) => [s.memberId, s.removable, s.removalNote])).toEqual([
      ["user_a", false, "This is the team's only admin, and Cursor keeps at least one."],
      [
        "user_b",
        true,
        "Removes the member from the team. A member who used credits this cycle keeps the seat billed until the cycle ends.",
      ],
    ]);
  });

  it("reads further back for a longer threshold, in 30-day windows, capped at 90 days", async () => {
    const { c, calls } = client();
    const seats = await c.fetchSeats("acc", { lookbackDays: 180 });
    const windows = calls.filter((r) => r.url.pathname === "/teams/daily-usage-data");
    expect(windows).toHaveLength(3);
    for (const w of windows) {
      const { startDate, endDate } = w.body as { startDate: number; endDate: number };
      expect(endDate - startDate).toBeLessThan(30 * DAY);
    }
    const earliest = Math.min(...windows.map((w) => (w.body as { startDate: number }).startDate));
    expect(earliest).toBe(NOW - 90 * DAY);
    expect(seats.find((s) => s.memberId === "user_idle")!.activity.windowDays).toBe(90);
  });

  it("fails the read when any page fails", async () => {
    const { c } = client({
      route: (url, _m, body) =>
        url.pathname === "/teams/daily-usage-data" &&
        (body as { startDate: number }).startDate < NOW - 40 * DAY
          ? { status: 500, body: { error: "boom" } }
          : undefined,
    });
    await expect(c.fetchSeats("acc", { lookbackDays: 60 })).rejects.toThrow(/500/);
  });
});

describe("removeSeat", () => {
  it("removes by user id and reports end-of-cycle billing when credits were used", async () => {
    const { c, calls } = client({
      enterprise: true,
      route: (url) =>
        url.pathname === "/teams/remove-member"
          ? { body: { success: true, userId: "user_idle", hasBillingCycleUsage: true } }
          : undefined,
    });
    const result = await c.removeSeat("acc", { memberId: "user_idle", email: "idle@acme.com" });
    expect(result.effective).toBe("end-of-cycle");
    const call = calls.find((r) => r.url.pathname === "/teams/remove-member")!;
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ userId: "user_idle" });
  });

  it("falls back to the email and is immediate without cycle usage", async () => {
    const { c, calls } = client({
      route: (url) =>
        url.pathname === "/teams/remove-member"
          ? { body: { success: true, hasBillingCycleUsage: false } }
          : undefined,
    });
    const result = await c.removeSeat("acc", { memberId: "x@acme.com", email: "x@acme.com" });
    expect(result).toEqual({ effective: "immediate", message: "Removed from the team." });
    expect(calls.find((r) => r.url.pathname === "/teams/remove-member")!.body).toEqual({
      email: "x@acme.com",
    });
  });

  it("explains a refusal", async () => {
    const { c } = client({
      route: (url) =>
        url.pathname === "/teams/remove-member" ? { status: 403, body: {} } : undefined,
    });
    await expect(c.removeSeat("acc", { memberId: "user_dev" })).rejects.toThrow(
      /needs an Enterprise plan/,
    );
  });
});
