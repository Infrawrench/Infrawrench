import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The digest's retry state machine.
 *
 * The invariant under test is the one PR #22 traded away: a build or send that
 * fails *after* the weekly claim must not burn the week, but it also must not
 * be recovered by rolling the claim back — two replicas would then race into
 * the same slot and resend. So the claim column only ever moves forward and the
 * retry lives in its own claimable gate (`next_attempt_at`), with an attempt
 * counter bounding it.
 *
 * The three cases that matter:
 *
 *   - total failure (nothing landed anywhere)  → retried, with backoff, up to
 *     `MAX_DIGEST_ATTEMPTS`, then parked until next week;
 *   - partial failure (Slack took it, Teams didn't) → *never* retried, because
 *     a resend would post the digest into Slack a second time;
 *   - nothing routed at all → not a delivery failure; surfaced, not retried.
 *
 * The DB is an in-memory fake: one settings row, plus predicate objects from a
 * mocked `drizzle-orm` that evaluate against it, so the WHERE clauses the real
 * claims depend on are actually exercised rather than stubbed away.
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

// --- Mocked drizzle: predicates become functions over the fake row ---

type Row = Record<string, unknown>;
type Pred = (row: Row) => boolean;

const asPred = (p: unknown): Pred => (typeof p === "function" ? (p as Pred) : () => true);

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
      row[col] != null && (row[col] as number) < (v as number),
  lte:
    (col: string, v: unknown): Pred =>
    (row) =>
      row[col] != null && (row[col] as number) <= (v as number),
  gte:
    (col: string, v: unknown): Pred =>
    (row) =>
      row[col] != null && (row[col] as number) >= (v as number),
  isNull:
    (col: string): Pred =>
    (row) =>
      row[col] == null,
  isNotNull:
    (col: string): Pred =>
    (row) =>
      row[col] != null,
  // `sql` is used for the attempt-count increment, the counts, and the
  // GREATEST() that keeps `last_sent_week_start` monotonic.
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    __sql: strings.join("?"),
    values,
  }),
}));

// --- Fake DB over a single settings row ---

let settingsRow: Row | null = null;
/** Every UPDATE the code issued, in order, for asserting claim semantics. */
let updates: Array<{ set: Row; matched: boolean }> = [];

function applySet(row: Row, values: Row): Row {
  const next = { ...row };
  for (const [k, v] of Object.entries(values)) {
    if (v && typeof v === "object" && "__sql" in (v as Row)) {
      const { __sql, values: params } = v as { __sql: string; values: unknown[] };
      if (__sql.includes("GREATEST")) {
        // Monotonic week-start: the greatest of the stored value and the
        // candidates the template interpolated.
        const candidates = [row[k], ...params].filter(
          (p): p is string => typeof p === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p),
        );
        next[k] = candidates.sort().at(-1) ?? row[k];
      } else {
        // The only other sql-valued assignment is `attempt_count + 1`.
        next[k] = ((row[k] as number) ?? 0) + 1;
      }
    } else {
      next[k] = v;
    }
  }
  return next;
}

