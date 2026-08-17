import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The calendar's job is projection, and the two things that can go wrong with a
 * projection are both here: a span that reaches past the window has to be drawn
 * to the edge rather than dropped or drawn wrong, and a source that throws has
 * to cost its own kind rather than the page.
 *
 * The database is faked rather than run. What matters in this module is the
 * mapping from rows to events and the way failures are contained; the SQL is
 * exercised for real by the route tests and by any query that returns nothing.
 */

const FROM = Date.parse("2026-08-01T00:00:00.000Z");
const TO = Date.parse("2026-09-01T00:00:00.000Z");
const NOW = Date.parse("2026-08-17T09:00:00.000Z");

/** Rows the fake `db` hands back, keyed by the first table a query selects from. */
const rows = new Map<string, unknown[]>();
/** Tables whose read should throw, standing in for a half-migrated source. */
const throwing = new Set<string>();

function tableName(table: unknown): string {
  // Drizzle hangs the SQL name off a symbol; the description is stable and is
  // the only identifier a fake can key on without importing every table.
  const symbol = Object.getOwnPropertySymbols(table as object).find((s) =>
    s.description?.includes("Name"),
  );
  return symbol ? String((table as Record<symbol, unknown>)[symbol]) : "";
}

/**
 * A chainable stand-in for a drizzle select builder. Every method returns the
 * builder, and awaiting it resolves the rows registered for the table the query
 * started from — which is all this module's reads need.
 */
