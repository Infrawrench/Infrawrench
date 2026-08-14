import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertReachedImpl, routed, unroutedResult } from "./helpers/route-alert";
import { fakePostgres } from "./helpers/fake-postgres";

/**
 * Expiry alert orchestration. The message rendering is covered by
 * `expiry-summary.test.ts`; what matters here is the claim/cooldown protocol,
 * which is drift's with one deliberate difference: a completed scan that found
 * nothing due KEEPS the window spent (`last_notified_at` means "last alert
 * scan", not "last message"), while a scan whose message reached nobody — or
 * that threw — is rolled back so the next tick retries.
 *
 * The DB is real Drizzle over a recording driver against the real schema —
 * the due-org query, the claim upsert and the release update render their
 * actual SQL (and shadow-validate under test:postgres:shadow). Sequential
 * results are queued: [due orgs], then [the claim's RETURNING].
 */

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** The release updates issued against the settings table, i.e. the rollbacks. */
const releases = () => pg.queries.filter((q) => q.sql.startsWith('update "org_expiry_settings"'));

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
  alertReached: alertReachedImpl,
}));

const { EXPIRY_NOTIFY_COOLDOWN_MS, runExpiryAlerts } = await import("../expiry/alerts");

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
  pg.reset();
  pg.queueRows([{ organizationId: ORG }]); // the due-org query
  pg.queueRows([{ organizationId: ORG }]); // the claim's RETURNING — claim won
  getExpirySettings.mockResolvedValue(settings());
  listExpiring.mockResolvedValue(feed([feedItem()]));
  routeAlert.mockResolvedValue(routed());
  process.env["APP_URL"] = "https://app.example.com";
});

describe("the due batch", () => {
  it("passes the caller's limit through to the due-org query", async () => {
    await runExpiryAlerts({ limit: 4 }, NOW);
    // The parameterized LIMIT is the statement's last parameter.
    expect(pg.queries[0]!.sql).toContain("limit");
    expect(pg.queries[0]!.params.at(-1)).toBe(4);
  });

  it("survives the due query failing, without throwing into the poller", async () => {
    // A row the recording driver cannot decode makes the due query itself
    // reject — the closest a canned driver gets to "db is down".
    pg.reset();
    pg.queueRows([null as never]);
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
    expect(routeAlert).toHaveBeenCalledWith(expect.objectContaining({ trigger: "expiryAlerts" }));
  });

  it("stays silent when another replica already holds the window", async () => {
    pg.reset();
    pg.queueRows([{ organizationId: ORG }]);
    pg.queueRows([]); // the claim's RETURNING — another replica holds it
    const result = await runExpiryAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toEqual({ status: "cooling-down" });
    expect(listExpiring).not.toHaveBeenCalled();
    expect(releases()).toEqual([]);
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
    expect(releases()).toEqual([]);
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
    expect(releases()).toHaveLength(1);
    // set "last_notified_at" = $1 (the prior stamp, restored) where the org
    // still carries this claim's own instant.
    expect(releases()[0]!.params).toEqual([PRIOR.toISOString(), ORG, NOW.toISOString()]);
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
    expect(releases()).toHaveLength(1);
    expect(releases()[0]!.params).toEqual([PRIOR.toISOString(), ORG, NOW.toISOString()]);
    spy.mockRestore();
  });

  it("scopes the rollback to the claim it owns, not just the org", async () => {
    getExpirySettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    listExpiring.mockRejectedValue(new Error("feed exploded"));
    const spy = hushErrors();
    await runExpiryAlerts({ limit: 4 }, NOW);
    expect(releases()).toHaveLength(1);
    // The claim instant appearing in the WHERE parameters is what
    // distinguishes an owned rollback from a blind one.
    expect(releases()[0]!.sql).toContain('"last_notified_at" = ');
    expect(releases()[0]!.params.slice(1)).toContain(NOW.toISOString());
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
    expect(releases()).toEqual([]);
    spy.mockRestore();
  });

  it("releases exactly once on the throw path", async () => {
    getExpirySettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    listExpiring.mockRejectedValue(new Error("feed exploded"));
    const spy = hushErrors();
    await runExpiryAlerts({ limit: 4 }, NOW);
    expect(releases()).toHaveLength(1);
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
    expect(releases()).toEqual([]);
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