vi.mock("../db/client", () => {
  const selectChain = (rows: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ["innerJoin", "leftJoin", "orderBy", "limit"]) self[m] = () => self;
    self["where"] = (w: unknown) => {
      const p = asPred(w);
      const filtered = rows.filter((r) => p(r as Row));
      return selectChain(filtered);
    };
    self["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return self;
  };

  return {
    db: {
      select: (shape?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          if (table === orgDigestSettings) {
            return selectChain(settingsRow ? [settingsRow] : []);
          }
          if (table === organizations) return selectChain([{ displayName: "Acme" }]);
          if (table === digestEmailRecipients) return selectChain([]);
          // The three cheap counts in buildWeeklyDigest.
          if (shape && "count" in shape) return selectChain([{ count: 0 }]);
          return selectChain([]);
        },
      }),
      insert: () => ({
        values: (seedValues: Row) => ({
          onConflictDoUpdate: ({ set }: { set: Row }) => ({
            returning: () => {
              settingsRow = settingsRow === null ? { ...seedValues } : applySet(settingsRow, set);
              return Promise.resolve([{ ...settingsRow }]);
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Row) => ({
          // Drizzle's builder is awaitable *and* has `.returning()`; the module
          // uses both shapes, so the fake has to support both.
          where: (w: unknown) => {
            const matched = settingsRow !== null && asPred(w)(settingsRow);
            updates.push({ set: values, matched });
            const rows: Row[] = [];
            if (matched) {
              settingsRow = applySet(settingsRow as Row, values);
              rows.push({ ...settingsRow });
            }
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

// --- Mocked transports: the tests drive their outcomes directly ---

let slackResult = { attempted: 0, succeeded: 0, failed: 0 };
let teamsResult = { attempted: 0, succeeded: 0, failed: 0 };
let emailResult = { attempted: 0, succeeded: 0, failed: 0 };
let buildShouldThrow = false;

vi.mock("../email", () => ({
  isEmailConfigured: () => true,
  sendEmails: async () => emailResult,
}));
vi.mock("../digest/narrative", () => ({ generateDigestNarrative: async () => null }));
vi.mock("../clickhouse/cost-readers", () => ({
  queryCosts: async () => {
    if (buildShouldThrow) throw new Error("ClickHouse unavailable");
    return [];
  },
}));

/**
 * All three transports sit behind `routeAlert` now, so that is the single seam
 * these tests mock. `alertReached` is the real predicate rather than a stub —
 * it decides whether a cooldown or claim is kept, and faking it would hide
 * exactly the bug it exists to prevent.
 */
// Defaults to a successful delivery: `routeAlert` never throws and always
// returns a result, so a mock that resolves `undefined` would fail tests in a
// way the real function cannot.
// Driven by the same `slackResult`/`teamsResult` knobs the transport mocks used
// to be, so the retry state machine's inputs are unchanged: what varies across
// these tests is how much of the fan-out landed, not how it was addressed.
const routeAlert = vi.fn(async (..._args: unknown[]) =>
  routed({
    attempted: slackResult.attempted + teamsResult.attempted,
    succeeded: slackResult.succeeded + teamsResult.succeeded,
    byTransport: { push: 0, slack: slackResult.succeeded, msTeams: teamsResult.succeeded },
    attemptedByTransport: {
      push: 0,
      slack: slackResult.attempted,
      msTeams: teamsResult.attempted,
    },
  }),
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

const {
  MAX_DIGEST_ATTEMPTS,
  classifyDelivery,
  nextDigestAttemptAt,
  runWeeklyDigests,
  scheduleFromRow,
  updateOrgDigestSettings,
} = await import("../digest/weekly");

/** A settled, enabled org on the default Monday 07:00 UTC schedule. */
function seed(overrides: Row = {}): void {
  settingsRow = {
    organizationId: "org1",
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
  };
}

/** Monday 2026-07-27 07:00 UTC — the moment the week of 2026-07-20 comes due. */
const DUE = new Date("2026-07-27T07:00:00Z");

beforeEach(() => {
  updates = [];
  slackResult = { attempted: 0, succeeded: 0, failed: 0 };
  teamsResult = { attempted: 0, succeeded: 0, failed: 0 };
  emailResult = { attempted: 0, succeeded: 0, failed: 0 };
  buildShouldThrow = false;
  seed();
});

describe("classifyDelivery", () => {
  const result = (
    slack: [number, number],
    teams: [number, number],
    email: [number, number] = [0, 0],
  ) => ({
    attempted: slack[0] + teams[0] + email[0],
    succeeded: slack[1] + teams[1] + email[1],
    slack: { attempted: slack[0], succeeded: slack[1] },
    teams: { attempted: teams[0], succeeded: teams[1] },
    email: { attempted: email[0], succeeded: email[1] },
  });

  it("calls a clean sweep a success and does not arm a retry", () => {
    expect(classifyDelivery(result([2, 2], [1, 1]))).toMatchObject({
      status: "succeeded",
      error: null,
      retryable: false,
    });
  });

  it("marks a total failure retryable", () => {
    const outcome = classifyDelivery(result([2, 0], [1, 0]));
    expect(outcome.status).toBe("failed");
    expect(outcome.retryable).toBe(true);
    expect(outcome.error).toContain("3 deliveries failed");
  });

  it("refuses to retry a partial delivery — a resend would duplicate", () => {
    const outcome = classifyDelivery(result([1, 1], [1, 0]));
    expect(outcome.status).toBe("partial");
    expect(outcome.retryable).toBe(false);
    expect(outcome.error).toContain("twice");
  });

  it("distinguishes nothing-routed from a failure, and does not retry it", () => {
    const outcome = classifyDelivery(result([0, 0], [0, 0]));
    expect(outcome.status).toBe("no_targets");
    expect(outcome.retryable).toBe(false);
    expect(outcome.error).toContain("Weekly digest");
  });
});

describe("backoff", () => {
  const now = new Date("2026-07-27T07:00:00Z");

  it("grows between attempts and stops at the ceiling", () => {
    const first = nextDigestAttemptAt(now, 1);
    const second = nextDigestAttemptAt(now, 2);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.getTime()).toBeGreaterThan(first!.getTime());
    expect(nextDigestAttemptAt(now, MAX_DIGEST_ATTEMPTS)).toBeNull();
    expect(nextDigestAttemptAt(now, MAX_DIGEST_ATTEMPTS + 5)).toBeNull();
  });
});

describe("scheduleFromRow", () => {
  it("clamps a hand-written row instead of producing nonsense", () => {
    expect(scheduleFromRow({ timezone: "Nowhere/Nothing", sendDay: 99, sendHour: 48 })).toEqual({
      timezone: "UTC",
      sendDay: 7,
      sendHour: 23,
    });
    expect(scheduleFromRow({ timezone: "Europe/Berlin", sendDay: 3, sendHour: 0 })).toEqual({
      timezone: "Europe/Berlin",
      sendDay: 3,
      sendHour: 0,
    });
  });
});

describe("updateOrgDigestSettings", () => {
  /** Sunday evening, before Monday's send: the week of 07-20 is still owed. */
  const BEFORE_SEND = new Date("2026-07-27T06:00:00Z");

  it("skips the current window when the digest is switched on", async () => {
    seed({ enabled: false, lastSentWeekStart: null });
    await updateOrgDigestSettings("org1", { enabled: true }, BEFORE_SEND);
    // Enabling mid-week must not fire a stale digest an hour later.
    expect(settingsRow?.lastSentWeekStart).toBe("2026-07-20");
  });

  it("does not swallow a pending digest when another setting is saved", async () => {
    // Regression: re-stamping the week on *every* save meant that ticking the
    // narrative box at 06:00 on send day silently ate that day's digest.
    seed({ enabled: true, lastSentWeekStart: "2026-07-13" });
    await updateOrgDigestSettings("org1", { narrativeEnabled: true }, BEFORE_SEND);
    expect(settingsRow).toMatchObject({
      narrativeEnabled: true,
      lastSentWeekStart: "2026-07-13",
    });

    // …and the digest still goes out an hour later.
    slackResult = { attempted: 1, succeeded: 1, failed: 0 };
    await runWeeklyDigests(DUE);
    expect(settingsRow).toMatchObject({
      lastSentWeekStart: "2026-07-20",
      lastStatus: "succeeded",
    });
  });

  it("clears a parked failure when the schedule changes", async () => {
    seed({
      enabled: true,
      lastStatus: "failed",
      lastError: "everything broke",
      attemptCount: 3,
      nextAttemptAt: null,
    });
    await updateOrgDigestSettings("org1", { sendDay: 5, sendHour: 9 }, BEFORE_SEND);
    expect(settingsRow).toMatchObject({
      sendDay: 5,
      sendHour: 9,
      lastStatus: null,
      lastError: null,
      attemptCount: 0,
    });
  });

  it("never walks the claim key backwards when the time zone moves", async () => {
    seed({ enabled: true, lastSentWeekStart: "2026-07-20" });
    // Kiritimati is a day ahead, so its local week can start earlier than the
    // stored value. GREATEST is what stops a replay of a week already sent.
    await updateOrgDigestSettings("org1", { enabled: true, timezone: "Pacific/Niue" }, BEFORE_SEND);
    expect((settingsRow?.lastSentWeekStart as string) >= "2026-07-20").toBe(true);
  });

  it("rejects an unknown time zone rather than storing it", async () => {
    seed();
    await expect(
      updateOrgDigestSettings("org1", { timezone: "Mars/Olympus_Mons" }),
    ).rejects.toThrow(/Unknown time zone/);
    expect(settingsRow?.timezone).toBe("UTC");
  });

  it("rejects an out-of-range send day and hour", async () => {
    seed();
    await expect(updateOrgDigestSettings("org1", { sendDay: 0 })).rejects.toThrow(/sendDay/);
    await expect(updateOrgDigestSettings("org1", { sendHour: 24 })).rejects.toThrow(/sendHour/);
  });
});

describe("runWeeklyDigests state machine", () => {
  it("claims the week, sends, and records success without arming a retry", async () => {
    slackResult = { attempted: 2, succeeded: 2, failed: 0 };
    await runWeeklyDigests(DUE);

    expect(settingsRow).toMatchObject({
      lastSentWeekStart: "2026-07-20",
      lastStatus: "succeeded",
      lastError: null,
      attemptCount: 1,
      nextAttemptAt: null,
    });
    expect(settingsRow?.lastSentAt).toBeInstanceOf(Date);
  });

  it("does nothing on a second pass in the same week — the claim is exactly-once", async () => {
    slackResult = { attempted: 1, succeeded: 1, failed: 0 };
    await runWeeklyDigests(DUE);
    const after = { ...settingsRow };

    updates = [];
    await runWeeklyDigests(new Date("2026-07-27T08:00:00Z"));
    // The pre-filter short-circuits before the weekly claim; the retry claim
    // is still issued but matches nothing. Either way the row does not move.
    expect(updates.filter((u) => u.matched)).toHaveLength(0);
    expect(settingsRow).toEqual(after);
  });

  it("arms a bounded retry on a total failure without rolling the claim back", async () => {
    slackResult = { attempted: 2, succeeded: 0, failed: 2 };
    await runWeeklyDigests(DUE);

    expect(settingsRow).toMatchObject({
      // The claim is *not* reverted — that is the whole point.
      lastSentWeekStart: "2026-07-20",
      lastStatus: "failed",
      attemptCount: 1,
      lastSentAt: null,
    });
    expect(settingsRow?.nextAttemptAt).toBeInstanceOf(Date);
    expect(settingsRow?.lastError).toContain("failed");
  });

  it("picks the retry up once the backoff elapses, and succeeds", async () => {
    slackResult = { attempted: 1, succeeded: 0, failed: 1 };
    await runWeeklyDigests(DUE);
    const armed = settingsRow?.nextAttemptAt as Date;

    // Too early: the gate has not elapsed, so nothing is claimed.
    updates = [];
    await runWeeklyDigests(new Date(armed.getTime() - 60_000));
    expect(updates.filter((u) => u.matched)).toHaveLength(0);
    expect(settingsRow).toMatchObject({ attemptCount: 1, lastStatus: "failed" });

    // Backoff elapsed and the send now works.
    slackResult = { attempted: 1, succeeded: 1, failed: 0 };
    await runWeeklyDigests(new Date(armed.getTime() + 1_000));
    expect(settingsRow).toMatchObject({
      lastStatus: "succeeded",
      attemptCount: 2,
      nextAttemptAt: null,
      lastSentWeekStart: "2026-07-20",
    });
  });

  it("gives up after MAX_DIGEST_ATTEMPTS and parks until next week", async () => {
    slackResult = { attempted: 1, succeeded: 0, failed: 1 };
    let clock = DUE;
    await runWeeklyDigests(clock);
    for (let i = 1; i < MAX_DIGEST_ATTEMPTS; i++) {
      const gate = settingsRow?.nextAttemptAt as Date;
      expect(gate).toBeInstanceOf(Date);
      clock = new Date(gate.getTime() + 1_000);
      await runWeeklyDigests(clock);
    }

    expect(settingsRow).toMatchObject({
      lastStatus: "failed",
      attemptCount: MAX_DIGEST_ATTEMPTS,
      // Parked: no further retry is scheduled.
      nextAttemptAt: null,
    });

    // And it stays parked — a later tick in the same week claims nothing.
    updates = [];
    await runWeeklyDigests(new Date(clock.getTime() + 24 * 60 * 60 * 1000));
    expect(updates.filter((u) => u.matched)).toHaveLength(0);
  });

  it("never retries a partial delivery", async () => {
    slackResult = { attempted: 1, succeeded: 1, failed: 0 };
    teamsResult = { attempted: 1, succeeded: 0, failed: 1 };
    await runWeeklyDigests(DUE);

    expect(settingsRow).toMatchObject({
      lastStatus: "partial",
      nextAttemptAt: null,
      attemptCount: 1,
    });
    // `lastSentAt` moves — the digest did reach someone.
    expect(settingsRow?.lastSentAt).toBeInstanceOf(Date);

    updates = [];
    await runWeeklyDigests(new Date(DUE.getTime() + 6 * 60 * 60 * 1000));
    expect(updates.filter((u) => u.matched)).toHaveLength(0);
  });

  it("surfaces a nothing-routed digest rather than failing silently", async () => {
    await runWeeklyDigests(DUE);
    expect(settingsRow).toMatchObject({
      lastStatus: "no_targets",
      nextAttemptAt: null,
      lastSentAt: null,
    });
    expect(settingsRow?.lastError).toContain("Weekly digest");
  });

  it("treats a build failure as retryable and records why", async () => {
    buildShouldThrow = true;
    await runWeeklyDigests(DUE);

    expect(settingsRow).toMatchObject({ lastStatus: "failed", attemptCount: 1 });
    expect(settingsRow?.lastError).toContain("ClickHouse unavailable");
    expect(settingsRow?.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("skips a disabled org entirely", async () => {
    seed({ enabled: false });
    await runWeeklyDigests(DUE);
    expect(updates.filter((u) => u.matched)).toHaveLength(0);
    expect(settingsRow).toMatchObject({ lastSentWeekStart: "2026-07-13", lastStatus: null });
  });

  it("does not fire before the org's local send hour", async () => {
    seed({ timezone: "America/New_York" });
    // 07:00 UTC is 03:00 in New York — well before the 07:00 local send hour.
    await runWeeklyDigests(DUE);
    expect(updates.filter((u) => u.matched)).toHaveLength(0);

    await runWeeklyDigests(new Date("2026-07-27T11:00:00Z"));
    expect(settingsRow).toMatchObject({ lastSentWeekStart: "2026-07-20" });
  });
});
