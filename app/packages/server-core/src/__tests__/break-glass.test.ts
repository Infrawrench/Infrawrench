import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

/**
 * The three rules that make break-glass safe are the point of this suite:
 * you cannot approve your own request, you cannot grant what you do not hold,
 * and the window is evaluated rather than swept. Everything else here is
 * plumbing.
 *
 * The DB is real Drizzle over a recording driver against the real schema, so
 * every statement renders its actual SQL (and shadow-validates under
 * test:postgres:shadow). Each query's rows are queued FIFO in execution order
 * — a select's rows first, then the insert/update RETURNING.
 */
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** Every insert / update statement issued, for the not-written assertions. */
const inserts = () => pg.queries.filter((q) => q.sql.startsWith("insert"));
const updates = () => pg.queries.filter((q) => q.sql.startsWith("update"));

const fanOut = vi.fn(async () => undefined);
vi.mock("../approvals/notify", () => ({
  fanOutApprovalRequest: (...a: unknown[]) => fanOut(...(a as [])),
  formatApprovalExpiry: () => "expires in 60 minutes",
  appPath: (p: string) => `https://app.test${p}`,
}));
vi.mock("../slack-approvals", () => ({
  updateSlackApprovalMessages: vi.fn(async () => undefined),
}));

let breakGlass: typeof import("../access/break-glass");

/**
 * A stored row with sensible defaults; override what a test cares about.
 * Keys are in the `access_requests` column order (see helpers/fake-postgres.ts
 * — rows decode positionally). Date values pass through the column mapping
 * unchanged, exactly as the real driver's parsed dates would.
 */
function row(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "req-1",
    organizationId: "org1",
    userId: "requester",
    userName: "Dana",
    permissions: ["resources:delete"],
    reason: "Restoring prod from last night's snapshot — INC-4417",
    durationMinutes: 60,
    status: "pending",
    expiresAt: new Date(now + 30 * 60_000),
    decidedAt: null,
    decidedByUserId: null,
    decidedByName: null,
    decisionNote: null,
    grantedAt: null,
    grantExpiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    revokedByName: null,
    createdAt: new Date(now),
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  breakGlass = await import("../access/break-glass");
});

describe("createAccessRequest", () => {
  it("rejects a request for permissions the caller already holds", async () => {
    // Almost always a mistake — the wrong permission string, or a role that
    // changed. Saying so beats sending an approver a no-op to decide.
    const result = await breakGlass.createAccessRequest(
      {
        organizationId: "org1",
        userId: "u1",
        permissions: ["resources:read"],
        reason: "I would like to read things",
        durationMinutes: 60,
      },
      ["resources:read", "resources:write"],
    );
    expect(result.outcome).toBe("already_held");
    expect(inserts()).toEqual([]);
  });

  it("rejects a reason too short to be auditable", async () => {
    const result = await breakGlass.createAccessRequest(
      {
        organizationId: "org1",
        userId: "u1",
        permissions: ["resources:delete"],
        reason: "need it",
        durationMinutes: 60,
      },
      [],
    );
    expect(result).toMatchObject({ outcome: "invalid" });
  });

  it("rejects a duration outside the bounds", async () => {
    const tooLong = await breakGlass.createAccessRequest(
      {
        organizationId: "org1",
        userId: "u1",
        permissions: ["resources:delete"],
        reason: "A perfectly good reason for this",
        durationMinutes: breakGlass.MAX_GRANT_MINUTES + 1,
      },
      [],
    );
    expect(tooLong).toMatchObject({ outcome: "invalid" });
  });

  it("dedupes permissions and notifies once the row is written", async () => {
    pg.queueRows([{ email: "dana@example.com", displayName: "Dana" }]); // name lookup
    pg.queueRows([row({ permissions: ["resources:delete"] })]);

    const result = await breakGlass.createAccessRequest(
      {
        organizationId: "org1",
        userId: "requester",
        permissions: ["resources:delete", " resources:delete ", ""],
        reason: "Restoring prod from last night's snapshot — INC-4417",
        durationMinutes: 60,
      },
      ["resources:read"],
    );

    expect(result.outcome).toBe("created");
    // The jsonb parameter in the rendered INSERT carries the deduped set.
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]!.params).toContain(JSON.stringify(["resources:delete"]));
    expect(fanOut).toHaveBeenCalledTimes(1);
  });
});

