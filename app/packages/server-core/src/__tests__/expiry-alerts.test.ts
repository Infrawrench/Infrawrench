import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Expiry alert orchestration. The message rendering is covered by
 * `expiry-summary.test.ts`; what matters here is the claim/cooldown protocol,
 * which is drift's with one deliberate difference: a completed scan that found
 * nothing due KEEPS the window spent (`last_notified_at` means "last alert
 * scan", not "last message"), while a scan whose message reached nobody — or
 * that threw — is rolled back so the next tick retries.
 *
 * The DB is a chainable fake: `selectDistinct` resolves to `dueRows` (the
 * due-org query), `insert` (the claim) resolves to `claimResult`, `update`
 * records the release.
 */

vi.mock("../db/schema", () => ({
  accounts: {
    __t: "accounts",
    organizationId: "organizationId",
    deletedAt: "deletedAt",
  },
  orgExpirySettings: {
    __t: "orgExpirySettings",
    organizationId: "organizationId",
    enabled: "enabled",
    leadDays: "leadDays",
    lastNotifiedAt: "lastNotifiedAt",
  },
}));

/** Rows the due-org query resolves to. */
let dueRows: unknown[] = [];
/** When set, the due-org query rejects with this. */
let dueError: Error | null = null;
/** `limit(n)` argument of the due-org query. */
let lastLimit: number | undefined;
/** What the claim's `returning()` yields — a non-empty array means claimed. */
let claimResult: unknown[] = [];
/** `set(...)` arguments of every update, i.e. the releases. */
let releases: unknown[] = [];
/** `where(...)` arguments of every release, for asserting claim ownership. */
let releaseWheres: unknown[] = [];

vi.mock("../db/client", () => {
  const distinctChain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["leftJoin", "where", "orderBy"]) self[m] = () => self;
    self["limit"] = (n: number) => {
      lastLimit = n;
      return dueError ? Promise.reject(dueError) : Promise.resolve(dueRows);
    };
    return self;
  };
  const insertChain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["values", "onConflictDoUpdate"]) self[m] = () => self;
    self["returning"] = () => Promise.resolve(claimResult);
    return self;
  };
  const updateChain = () => {
    const self: Record<string, unknown> = {};
    self["set"] = (s: unknown) => {
      releases.push(s);
      return self;
    };
    self["where"] = (w: unknown) => {
      releaseWheres.push(w);
      return Promise.resolve(undefined);
    };
    return self;
  };
  return {
    db: {
      selectDistinct: () => ({ from: () => distinctChain() }),
      insert: () => insertChain(),
      update: () => updateChain(),
    },
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNull: (c: unknown) => ({ isNull: c }),
  lte: (a: unknown, b: unknown) => ({ lte: [a, b] }),
  or: (...parts: unknown[]) => ({ or: parts }),
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), { raw: () => ({ sql: true }) }),
}));

const getExpirySettings = vi.fn();
vi.mock("../expiry/settings", () => ({
  getExpirySettings: (...a: unknown[]) => getExpirySettings(...a),
}));

const listExpiring = vi.fn();
vi.mock("../expiry/feed", () => ({
  listExpiring: (...a: unknown[]) => listExpiring(...a),
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

import { EXPIRY_NOTIFY_COOLDOWN_MS, runExpiryAlerts } from "../expiry/alerts";

const ORG = "org1";
const NOW = new Date("2026-08-01T10:00:00.000Z");
const PRIOR = new Date("2026-07-30T10:00:00.000Z");

function settings(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    enabled: true,
    leadDays: 60,
    lastNotifiedAt: null as Date | null,
    ...overrides,
  };
}

function feedItem(overrides: Record<string, unknown> = {}) {
  return {
    resourceId: "r1",
    pluginId: "cloudflare",
    pluginName: "Cloudflare",
    resourceTypeId: "ssl-certificate",
    resourceTypeName: "SSL Certificate",
    accountId: "acc-1",
    accountName: "prod-cf",
    displayName: "example.com",
    externalId: null,
    fieldKey: "expiresAt",
    kind: "tls-cert",
    label: "Certificate expires",
    basis: "expiry",
    dueAt: "2026-08-10T00:00:00.000Z",
    daysRemaining: 9,
    severity: "warning",
    ...overrides,
  };
}

function feed(items: unknown[]) {
  return {
    items,
    totalCount: items.length,
    counts: { expired: 0, critical: 0, warning: items.length, upcoming: 0, ok: 0 },
    leadDays: 60,
    generatedAt: NOW.toISOString(),
  };
}

/** Quiet the module's own logging on error-path tests. */
function hushErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  dueRows = [{ organizationId: ORG }];
  dueError = null;
  lastLimit = undefined;
  claimResult = [{ organizationId: ORG }];
  releases = [];
  releaseWheres = [];
  getExpirySettings.mockResolvedValue(settings());
  listExpiring.mockResolvedValue(feed([feedItem()]));
  routeAlert.mockResolvedValue(routed());
  process.env["APP_URL"] = "https://app.example.com";
});

describe("the due batch", () => {
  it("passes the caller's limit through to the due-org query", async () => {
    await runExpiryAlerts({ limit: 4 }, NOW);
    expect(lastLimit).toBe(4);
  });

  it("survives the due query failing, without throwing into the poller", async () => {
    dueError = new Error("db is down");
    const spy = hushErrors();
    expect(await runExpiryAlerts({ limit: 4 }, NOW)).toEqual({
      scanned: 0,
      sent: 0,
      outcomes: {},
    });
    spy.mockRestore();
  });
});

