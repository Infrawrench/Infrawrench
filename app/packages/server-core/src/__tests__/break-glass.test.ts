import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three rules that make break-glass safe are the point of this suite:
 * you cannot approve your own request, you cannot grant what you do not hold,
 * and the window is evaluated rather than swept. Everything else here is
 * plumbing.
 *
 * The Drizzle chains are scripted the same way the resolver suite does it:
 * `.where()` is a thenable that also carries `.limit()`, and each terminal
 * await pulls the next queued result.
 */
const selectResults: unknown[][] = [];
const returningResults: unknown[][] = [];
let lastUpdateSet: Record<string, unknown> | undefined;
let lastInsertValues: Record<string, unknown> | undefined;

function nextRows(queue: unknown[][]): unknown[] {
  return queue.shift() ?? [];
}

function whereThenable() {
  const rows = nextRows(selectResults);
  const p = Promise.resolve(rows) as Promise<unknown[]> & {
    limit: (n: number) => Promise<unknown[]>;
  };
  p.limit = () => Promise.resolve(rows);
  return p;
}

const dbSelect = vi.fn(() => ({
  from: () => ({ where: () => whereThenable() }),
}));

const dbInsert = vi.fn(() => ({
  values: (v: Record<string, unknown>) => {
    lastInsertValues = v;
    return { returning: async () => nextRows(returningResults) };
  },
}));

const dbUpdate = vi.fn(() => ({
  set: (v: Record<string, unknown>) => {
    lastUpdateSet = v;
    return { where: () => ({ returning: async () => nextRows(returningResults) }) };
  },
}));

vi.mock("../db/client", () => ({
  db: { select: dbSelect, insert: dbInsert, update: dbUpdate },
}));
vi.mock("../db/schema", () => ({
  accessRequests: {
    id: "ar.id",
    organizationId: "ar.organizationId",
    userId: "ar.userId",
    status: "ar.status",
    revokedAt: "ar.revokedAt",
    grantExpiresAt: "ar.grantExpiresAt",
    expiresAt: "ar.expiresAt",
    createdAt: "ar.createdAt",
  },
  users: { id: "u.id", email: "u.email", displayName: "u.displayName" },
}));

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

/** A stored row with sensible defaults; override what a test cares about. */
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
  selectResults.length = 0;
  returningResults.length = 0;
  lastUpdateSet = undefined;
  lastInsertValues = undefined;
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
    expect(dbInsert).not.toHaveBeenCalled();
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
    selectResults.push([{ email: "dana@example.com", displayName: "Dana" }]); // name lookup
    returningResults.push([row({ permissions: ["resources:delete"] })]);

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
    expect(lastInsertValues?.["permissions"]).toEqual(["resources:delete"]);
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
    selectResults.push([row({ userId: "approver" })]);
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result.outcome).toBe("self_approval");
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("refuses self-decision on a denial too", async () => {
    // Withdrawal is its own operation with its own audit action; routing it
    // through the approval path would blur "nobody would approve this" into
    // "they changed their mind".
    selectResults.push([row({ userId: "approver" })]);
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "denied", decider);
    expect(result.outcome).toBe("self_approval");
  });

  it("refuses to grant a permission the approver does not hold", async () => {
    selectResults.push([row({ permissions: ["billing:write"] })]);
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result).toMatchObject({ outcome: "exceeds_approver", missing: ["billing:write"] });
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("allows denying a request aimed higher than the approver", async () => {
    // Refusing this would strand over-ambitious requests forever.
    selectResults.push([row({ permissions: ["billing:write"] })]);
    returningResults.push([row({ status: "denied", permissions: ["billing:write"] })]);
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "denied", decider);
    expect(result.outcome).toBe("decided");
  });

  it("opens the grant window on approval", async () => {
    selectResults.push([row()]);
    returningResults.push([
      row({
        status: "approved",
        grantedAt: new Date(),
        grantExpiresAt: new Date(Date.now() + 60 * 60_000),
      }),
    ]);

    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result.outcome).toBe("decided");
    expect(lastUpdateSet?.["grantedAt"]).toBeInstanceOf(Date);
    const granted = lastUpdateSet?.["grantedAt"] as Date;
    const expires = lastUpdateSet?.["grantExpiresAt"] as Date;
    expect(expires.getTime() - granted.getTime()).toBe(60 * 60_000);
  });

  it("does not open a window on denial", async () => {
    selectResults.push([row()]);
    returningResults.push([row({ status: "denied" })]);
    await breakGlass.decideAccessRequest("org1", "req-1", "denied", decider);
    expect(lastUpdateSet).not.toHaveProperty("grantedAt");
  });

  it("treats a decision after the request timed out as a conflict", async () => {
    // The request was already dead. Pretending otherwise would open a window
    // nobody agreed to.
    selectResults.push([row({ expiresAt: new Date(Date.now() - 60_000) })]);
    returningResults.push([row({ status: "expired" })]); // the expiry UPDATE
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result.outcome).toBe("conflict");
  });

  it("reports a conflict when someone else decided first", async () => {
    selectResults.push([row()]);
    returningResults.push([]); // the conditional UPDATE matched nothing
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result.outcome).toBe("conflict");
  });

  it("is not found when the row belongs to another org", async () => {
    selectResults.push([]);
    const result = await breakGlass.decideAccessRequest("org1", "req-1", "approved", decider);
    expect(result.outcome).toBe("not_found");
  });
});

describe("activeElevations", () => {
  it("returns a grant inside its window", async () => {
    const now = new Date();
    selectResults.push([
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
    selectResults.push([
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
    selectResults.push([
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
    // must never produce.
    dbSelect.mockImplementationOnce(() => {
      throw new Error("connection reset");
    });
    expect(await breakGlass.activeElevations("org1", "requester")).toEqual([]);
  });
});

describe("revokeAccessGrant", () => {
  it("ends a live grant", async () => {
    const now = Date.now();
    selectResults.push([
      row({
        status: "approved",
        grantedAt: new Date(now - 60_000),
        grantExpiresAt: new Date(now + 60_000),
      }),
    ]);
    returningResults.push([
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
    selectResults.push([row({ status: "denied" })]);
    const result = await breakGlass.revokeAccessGrant("org1", "req-1", { userId: "approver" });
    expect(result.outcome).toBe("not_active");
  });

  it("reports not_active when another revoker won the race", async () => {
    const now = Date.now();
    selectResults.push([
      row({
        status: "approved",
        grantedAt: new Date(now - 60_000),
        grantExpiresAt: new Date(now + 60_000),
      }),
    ]);
    returningResults.push([]); // conditional UPDATE matched nothing
    const result = await breakGlass.revokeAccessGrant("org1", "req-1", { userId: "approver" });
    expect(result.outcome).toBe("not_active");
  });
});

describe("withdrawAccessRequest", () => {
  it("lets the requester call off their own pending request", async () => {
    selectResults.push([{ id: "req-1", userId: "requester" }]);
    returningResults.push([{ id: "req-1" }]);
    const result = await breakGlass.withdrawAccessRequest("org1", "req-1", "requester");
    expect(result.outcome).toBe("withdrawn");
    expect(lastUpdateSet?.["decisionNote"]).toMatch(/withdrawn/i);
  });

  it("hides someone else's request behind a 404 rather than a 403", async () => {
    selectResults.push([{ id: "req-1", userId: "someone-else" }]);
    const result = await breakGlass.withdrawAccessRequest("org1", "req-1", "requester");
    expect(result.outcome).toBe("not_found");
  });
});