describe("decideAccessRequest", () => {
  const decider = {
    userId: "approver",
    name: "Sam",
    permissions: ["resources:read", "resources:delete", "access:approve"],
  };

  it("refuses to let the requester decide their own request", async () => {
    pg.queueRows([row({ userId: "approver" })]);
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result.outcome).toBe("self_approval");
    expect(updates()).toEqual([]);
  });

  it("refuses self-decision on a denial too", async () => {
    // Withdrawal is its own operation with its own audit action; routing it
    // through the approval path would blur "nobody would approve this" into
    // "they changed their mind".
    pg.queueRows([row({ userId: "approver" })]);
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "denied", decider);
    expect(result.outcome).toBe("self_approval");
  });

  it("refuses to grant a permission the approver does not hold", async () => {
    pg.queueRows([row({ permissions: ["billing:write"] })]);
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result).toMatchObject({ outcome: "exceeds_approver", missing: ["billing:write"] });
    expect(updates()).toEqual([]);
  });

  it("allows denying a request aimed higher than the approver", async () => {
    // Refusing this would strand over-ambitious requests forever.
    pg.queueRows([row({ permissions: ["billing:write"] })]);
    pg.queueRows([row({ status: "denied", permissions: ["billing:write"] })]);
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "denied", decider);
    expect(result.outcome).toBe("decided");
  });

  it("opens the grant window on approval", async () => {
    pg.queueRows([row()]);
    pg.queueRows([
      row({
        status: "approved",
        grantedAt: new Date(),
        grantExpiresAt: new Date(Date.now() + 60 * 60_000),
      }),
    ]);

    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result.outcome).toBe("decided");
    const update = updates()[0]!;
    // set "status" = $1, "decided_at" = $2, "decided_by_user_id" = $3,
    // "decided_by_name" = $4, "decision_note" = $5, "granted_at" = $6,
    // "grant_expires_at" = $7 — timestamps render as ISO parameters. (The SET
    // clause is the assertion target; RETURNING names every column.)
    expect(update.sql.split(" where ")[0]).toContain('"granted_at"');
    const granted = new Date(update.params[5] as string);
    const expires = new Date(update.params[6] as string);
    expect(expires.getTime() - granted.getTime()).toBe(60 * 60_000);
  });

  it("does not open a window on denial", async () => {
    pg.queueRows([row()]);
    pg.queueRows([row({ status: "denied" })]);
    await breakGlass.decideAccessRequest("org1", "req-1", "denied", decider);
    expect(updates()[0]!.sql.split(" where ")[0]).not.toContain('"granted_at"');
  });

  it("treats a decision after the request timed out as a conflict", async () => {
    // The request was already dead. Pretending otherwise would open a window
    // nobody agreed to.
    pg.queueRows([row({ expiresAt: new Date(Date.now() - 60_000) })]);
    pg.queueRows([row({ status: "expired" })]); // the expiry UPDATE
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result.outcome).toBe("conflict");
  });

  it("reports a conflict when someone else decided first", async () => {
    pg.queueRows([row()]);
    pg.queueRows([]); // the conditional UPDATE matched nothing
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result.outcome).toBe("conflict");
  });

  it("is not found when the row belongs to another org", async () => {
    pg.queueRows([]);
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result.outcome).toBe("not_found");
  });
});

