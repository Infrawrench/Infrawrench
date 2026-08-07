import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How much work one digest tick is allowed to take on.
 *
 * The digest runs inside the poller's 15s tick, behind account polling and in
 * front of cost collection and retention. One org costs two ClickHouse queries,
 * an optional Anthropic call bounded at 30s, and a fan-out to Slack, Teams and
 * one request per email address — so the interesting case is the one every
 * deployment hits: every org on the default Monday 07:00 UTC schedule comes due
 * in the *same* tick. Processed one after another that is a stall measured in
 * minutes, with account syncs and workflow scheduling queued behind it.
 *
 * So the pass is bounded, and these tests pin the two properties that make
 * bounding safe rather than merely fast:
 *
 *   - a tick claims at most `DIGESTS_PER_TICK` orgs per phase, and runs them
 *     concurrently rather than one at a time;
 *   - an org deferred to a later tick is *deferred*, not starved — later ticks
 *     pick up the orgs the earlier ones left, and no org is ever sent twice.
 *
 * The DB is an in-memory fake over an array of settings rows, with predicate
 * objects from a mocked `drizzle-orm` evaluated against them, so the WHERE
 * clauses the claims depend on are exercised rather than stubbed away.
 */

// --- Mocked schema: plain column-name strings the fake predicates index by ---

const orgDigestSettings = {
  organizationId: "organizationId",
  enabled: "enabled",
  lastSentWeekStart: "lastSentWeekStart",
  lastSentAt: "lastSentAt",
  timezone: "timezone",
  sendDay: "sendDay",
  sendHour: "sendHour",
  narrativeEnabled: "narrativeEnabled",
  attemptCount: "attemptCount",
  lastAttemptAt: "lastAttemptAt",
  lastStatus: "lastStatus",
  lastError: "lastError",
  nextAttemptAt: "nextAttemptAt",
  updatedAt: "updatedAt",
} as const;

const organizations = { __t: "organizations", id: "id", displayName: "displayName" };
const digestEmailRecipients = { __t: "recipients", organizationId: "organizationId" };
const pagingIncidents = { __t: "pagingIncidents", organizationId: "organizationId" };
const resources = { __t: "resources", organizationId: "organizationId" };
const providerStatusIncidents = {
  __t: "providerStatusIncidents",
  pluginId: "pluginId",
  startedAt: "startedAt",
  resolvedAt: "resolvedAt",
};

vi.mock("../db/schema", () => ({
  orgDigestSettings,
  organizations,
  digestEmailRecipients,
  pagingIncidents,
  resources,
  providerStatusIncidents,
}));

// --- Mocked drizzle: predicates become functions over a fake row ---

type Row = Record<string, unknown>;
type Pred = (row: Row) => boolean;

const asPred = (p: unknown): Pred => (typeof p === "function" ? (p as Pred) : () => true);

const cmp = (a: unknown, b: unknown): number => {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if ((av as number) < (bv as number)) return -1;
  if ((av as number) > (bv as number)) return 1;
  return 0;
};

vi.mock("drizzle-orm", () => ({
  and:
    (...ps: unknown[]): Pred =>
    (row) =>
      ps.every((p) => asPred(p)(row)),
  or:
    (...ps: unknown[]): Pred =>
    (row) =>
      ps.some((p) => asPred(p)(row)),
  eq:
    (col: string, v: unknown): Pred =>
    (row) =>
      row[col] === v,
  lt:
    (col: string, v: unknown): Pred =>
    (row) =>
      row[col] != null && cmp(row[col], v) < 0,
  lte:
    (col: string, v: unknown): Pred =>
    (row) =>
      row[col] != null && cmp(row[col], v) <= 0,
  gte:
    (col: string, v: unknown): Pred =>
    (row) =>
      row[col] != null && cmp(row[col], v) >= 0,
  isNull:
    (col: string): Pred =>
    (row) =>
      row[col] == null,
  isNotNull:
    (col: string): Pred =>
    (row) =>
      row[col] != null,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __sql: strings.join("?"),
    values,
  }),
}));

// --- Fake DB over an array of settings rows ---

let settingsRows: Row[] = [];

function applySet(row: Row, values: Row): void {
  for (const [k, v] of Object.entries(values)) {
    if (v && typeof v === "object" && "__sql" in (v as Row)) {
      // The only sql-valued assignment on this path is `attempt_count + 1`.
      row[k] = ((row[k] as number) ?? 0) + 1;
    } else {
      row[k] = v;
    }
  }
}

