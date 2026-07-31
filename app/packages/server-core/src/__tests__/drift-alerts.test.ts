import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drift notification orchestration. The pure batching and rendering is covered
 * by `drift-summary.test.ts`; what matters here is everything that decides
 * whether a message goes out at all, because that is what bounds the volume:
 *
 *  - the cheap guards, which must not touch the cooldown row;
 *  - the cooldown claim, which is the hard cap of one message per org per
 *    window and must lose gracefully when a second replica wins it;
 *  - the rollback, so a window nobody received is not spent — including when
 *    the digest *throws*, since a kept claim moves the next digest's `since`
 *    past changes nobody was ever told about;
 *  - the read window, which must start at the previous notification rather
 *    than at this sync pass.
 *
 * The DB is a chainable fake: `select` resolves to `changeRows`, `insert` (the
 * claim) resolves to `claimResult`, `update` records the release.
 */

vi.mock("../db/schema", () => ({
  accounts: { __t: "accounts", id: "id", displayName: "displayName" },
  resourceChanges: {
    __t: "resourceChanges",
    organizationId: "organizationId",
    accountId: "accountId",
    resourceTypeId: "resourceTypeId",
    displayName: "displayName",
    changeKind: "changeKind",
    diff: "diff",
    createdAt: "createdAt",
    id: "id",
  },
  orgDriftAlertSettings: {
    __t: "orgDriftAlertSettings",
    organizationId: "organizationId",
    lastNotifiedAt: "lastNotifiedAt",
  },
}));

/** Rows the window query resolves to. */
let changeRows: unknown[] = [];
/** When set, the window query rejects with this instead of resolving. */
let changeRowsError: Error | null = null;
/** What the claim's `returning()` yields — a non-empty array means claimed. */
let claimResult: unknown[] = [];
/** `limit(n)` argument of the most recent select. */
let lastLimit: number | undefined;
/** `set(...)` arguments of every update, i.e. the releases. */
let releases: unknown[] = [];
/** `where(...)` arguments of every release, for asserting claim ownership. */
let releaseWheres: unknown[] = [];
/** When set, the release UPDATE rejects with this. */
let releaseError: Error | null = null;

vi.mock("../db/client", () => {
  const selectChain = () => {
    const self: Record<string, unknown> = {};
    for (const m of ["innerJoin", "leftJoin", "where", "orderBy"]) self[m] = () => self;
    self["limit"] = (n: number) => {
      lastLimit = n;
      return self;
    };
    self["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      (changeRowsError ? Promise.reject(changeRowsError) : Promise.resolve(changeRows)).then(
        resolve,
        reject,
      );
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
      return releaseError ? Promise.reject(releaseError) : Promise.resolve(undefined);
    };
    return self;
  };
  return {
    db: {
      select: () => ({ from: () => selectChain() }),
      insert: () => insertChain(),
      update: () => updateChain(),
    },
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  desc: (c: unknown) => ({ desc: c }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  gt: (a: unknown, b: unknown) => ({ gt: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), { raw: () => ({ sql: true }) }),
}));

const getDriftAlertSettings = vi.fn();
vi.mock("../drift/settings", () => ({
  getDriftAlertSettings: (...a: unknown[]) => getDriftAlertSettings(...a),
}));

const sendPushToOrg = vi.fn();
const sendSlackToOrg = vi.fn();
const sendMsTeamsToOrg = vi.fn();
vi.mock("../push/dispatch", () => ({ sendPushToOrg: (...a: unknown[]) => sendPushToOrg(...a) }));
vi.mock("../slack", () => ({ sendSlackToOrg: (...a: unknown[]) => sendSlackToOrg(...a) }));
vi.mock("../msteams", () => ({ sendMsTeamsToOrg: (...a: unknown[]) => sendMsTeamsToOrg(...a) }));

import { notifyResourceDrift } from "../drift/alerts";
import { MAX_SCANNED_CHANGES } from "../drift/summary";
import type { ResourceChangeEvent } from "../resource-changes";

const ORG = "org1";
const ACCOUNT = "acc-1";
const NOW = new Date("2026-07-31T10:00:00.000Z");

function settings(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    notifyCreated: true,
    notifyUpdated: false,
    notifyDeleted: true,
    cooldownMinutes: 60,
    minChanges: 1,
    accountIds: [] as string[],
    lastNotifiedAt: null as Date | null,
    ...overrides,
  };
}

function event(kind: ResourceChangeEvent["changeKind"] = "created"): ResourceChangeEvent {
  return {
    resourceId: "r1",
    pluginId: "aws",
    resourceTypeId: "ec2-instance",
    displayName: "web-1",
    changeKind: kind,
    diff: [],
  };
}