describe("activeElevations", () => {
  it("returns a grant inside its window", async () => {
    const now = new Date();
    pg.queueRows([
      row({
        status: "approved",
        grantedAt: new Date(now.getTime() - 60_000),
        grantExpiresAt: new Date(now.getTime() + 60_000),
      }),
    ]);
    const out = await breakGlass.activeElevations("org1", "requester", now);
    expect(out).toHaveLength(1);
    expect(out[0]?.permissions).toEqual(["resources:delete"]);
  });

  it("ignores a revoked grant even inside its window", async () => {
    const now = new Date();
    pg.queueRows([
      row({
        status: "approved",
        grantedAt: new Date(now.getTime() - 60_000),
        grantExpiresAt: new Date(now.getTime() + 60_000),
        revokedAt: new Date(now.getTime() - 1000),
      }),
    ]);
    expect(await breakGlass.activeElevations("org1", "requester", now)).toEqual([]);
  });

  it("ignores a lapsed grant", async () => {
    // The window is evaluated, never swept — a grant stops applying the instant
    // it lapses rather than whenever a job next runs.
    const now = new Date();
    pg.queueRows([
      row({
        status: "approved",
        grantedAt: new Date(now.getTime() - 120_000),
        grantExpiresAt: new Date(now.getTime() - 1000),
      }),
    ]);
    expect(await breakGlass.activeElevations("org1", "requester", now)).toEqual([]);
  });

  it("fails closed when the read throws", async () => {
    // Granting authority on a database hiccup is the one outcome this feature
    // must never produce. A row the recording driver cannot decode makes the
    // select itself reject — the closest a canned driver gets to a lost
    // connection.
    pg.queueRows([null as never]);
    expect(await breakGlass.activeElevations("org1", "requester")).toEqual([]);
  });
});

describe("revokeAccessGrant", () => {
  it("ends a live grant", async () => {
    const now = Date.now();
    pg.queueRows([
      row({
        status: "approved",
        grantedAt: new Date(now - 60_000),
        grantExpiresAt: new Date(now + 60_000),
      }),
    ]);
    pg.queueRows([
      row({
        status: "approved",
        grantedAt: new Date(now - 60_000),
        grantExpiresAt: new Date(now + 60_000),
        revokedAt: new Date(),
      }),
    ]);
    const result = await breakGlass.revokeAccessGrant("org1", "req-1", { userId: "approver" });
    expect(result.outcome).toBe("revoked");
  });

  it("refuses to revoke something that is not live", async () => {
    pg.queueRows([row({ status: "denied" })]);
    const result = await breakGlass.revokeAccessGrant("org1", "req-1", { userId: "approver" });
    expect(result.outcome).toBe("not_active");
  });

  it("reports not_active when another revoker won the race", async () => {
    const now = Date.now();
    pg.queueRows([
      row({
        status: "approved",
        grantedAt: new Date(now - 60_000),
        grantExpiresAt: new Date(now + 60_000),
      }),
    ]);
    pg.queueRows([]); // conditional UPDATE matched nothing
    const result = await breakGlass.revokeAccessGrant("org1", "req-1", { userId: "approver" });
    expect(result.outcome).toBe("not_active");
  });
});

describe("withdrawAccessRequest", () => {
  it("lets the requester call off their own pending request", async () => {
    pg.queueRows([{ id: "req-1", userId: "requester" }]);
    pg.queueRows([{ id: "req-1" }]);
    const result = await breakGlass.withdrawAccessRequest("org1", "req-1", "requester");
    expect(result.outcome).toBe("withdrawn");
    // The decision-note parameter of the rendered UPDATE names the withdrawal.
    expect(updates()[0]!.params.some((p) => typeof p === "string" && /withdrawn/i.test(p))).toBe(
      true,
    );
  });

  it("hides someone else's request behind a 404 rather than a 403", async () => {
    pg.queueRows([{ id: "req-1", userId: "someone-else" }]);
    const result = await breakGlass.withdrawAccessRequest("org1", "req-1", "requester");
    expect(result.outcome).toBe("not_found");
  });
});