vi.mock("../db/client", () => {
  const chain = (rows: Row[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ["innerJoin", "leftJoin"]) self[m] = () => self;
    self["where"] = (w: unknown) => chain(rows.filter(asPred(w)));
    self["orderBy"] = (col: unknown) =>
      chain(typeof col === "string" ? [...rows].sort((a, b) => cmp(a[col], b[col])) : rows);
    // A real LIMIT, so the SQL-level bound is exercised too and not just the
    // in-memory one the claim loop applies.
    self["limit"] = (n: number) => chain(rows.slice(0, n));
    self["then"] = (resolve: (v: unknown) => unknown) =>
      // Copies: the caller must not be able to mutate the store by accident.
      Promise.resolve(rows.map((r) => ({ ...r }))).then(resolve);
    return self;
  };

  return {
    db: {
      select: (shape?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          if (table === orgDigestSettings) return chain(settingsRows);
          if (table === organizations) return chain([{ id: "?", displayName: "Acme" }]);
          if (table === digestEmailRecipients) return chain([]);
          if (shape && "count" in shape) return chain([{ count: 0 }]);
          return chain([]);
        },
      }),
      update: () => ({
        set: (values: Row) => ({
          where: (w: unknown) => {
            const matched = settingsRows.filter(asPred(w));
            for (const row of matched) applySet(row, values);
            const rows = matched.map((r) => ({ ...r }));
            return {
              returning: () => Promise.resolve(rows),
              then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
            };
          },
        }),
      }),
    },
  };
});

// --- Mocked transports: every send succeeds; the tests count them ---

/** Orgs a digest was delivered for, in delivery order, one entry per send. */
let delivered: string[] = [];
/** Peak number of org sends in flight at once, to tell concurrency from serial. */
let maxInFlight = 0;
let inFlight = 0;

async function recordSend(organizationId: string): Promise<ReturnType<typeof routed>> {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  // Yield so a batch that really runs concurrently overlaps here, and one that
  // is awaited in sequence cannot.
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  inFlight -= 1;
  delivered.push(organizationId);
  return routed();
}

vi.mock("../email", () => ({
  isEmailConfigured: () => true,
  sendEmails: async () => ({ attempted: 0, succeeded: 0, failed: 0 }),
}));
vi.mock("../digest/narrative", () => ({ generateDigestNarrative: async () => null }));
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts: async () => [] }));

/**
 * All three transports sit behind `routeAlert` now, so that is the single seam
 * these tests mock. `alertReached` is the real predicate rather than a stub —
 * it decides whether a cooldown or claim is kept, and faking it would hide
 * exactly the bug it exists to prevent.
 */
// Defaults to a successful delivery: `routeAlert` never throws and always
// returns a result, so a mock that resolves `undefined` would fail tests in a
// way the real function cannot.
const routeAlert = vi.fn(async (...args: unknown[]) =>
  recordSend((args[0] as { organizationId: string }).organizationId),
);
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

const { DIGESTS_PER_TICK, MAX_DIGEST_ATTEMPTS, runWeeklyDigests } =
  await import("../digest/weekly");

/** `count` enabled orgs, all settled on the default Monday 07:00 UTC schedule. */
function seedOrgs(count: number, overrides: Row = {}): void {
  settingsRows = Array.from({ length: count }, (_, i) => ({
    // Zero-padded so the id ordering the claim uses is the obvious one.
    organizationId: `org-${String(i).padStart(2, "0")}`,
    enabled: true,
    lastSentWeekStart: "2026-07-13",
    lastSentAt: null,
    timezone: "UTC",
    sendDay: 1,
    sendHour: 7,
    narrativeEnabled: false,
    attemptCount: 0,
    lastAttemptAt: null,
    lastStatus: null,
    lastError: null,
    nextAttemptAt: null,
    ...overrides,
  }));
}

const orgIds = () => settingsRows.map((r) => r.organizationId as string);
const sentOrgIds = () =>
  settingsRows.filter((r) => r.lastSentWeekStart === "2026-07-20").map((r) => r.organizationId);

/** Monday 2026-07-27 07:00 UTC — the moment the week of 2026-07-20 comes due. */
const DUE = new Date("2026-07-27T07:00:00Z");
const tickAt = (minutes: number) => new Date(DUE.getTime() + minutes * 60 * 1000);

beforeEach(() => {
  delivered = [];
  maxInFlight = 0;
  inFlight = 0;
  settingsRows = [];
});