function changeRow(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT,
    accountName: "prod-aws",
    resourceTypeId: "ec2-instance",
    displayName: "web-1",
    changeKind: "created",
    diff: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  changeRows = [changeRow()];
  changeRowsError = null;
  claimResult = [{ organizationId: ORG }];
  releases = [];
  releaseWheres = [];
  releaseError = null;
  lastLimit = undefined;
  getDriftAlertSettings.mockResolvedValue(settings());
  sendPushToOrg.mockResolvedValue({ attempted: 1, succeeded: 1 });
  sendSlackToOrg.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 });
  sendMsTeamsToOrg.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
  process.env["APP_URL"] = "https://app.example.com";
});

afterEach(() => {
  delete process.env["APP_URL"];
});

describe("cheap guards", () => {
  it("does nothing at all when the pass recorded no changes", async () => {
    expect(await notifyResourceDrift(ORG, ACCOUNT, [], NOW)).toEqual({ status: "no-changes" });
    expect(getDriftAlertSettings).not.toHaveBeenCalled();
    expect(sendSlackToOrg).not.toHaveBeenCalled();
  });

  it("skips an account outside the org's scope without claiming the window", async () => {
    getDriftAlertSettings.mockResolvedValue(settings({ accountIds: ["other"] }));
    expect(await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW)).toEqual({ status: "filtered" });
    expect(sendSlackToOrg).not.toHaveBeenCalled();
    expect(releases).toEqual([]);
  });

  it("skips a pass whose only changes are a kind the org muted", async () => {
    // Field updates are off by default — the volume lever.
    expect(await notifyResourceDrift(ORG, ACCOUNT, [event("updated")], NOW)).toEqual({
      status: "filtered",
    });
    expect(sendSlackToOrg).not.toHaveBeenCalled();
  });
});

describe("cooldown claim", () => {
  it("sends once when it wins the claim", async () => {
    const result = await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW);
    expect(result).toEqual({ status: "sent", changes: 1, push: 1, slack: 1, msTeams: 0 });
    expect(sendPushToOrg).toHaveBeenCalledWith(ORG, "resourceDrift", expect.anything());
    expect(sendSlackToOrg).toHaveBeenCalledWith(ORG, "resourceDrift", expect.anything());
    expect(sendMsTeamsToOrg).toHaveBeenCalledWith(ORG, "resourceDrift", expect.anything());
  });

  it("stays silent when another replica already holds the window", async () => {
    claimResult = [];
    expect(await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW)).toEqual({
      status: "cooling-down",
    });
    expect(sendSlackToOrg).not.toHaveBeenCalled();
    // A lost claim must not roll anything back — the winner owns the row.
    expect(releases).toEqual([]);
  });

  it("rolls the claim back when every transport reached nobody", async () => {
    const prior = new Date("2026-07-31T08:00:00.000Z");
    getDriftAlertSettings.mockResolvedValue(settings({ lastNotifiedAt: prior }));
    sendPushToOrg.mockResolvedValue({ attempted: 0, succeeded: 0 });
    sendSlackToOrg.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });

    expect(await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW)).toEqual({
      status: "undelivered",
      changes: 1,
    });
    expect(releases).toEqual([{ lastNotifiedAt: prior }]);
  });

  it("rolls the claim back when the window is under the org's minimum", async () => {
    getDriftAlertSettings.mockResolvedValue(settings({ minChanges: 5 }));
    changeRows = [changeRow(), changeRow()];
    expect(await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW)).toEqual({
      status: "below-minimum",
      matched: 2,
    });
    expect(sendSlackToOrg).not.toHaveBeenCalled();
    expect(releases).toEqual([{ lastNotifiedAt: null }]);
  });
});

describe("window and payload", () => {
  it("reads at most one row past the scan cap", async () => {
    await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW);
    expect(lastLimit).toBe(MAX_SCANNED_CHANGES + 1);
  });

  it("covers everything since the previous notification, not just this pass", async () => {
    const prior = new Date("2026-07-31T08:30:00.000Z");
    getDriftAlertSettings.mockResolvedValue(settings({ lastNotifiedAt: prior }));
    changeRows = [changeRow(), changeRow({ accountId: "acc-2", accountName: "do-main" })];

    await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW);

    const push = sendPushToOrg.mock.calls[0]![2] as { data: Record<string, unknown> };
    expect(push.data.since).toBe(prior.toISOString());
    expect(push.data.changeCount).toBe(2);
  });

  it("falls back to one cooldown window when the org has never been notified", async () => {
    await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW);
    const push = sendPushToOrg.mock.calls[0]![2] as { data: Record<string, unknown> };
    expect(push.data.since).toBe(new Date(NOW.getTime() - 60 * 60_000).toISOString());
  });

  it("deep-links to the change timeline and names the account when there is one", async () => {
    await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW);
    const push = sendPushToOrg.mock.calls[0]![2] as { data: Record<string, unknown> };
    expect(push.data).toMatchObject({
      type: "resource_drift",
      orgId: ORG,
      accountId: ACCOUNT,
    });
    const slack = sendSlackToOrg.mock.calls[0]![2] as { url?: string };
    expect(slack.url).toBe(`https://app.example.com/org/${ORG}/changes`);
  });

  it("omits accountId from the payload when the window spans several accounts", async () => {
    changeRows = [changeRow(), changeRow({ accountId: "acc-2", accountName: "do-main" })];
    await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW);
    const push = sendPushToOrg.mock.calls[0]![2] as { data: Record<string, unknown> };
    expect(push.data.accountId).toBeUndefined();
  });

  it("omits the button when the server has no APP_URL", async () => {
    delete process.env["APP_URL"];
    await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW);
    const slack = sendSlackToOrg.mock.calls[0]![2] as { url?: string };
    expect(slack.url).toBeUndefined();
  });
});

