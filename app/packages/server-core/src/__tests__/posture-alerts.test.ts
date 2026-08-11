import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertReachedImpl, routed } from "./helpers/route-alert";

/**
 * The security alert window, which now covers **two** feeds: posture checks and
 * the cross-cloud access review. The message rendering is covered by
 * `access-review-summary.test.ts`; what matters here is the claim protocol, and
 * specifically the rule the second feed put under pressure —
 *
 * **a failed scan must never spend the window.** `last_notified_at` means "last
 * alert scan", so a scan that *completed* and found nothing keeps the window
 * spent. A scan where one half threw established nothing at all, and treating
 * it as quiet would suppress both the retry and every access finding for 24
 * hours while a broken feed sat indistinguishable from a clean org.
 *
 * The DB is a chainable fake, the shape `expiry-alerts.test.ts` uses:
 * `selectDistinct` resolves to `dueRows` (the due-org query), `insert` (the
 * claim) resolves to `claimResult`, `update` records the release.
 */

vi.mock("../db/schema", () => ({
  accounts: {
    __t: "accounts",
    organizationId: "organizationId",
    deletedAt: "deletedAt",
  },
  orgPostureSettings: {
    __t: "orgPostureSettings",
    organizationId: "organizationId",
    enabled: "enabled",
    lastNotifiedAt: "lastNotifiedAt",
    updatedAt: "updatedAt",
  },
}));

/** Rows the due-org query resolves to. */
let dueRows: unknown[] = [];
/** What the claim's `returning()` yields — a non-empty array means claimed. */
let claimResult: unknown[] = [];
/** `set(...)` arguments of every update, i.e. the releases. */
let releases: unknown[] = [];

vi.mock("../db/client", () => {
  const distinctChain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["leftJoin", "where", "orderBy"]) self[m] = () => self;
    self["limit"] = () => Promise.resolve(dueRows);
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
    self["where"] = () => Promise.resolve(undefined);
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

const getPostureSettings = vi.fn();
vi.mock("../posture/settings", () => ({
  getPostureSettings: (...a: unknown[]) => getPostureSettings(...a),
}));

const listPosture = vi.fn();
vi.mock("../posture/feed", () => ({
  listPosture: (...a: unknown[]) => listPosture(...a),
}));

const listAccessReview = vi.fn();
vi.mock("../access-review/feed", () => ({
  listAccessReview: (...a: unknown[]) => listAccessReview(...a),
}));

const routeAlert = vi.fn(async (..._args: unknown[]) => routed());
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: alertReachedImpl,
}));

import { runPostureAlerts } from "../posture/alerts";
import { ACCESS_REVIEW_UNAVAILABLE_NOTE } from "../access-review/summary";

const ORG = "org1";
const NOW = new Date("2026-08-11T10:00:00.000Z");

function postureFeed(severities: string[] = []) {
  const findings = severities.map((severity, i) => ({
    resourceId: `r${i}`,
    pluginId: "aws",
    pluginName: "AWS",
    resourceTypeId: "s3-bucket",
    resourceTypeName: "S3 Bucket",
    accountId: "acc-1",
    accountName: "prod",
    displayName: `bucket-${i}`,
    externalId: null,
    ruleId: "s3-public",
    title: "Bucket allows public access",
    severity,
    category: "public-exposure",
    reason: "…",
  }));
  return {
    findings,
    totalCount: findings.length,
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    dismissed: [],
    dismissedCount: 0,
    generatedAt: NOW.toISOString(),
  };
}

function accessReview(severities: string[] = []) {
  const findings = severities.map((severity, i) => ({
    resourceId: `p${i}`,
    ruleId: "access-review:admin-principal",
    title: "Administrative or wildcard permissions",
    severity,
    reason: "…",
    principal: {
      resourceId: `p${i}`,
      pluginId: "workos",
      pluginName: "WorkOS",
      resourceTypeId: "role",
      resourceTypeName: "Role",
      accountId: "acc-2",
      accountName: "directory",
      displayName: `role-${i}`,
      externalId: null,
      role: "role",
      lastUsedAt: null,
      daysSinceLastUsed: null,
      activity: "unknown",
      createdAt: null,
      ageDays: null,
      admin: true,
      mfa: null,
      parent: null,
      owner: null,
      revokeActionId: null,
    },
  }));
  return {
    principals: findings.map((f) => f.principal),
    findings,
    totalCount: findings.length,
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    byRule: {},
    byRole: {},
    dismissed: [],
    dismissedCount: 0,
    unknownActivityCount: 0,
    staleDays: 90,
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
  claimResult = [{ organizationId: ORG }];
  releases = [];
  getPostureSettings.mockResolvedValue({
    organizationId: ORG,
    enabled: true,
    lastNotifiedAt: null as Date | null,
  });
  listPosture.mockResolvedValue(postureFeed([]));
  listAccessReview.mockResolvedValue(accessReview([]));
  routeAlert.mockResolvedValue(routed());
  process.env["APP_URL"] = "https://app.example.com";
});