describe("cooldown claim", () => {
  it("sends once when it wins the claim", async () => {
    const result = await runExpiryAlerts({ limit: 4 }, NOW);
    expect(result.sent).toBe(1);
    expect(result.outcomes[ORG]).toEqual({
      status: "sent",
      deadlines: 1,
      push: 1,
      slack: 1,
      msTeams: 0,
    });
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "expiryAlerts" }),
      ...[],
    );
  });

  it("stays silent when another replica already holds the window", async () => {
    claimResult = [];
    const result = await runExpiryAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toEqual({ status: "cooling-down" });
    expect(listExpiring).not.toHaveBeenCalled();
    expect(releases).toEqual([]);
  });

  it("skips an org whose row was disabled between the due query and the scan", async () => {
    getExpirySettings.mockResolvedValue(settings({ enabled: false }));
    const result = await runExpiryAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toEqual({ status: "disabled" });
    expect(result.scanned).toBe(0);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("is a daily cadence", () => {
    expect(EXPIRY_NOTIFY_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("the quiet-scan rule", () => {
  it("keeps the window spent when the scan finds nothing due", async () => {
    // last_notified_at means "last alert scan": deadlines move by whole days,
    // so a quiet org re-scanned every tick would only reconfirm the silence.
    listExpiring.mockResolvedValue(feed([]));
    const result = await runExpiryAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toEqual({ status: "quiet" });
    expect(result.scanned).toBe(1);
    expect(result.sent).toBe(0);
    expect(routeAlert).not.toHaveBeenCalled();
    expect(releases).toEqual([]);
  });

  it("does not alert on items beyond the lead time", async () => {
    listExpiring.mockResolvedValue(feed([feedItem({ severity: "ok", daysRemaining: 200 })]));
    const result = await runExpiryAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toEqual({ status: "quiet" });
    expect(routeAlert).not.toHaveBeenCalled();
  });
});

describe("release semantics", () => {
  it("rolls the claim back when every transport reached nobody", async () => {
    getExpirySettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    routeAlert.mockResolvedValue(unroutedResult());
    const result = await runExpiryAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toEqual({ status: "undelivered", deadlines: 1 });
    expect(releases).toEqual([{ lastNotifiedAt: PRIOR }]);
  });

  it("releases when the feed throws, so the day is not silently spent", async () => {
    getExpirySettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    listExpiring.mockRejectedValue(new Error("feed exploded"));
    const spy = hushErrors();
    const result = await runExpiryAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toEqual({
      status: "failed",
      error: "feed exploded",
      claimed: true,
      released: true,
    });
    expect(releases).toEqual([{ lastNotifiedAt: PRIOR }]);
    spy.mockRestore();
  });

  it("scopes the rollback to the claim it owns, not just the org", async () => {
    getExpirySettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    listExpiring.mockRejectedValue(new Error("feed exploded"));
    const spy = hushErrors();
    await runExpiryAlerts({ limit: 4 }, NOW);
    expect(releaseWheres).toHaveLength(1);
    // The claim instant appearing in the predicate is what distinguishes an
    // owned rollback from a blind one.
    expect(JSON.stringify(releaseWheres[0])).toContain(NOW.toISOString());
    spy.mockRestore();
  });

  it("keeps the claim for a day quiet hours held rather than delivered", async () => {
    // A held leg has `succeeded: 0` but the digest *will* arrive. Rolling the
    // claim back would rebuild the same day tomorrow and deliver it twice —
    // once from the queue, once fresh. The rule is "spend the day iff somebody
    // heard, or is guaranteed to".
    getExpirySettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    routeAlert.mockResolvedValue(
      routed({ succeeded: 0, byTransport: { push: 0, slack: 0, msTeams: 0 }, held: 1 }),
    );
    const spy = hushErrors();
    const result = await runExpiryAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toMatchObject({ status: "sent" });
    expect(releases).toEqual([]);
    spy.mockRestore();
  });

  it("releases exactly once on the throw path", async () => {
    getExpirySettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    listExpiring.mockRejectedValue(new Error("feed exploded"));
    const spy = hushErrors();
    await runExpiryAlerts({ limit: 4 }, NOW);
    expect(releases).toHaveLength(1);
    spy.mockRestore();
  });

  it("has nothing to roll back when the failure predates the claim", async () => {
    getExpirySettings.mockRejectedValue(new Error("settings unreadable"));
    const spy = hushErrors();
    const result = await runExpiryAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toEqual({
      status: "failed",
      error: "settings unreadable",
      claimed: false,
      released: false,
    });
    expect(result.scanned).toBe(0);
    expect(releases).toEqual([]);
    spy.mockRestore();
  });
});

describe("payload", () => {
  it("deep-links the push payload to the expiry radar", async () => {
    await runExpiryAlerts({ limit: 4 }, NOW);
    const push = routeAlert.mock.calls[0]![0] as { pushData: Record<string, unknown> };
    expect(push.pushData).toEqual({ type: "expiry_alert", orgId: ORG });
    const slack = routeAlert.mock.calls[0]![0] as { url?: string };
    expect(slack.url).toBe(`https://app.example.com/org/${ORG}/expiring`);
  });

  it("omits the button when the server has no APP_URL", async () => {
    delete process.env["APP_URL"];
    await runExpiryAlerts({ limit: 4 }, NOW);
    // `routeAlert` takes `url: string | null` and drops the button on a falsy
    // value, so the notifier passes the null straight through.
    const slack = routeAlert.mock.calls[0]![0] as { url?: string | null };
    expect(slack.url).toBeFalsy();
  });

  it("computes the feed at the claim's own instant and lead time", async () => {
    getExpirySettings.mockResolvedValue(settings({ leadDays: 30 }));
    await runExpiryAlerts({ limit: 4 }, NOW);
    expect(listExpiring).toHaveBeenCalledWith(ORG, { now: NOW.getTime(), leadDays: 30 });
  });
});