describe("failure containment", () => {
  const PRIOR = new Date("2026-07-31T08:00:00.000Z");

  /** Quiet the module's own logging; every test here goes down an error path. */
  function hushErrors() {
    return vi.spyOn(console, "error").mockImplementation(() => {});
  }

  it("swallows a transport throwing rather than failing the sync", async () => {
    sendSlackToOrg.mockRejectedValue(new Error("slack exploded"));
    const spy = hushErrors();
    expect(await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW)).toMatchObject({
      status: "failed",
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("reports a failure as its own status, not as a quiet window", async () => {
    // "no-changes" means nothing happened. A reader has to be able to tell that
    // apart from a window that broke, or a silent outage looks like calm.
    changeRowsError = new Error("window query exploded");
    const spy = hushErrors();
    expect(await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW)).toEqual({
      status: "failed",
      error: "window query exploded",
      released: true,
    });
    spy.mockRestore();
  });

  it("releases the claimed window when the read throws, so the changes are not lost", async () => {
    // The claim already advanced last_notified_at. Keeping it would move the
    // next digest's `since` past every change in this window — dropped forever.
    getDriftAlertSettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    changeRowsError = new Error("window query exploded");
    const spy = hushErrors();

    const result = await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW);

    expect(result).toMatchObject({ status: "failed", released: true });
    expect(releases).toEqual([{ lastNotifiedAt: PRIOR }]);
    spy.mockRestore();
  });

  it("releases when the first transport throws — nothing was delivered", async () => {
    getDriftAlertSettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    sendPushToOrg.mockRejectedValue(new Error("expo exploded"));
    const spy = hushErrors();

    expect(await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW)).toMatchObject({
      released: true,
    });
    expect(releases).toEqual([{ lastNotifiedAt: PRIOR }]);
    spy.mockRestore();
  });

  it("keeps the claim when a transport throws after another already delivered", async () => {
    // Push landed, so the window's changes *were* reported. Rewinding here
    // would re-send them in the next window; the release rule is the same one
    // the `undelivered` branch uses — spend the window iff somebody heard.
    getDriftAlertSettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    sendPushToOrg.mockResolvedValue({ attempted: 1, succeeded: 1 });
    sendSlackToOrg.mockRejectedValue(new Error("slack exploded"));
    const spy = hushErrors();

    expect(await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW)).toMatchObject({
      status: "failed",
      released: false,
    });
    expect(releases).toEqual([]);
    spy.mockRestore();
  });

  it("does not let a failing release mask the error that caused it", async () => {
    changeRowsError = new Error("window query exploded");
    releaseError = new Error("database is down");
    const spy = hushErrors();

    expect(await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW)).toEqual({
      status: "failed",
      error: "window query exploded",
      released: false,
    });
    spy.mockRestore();
  });

  it("scopes the rollback to the claim it owns, not just the org", async () => {
    // `claimWindow` stamps `lastNotifiedAt` with its own `now`, so that value is
    // the ownership token. A replica that wedges past the cooldown would come
    // back to find a *later* replica holding the window; an org-only UPDATE
    // would rewind that replica's claim and re-send a window already delivered.
    getDriftAlertSettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    changeRowsError = new Error("window query exploded");
    const spy = hushErrors();

    await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW);

    expect(releases).toEqual([{ lastNotifiedAt: PRIOR }]);
    expect(releaseWheres).toHaveLength(1);
    // The predicate is a drizzle expression tree; the claim instant appearing in
    // it is what distinguishes an owned rollback from a blind one.
    expect(JSON.stringify(releaseWheres[0])).toContain(NOW.toISOString());
    spy.mockRestore();
  });

  it("releases exactly once on the throw path", async () => {
    getDriftAlertSettings.mockResolvedValue(settings({ lastNotifiedAt: PRIOR }));
    changeRowsError = new Error("window query exploded");
    const spy = hushErrors();

    await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW);

    expect(releases).toHaveLength(1);
    spy.mockRestore();
  });

  it("has nothing to roll back when the failure predates the claim", async () => {
    getDriftAlertSettings.mockRejectedValue(new Error("settings unreadable"));
    const spy = hushErrors();

    expect(await notifyResourceDrift(ORG, ACCOUNT, [event()], NOW)).toEqual({
      status: "failed",
      error: "settings unreadable",
      released: false,
    });
    expect(releases).toEqual([]);
    spy.mockRestore();
  });
});