describe("the quiet-scan rule", () => {
  it("keeps the window spent when both halves completed and found nothing", async () => {
    const result = await runPostureAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toEqual({ status: "quiet" });
    expect(result.scanned).toBe(1);
    expect(routeAlert).not.toHaveBeenCalled();
    expect(releases).toEqual([]);
  });
});

describe("a failed access review is not a quiet scan", () => {
  // The regression: the access half threw, posture had nothing alertable, and
  // the window was marked spent — suppressing the retry and every access
  // finding for a day, with a broken feed indistinguishable from a clean org.
  it("rolls the claim back instead of spending the window", async () => {
    listAccessReview.mockRejectedValue(new Error("clickhouse is down"));
    const spy = hushErrors();

    const result = await runPostureAlerts({ limit: 4 }, NOW);

    expect(result.outcomes[ORG]).toEqual({
      status: "scan-failed",
      error: "clickhouse is down",
    });
    expect(result.sent).toBe(0);
    // The claim was taken, so the org counts as scanned…
    expect(result.scanned).toBe(1);
    // …but it is handed straight back, so the next tick retries.
    expect(releases).toEqual([{ lastNotifiedAt: null }]);
    expect(routeAlert).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("restores the previous stamp rather than blanking it", async () => {
    const prior = new Date("2026-08-09T10:00:00.000Z");
    getPostureSettings.mockResolvedValue({
      organizationId: ORG,
      enabled: true,
      lastNotifiedAt: prior,
    });
    listAccessReview.mockRejectedValue(new Error("boom"));
    const spy = hushErrors();

    await runPostureAlerts({ limit: 4 }, NOW);

    expect(releases).toEqual([{ lastNotifiedAt: prior }]);
    spy.mockRestore();
  });
});

describe("a failed access review never degrades posture's own alerting", () => {
  it("still sends the posture findings", async () => {
    listPosture.mockResolvedValue(postureFeed(["critical"]));
    listAccessReview.mockRejectedValue(new Error("boom"));
    const spy = hushErrors();

    const result = await runPostureAlerts({ limit: 4 }, NOW);

    expect(result.outcomes[ORG]).toMatchObject({
      status: "sent",
      findings: 1,
      accessFindings: 0,
    });
    expect(routeAlert).toHaveBeenCalledWith(expect.objectContaining({ trigger: "postureAlerts" }));
    spy.mockRestore();
  });

  // …but it must not read as a complete picture, which is the same
  // unknown-versus-clean distinction the findings themselves keep.
  it("says the access half is missing rather than implying it was clean", async () => {
    listPosture.mockResolvedValue(postureFeed(["critical"]));
    listAccessReview.mockRejectedValue(new Error("boom"));
    const spy = hushErrors();

    await runPostureAlerts({ limit: 4 }, NOW);

    const call = routeAlert.mock.calls[0]?.[0] as { body: string; teamsBody: string };
    expect(call.body).toContain(ACCESS_REVIEW_UNAVAILABLE_NOTE);
    expect(call.teamsBody).toContain(ACCESS_REVIEW_UNAVAILABLE_NOTE);
    spy.mockRestore();
  });

  it("leaves the note off a window where both halves completed", async () => {
    listPosture.mockResolvedValue(postureFeed(["critical"]));
    listAccessReview.mockResolvedValue(accessReview(["high"]));

    await runPostureAlerts({ limit: 4 }, NOW);

    const call = routeAlert.mock.calls[0]?.[0] as { body: string };
    expect(call.body).not.toContain(ACCESS_REVIEW_UNAVAILABLE_NOTE);
    expect(call.body).toContain("access finding");
  });
});

describe("the access half can alert on its own", () => {
  it("sends under the posture trigger with an access-led headline", async () => {
    listAccessReview.mockResolvedValue(accessReview(["critical", "high"]));

    const result = await runPostureAlerts({ limit: 4 }, NOW);

    expect(result.outcomes[ORG]).toMatchObject({
      status: "sent",
      findings: 0,
      accessFindings: 2,
    });
    const call = routeAlert.mock.calls[0]?.[0] as { title: string; body: string };
    // Not "Posture checks: 0 high-severity findings".
    expect(call.title).toBe("Access review: 1 critical finding, 1 high");
    expect(call.body).not.toContain("on synced resources");
  });

  it("does not alert on medium or low findings", async () => {
    listAccessReview.mockResolvedValue(accessReview(["medium", "low"]));
    const result = await runPostureAlerts({ limit: 4 }, NOW);
    expect(result.outcomes[ORG]).toEqual({ status: "quiet" });
    expect(routeAlert).not.toHaveBeenCalled();
  });
});