describe("a tick with more due orgs than it can send", () => {
  it("claims at most DIGESTS_PER_TICK of them", async () => {
    seedOrgs(40);
    await runWeeklyDigests(DUE);

    expect(delivered).toHaveLength(DIGESTS_PER_TICK);
    expect(sentOrgIds()).toHaveLength(DIGESTS_PER_TICK);
    // The 36 it did not get to are untouched — no half-claimed state.
    const untouched = settingsRows.filter((r) => r.lastSentWeekStart === "2026-07-13");
    expect(untouched).toHaveLength(40 - DIGESTS_PER_TICK);
    for (const row of untouched) expect(row).toMatchObject({ lastStatus: null, attemptCount: 0 });
  });

  it("runs the batch concurrently rather than one org after another", async () => {
    seedOrgs(40);
    await runWeeklyDigests(DUE);
    // Serial processing would never show two sends in flight at once, and the
    // whole point of the bound is that a tick costs one org's latency, not N.
    expect(maxInFlight).toBe(DIGESTS_PER_TICK);
  });

  it("does not starve the orgs it deferred — later ticks take the next batch", async () => {
    seedOrgs(12);
    await runWeeklyDigests(DUE);
    const first = [...delivered];

    await runWeeklyDigests(tickAt(1));
    const second = delivered.slice(first.length);

    expect(second).toHaveLength(DIGESTS_PER_TICK);
    // Disjoint: the second tick moved on to orgs the first one left behind.
    expect(second.some((id) => first.includes(id))).toBe(false);
  });

  it("drains the backlog over successive ticks, each org exactly once", async () => {
    seedOrgs(12);
    for (let tick = 0; tick < 10; tick++) await runWeeklyDigests(tickAt(tick));

    // Every org got its digest…
    expect(new Set(delivered)).toEqual(new Set(orgIds()));
    // …and none got it twice: the claim, not the batching, is what guarantees
    // that, and bounding the batch must not have weakened it.
    expect(delivered).toHaveLength(12);
    expect(sentOrgIds()).toHaveLength(12);
    for (const row of settingsRows) {
      expect(row).toMatchObject({ lastStatus: "succeeded", attemptCount: 1 });
    }
  });

  it("stops claiming once the backlog is drained", async () => {
    seedOrgs(6);
    for (let tick = 0; tick < 3; tick++) await runWeeklyDigests(tickAt(tick));
    expect(delivered).toHaveLength(6);

    delivered = [];
    await runWeeklyDigests(tickAt(4));
    expect(delivered).toEqual([]);
  });

  it("honours an explicit limit", async () => {
    seedOrgs(10);
    await runWeeklyDigests(DUE, 2);
    expect(delivered).toHaveLength(2);
  });
});

describe("a tick with a pile of due retries", () => {
  /** Orgs whose scheduled attempt failed, with an elapsed backoff gate. */
  function seedFailedOrgs(count: number): void {
    seedOrgs(count, {
      lastSentWeekStart: "2026-07-20",
      lastStatus: "failed",
      attemptCount: 1,
      lastError: "everything broke",
    });
    // Staggered gates, newest first in the array, so "oldest gate first" is a
    // claim over an order the store does not hand back for free.
    settingsRows.forEach((row, i) => {
      row["nextAttemptAt"] = new Date(DUE.getTime() - i * 60 * 1000);
    });
  }

  it("claims at most DIGESTS_PER_TICK retries and leaves the rest gated", async () => {
    seedFailedOrgs(20);
    await runWeeklyDigests(tickAt(1));

    expect(delivered).toHaveLength(DIGESTS_PER_TICK);
    // A retry that was not claimed keeps its gate and its attempt count, so it
    // is still owed one — an unclaimed row is untouched state.
    const untouched = settingsRows.filter((r) => r.lastStatus === "failed");
    expect(untouched).toHaveLength(20 - DIGESTS_PER_TICK);
    for (const row of untouched) {
      expect(row["nextAttemptAt"]).toBeInstanceOf(Date);
      expect(row["attemptCount"]).toBe(1);
    }
  });

  it("takes the longest-waiting retries first", async () => {
    seedFailedOrgs(20);
    await runWeeklyDigests(tickAt(1));
    // Gates were staggered oldest-last in the array, so the oldest gates are
    // the highest-numbered orgs.
    expect(new Set(delivered)).toEqual(new Set(["org-19", "org-18", "org-17", "org-16"]));
  });

  it("drains the retry backlog over successive ticks without double-sending", async () => {
    seedFailedOrgs(10);
    for (let tick = 1; tick < 6; tick++) await runWeeklyDigests(tickAt(tick));

    expect(new Set(delivered)).toEqual(new Set(orgIds()));
    expect(delivered).toHaveLength(10);
    for (const row of settingsRows) {
      expect(row).toMatchObject({ lastStatus: "succeeded", attemptCount: 2, nextAttemptAt: null });
    }
  });

  it("still bounds a retry to MAX_DIGEST_ATTEMPTS", async () => {
    seedFailedOrgs(2);
    for (const row of settingsRows) row["attemptCount"] = MAX_DIGEST_ATTEMPTS;
    await runWeeklyDigests(tickAt(1));
    expect(delivered).toEqual([]);
  });

  it("does not retry an org it has just claimed for this week", async () => {
    // The two phases run in sequence for exactly this reason: a scheduled claim
    // leaves the row `pending` with no gate, which the retry claim cannot match.
    seedOrgs(2, {
      lastStatus: "failed",
      attemptCount: 1,
      nextAttemptAt: new Date(DUE.getTime() - 60_000),
      lastSentWeekStart: "2026-07-13",
    });
    await runWeeklyDigests(DUE);
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered)).toEqual(new Set(orgIds()));
  });
});