function builder(name: string): unknown {
  const result: unknown[] = throwing.has(name) ? [] : (rows.get(name) ?? []);
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"]) {
    chain[method] = (arg: unknown) => (method === "from" ? builder(tableName(arg)) : chain);
  }
  chain["then"] = (resolve: (value: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    throwing.has(name)
      ? Promise.resolve().then(() => reject(new Error(`${name} is unavailable`)))
      : Promise.resolve().then(() => resolve(result));
  return chain;
}

vi.mock("../db/client", () => ({
  db: {
    select: () => builder(""),
  },
}));

vi.mock("../expiry/feed", () => ({
  listExpiring: vi.fn(async () => ({
    items: [],
    totalCount: 0,
    counts: { expired: 0, critical: 0, warning: 0, upcoming: 0, ok: 0 },
    leadDays: 60,
    generatedAt: new Date(NOW).toISOString(),
  })),
}));

const { listCalendarEvents } = await import("../calendar/feed");
const { listExpiring } = await import("../expiry/feed");

beforeEach(() => {
  rows.clear();
  throwing.clear();
  vi.mocked(listExpiring).mockResolvedValue({
    items: [],
    totalCount: 0,
    counts: { expired: 0, critical: 0, warning: 0, upcoming: 0, ok: 0 },
    leadDays: 60,
    generatedAt: new Date(NOW).toISOString(),
  });
});

function freeze(overrides: Record<string, unknown> = {}) {
  return {
    id: "freeze-1",
    organizationId: "org",
    name: "Quarter-end freeze",
    reason: null,
    startsAt: new Date("2026-08-10T00:00:00.000Z"),
    endsAt: new Date("2026-08-12T00:00:00.000Z"),
    active: true,
    createdByUserId: null,
    endedByUserId: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

async function run(kinds?: string[]) {
  return listCalendarEvents("org", {
    from: FROM,
    to: TO,
    now: NOW,
    ...(kinds ? { kinds: kinds as never } : {}),
  });
}

describe("listCalendarEvents", () => {
  it("returns an empty calendar when every source is empty", async () => {
    const feed = await run();
    expect(feed.events).toEqual([]);
    expect(feed.failedKinds).toEqual([]);
    // Every requested kind reports itself empty, so the filter chips can say
    // "nothing scheduled" rather than looking broken.
    expect(feed.emptyKinds).toHaveLength(6);
    expect(feed.from).toBe("2026-08-01T00:00:00.000Z");
    expect(feed.to).toBe("2026-09-01T00:00:00.000Z");
  });

  it("projects a freeze inside the window with its true dates", async () => {
    rows.set("change_freezes", [freeze()]);
    const feed = await run(["change-freeze"]);
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]).toMatchObject({
      id: "change-freeze:freeze-1",
      kind: "change-freeze",
      title: "Quarter-end freeze",
      startsAt: "2026-08-10T00:00:00.000Z",
      endsAt: "2026-08-12T00:00:00.000Z",
      openEnded: false,
      severity: "warning",
    });
  });

  it("clamps a freeze that began before the window and marks it open-ended", async () => {
    // Sending the true start would make every consumer clamp it themselves;
    // dropping it would lose a freeze that is in effect right now.
    rows.set("change_freezes", [
      freeze({ startsAt: new Date("2026-07-01T00:00:00.000Z"), endsAt: null }),
    ]);
    const feed = await run(["change-freeze"]);
    expect(feed.events[0]).toMatchObject({
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: null,
      openEnded: true,
    });
  });

  it("ends a freeze that was lifted early at the moment it was lifted", async () => {
    // Drawing the declared end would paint two days of frozen calendar that
    // never happened.
    rows.set("change_freezes", [
      freeze({
        active: false,
        endsAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: new Date("2026-08-11T09:30:00.000Z"),
      }),
    ]);
    const feed = await run(["change-freeze"]);
    expect(feed.events[0]).toMatchObject({
      endsAt: "2026-08-11T09:30:00.000Z",
      severity: "info",
    });
  });

  it("drops a freeze that closed before the window opened", async () => {
    rows.set("change_freezes", [
      freeze({
        startsAt: new Date("2026-06-01T00:00:00.000Z"),
        endsAt: new Date("2026-06-05T00:00:00.000Z"),
      }),
    ]);
    expect((await run(["change-freeze"])).events).toEqual([]);
  });

  it("expands a sleep schedule into the windows the resource is actually down", async () => {
    rows.set("resource_schedules", [
      {
        id: "sched-1",
        accountId: "acct-1",
        resourceId: "res-1",
        daysOfWeek: [1, 2, 3, 4, 5],
        stopTime: "19:00",
        startTime: "07:00",
        timezone: "UTC",
        displayName: "staging-db",
      },
    ]);
    const feed = await run(["sleep-schedule"]);
    expect(feed.events.length).toBeGreaterThan(10);
    expect(feed.events[0]).toMatchObject({
      kind: "sleep-schedule",
      title: "staging-db asleep",
      link: { target: "resource", accountId: "acct-1", resourceId: "res-1" },
    });
    // Keyed by occurrence, so a month of nightly shutdowns is a month of
    // events to a subscribed calendar rather than one that keeps moving.
    expect(new Set(feed.events.map((e) => e.id)).size).toBe(feed.events.length);
  });

  it("marks an unresolved incident critical and open-ended", async () => {
    rows.set("incidents", [
      {
        id: "inc-1",
        organizationId: "org",
        title: "Checkout latency",
        severity: "sev2",
        status: "open",
        summary: "p99 above 3s",
        startedAt: new Date("2026-08-14T02:00:00.000Z"),
        mitigatedAt: null,
        resolvedAt: null,
      },
    ]);
    const feed = await run(["incident"]);
    expect(feed.events[0]).toMatchObject({
      id: "incident:inc-1",
      title: "SEV2 · Checkout latency",
      endsAt: null,
      openEnded: true,
      severity: "critical",
    });
  });

  it("turns a deadline into an all-day point event", async () => {
    vi.mocked(listExpiring).mockResolvedValue({
      items: [
        {
          resourceId: "res-cert",
          pluginId: "aws",
          pluginName: "AWS",
          resourceTypeId: "acm-certificate",
          resourceTypeName: "ACM Certificate",
          accountId: "acct-1",
          accountName: "prod",
          displayName: "api.example.com",
          externalId: null,
          fieldKey: "notAfter",
          kind: "tls-cert",
          label: "Certificate expires",
          basis: "expiry",
          dueAt: "2026-08-20T00:00:00.000Z",
          daysRemaining: 3,
          severity: "critical",
        },
      ],
      totalCount: 1,
      counts: { expired: 0, critical: 1, warning: 0, upcoming: 0, ok: 0 },
      leadDays: 60,
      generatedAt: new Date(NOW).toISOString(),
    });
    const feed = await run(["expiry"]);
    expect(feed.events[0]).toMatchObject({
      kind: "expiry",
      allDay: true,
      endsAt: null,
      severity: "critical",
    });
  });

  it("skips a cron trigger whose expression no longer parses", async () => {
    // A stored expression can be invalid — it arrived through config as code,
    // or the parser moved. One bad row must not cost the calendar.
    rows.set("workflows", [
      { id: "wf-1", name: "Nightly", trigger: { kind: "cron", cron: "not a cron" } },
      { id: "wf-2", name: "Hourly sync", trigger: { kind: "cron", cron: "0 * * * *" } },
    ]);
    const feed = await run(["workflow-schedule"]);
    expect(feed.events.every((e) => e.title === "Hourly sync runs")).toBe(true);
    expect(feed.events.length).toBeGreaterThan(0);
  });

  it("ignores workflows that are not cron-triggered", async () => {
    rows.set("workflows", [{ id: "wf-3", name: "Manual", trigger: { kind: "manual" } }]);
    expect((await run(["workflow-schedule"])).events).toEqual([]);
  });

  it("names a failed source and keeps every other one", async () => {
    rows.set("change_freezes", [freeze()]);
    throwing.add("incidents");
    const feed = await run(["change-freeze", "incident"]);
    expect(feed.failedKinds).toEqual(["incident"]);
    // The freeze still made it: one source failing must not empty the page.
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]?.kind).toBe("change-freeze");
  });

  it("sorts events soonest first, longest span first", async () => {
    rows.set("change_freezes", [
      freeze({ id: "late", startsAt: new Date("2026-08-20T00:00:00.000Z"), endsAt: null }),
      freeze({
        id: "short",
        startsAt: new Date("2026-08-10T00:00:00.000Z"),
        endsAt: new Date("2026-08-11T00:00:00.000Z"),
      }),
      freeze({
        id: "long",
        startsAt: new Date("2026-08-10T00:00:00.000Z"),
        endsAt: new Date("2026-08-15T00:00:00.000Z"),
      }),
    ]);
    const feed = await run(["change-freeze"]);
    expect(feed.events.map((e) => e.id)).toEqual([
      "change-freeze:long",
      "change-freeze:short",
      "change-freeze:late",
    ]);
  });
});
