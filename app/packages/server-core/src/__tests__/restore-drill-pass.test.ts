import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The automatic restore drill pass, one step at a time: real Drizzle over a
 * recording driver (so the writes are asserted as Postgres would receive
 * them), with the plugin client, the SQL driver and alert routing mocked at
 * their module boundaries. Nothing here reaches a provider or a database.
 */
import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const client = {
  startRestoreDrill: vi.fn(),
  checkRestoreDrill: vi.fn(),
  endRestoreDrill: vi.fn(),
};
const plugin = { manifest: { id: "neon", restoreDrill: { copyNoun: "branch" } } };
vi.mock("../org-accounts", () => ({
  getOrgAccountClient: vi.fn(async () => ({ client, plugin, credentials: {} })),
}));
vi.mock("../plugin-loader", () => ({ getPlugin: vi.fn(async () => ({ plugin })) }));

const query = vi.fn();
vi.mock("../drivers", () => ({
  sqlDrivers: new Map([["postgres", { id: "postgres", query: (...a: unknown[]) => query(...a) }]]),
}));
vi.mock("../egress-guard", () => ({ guardDriverConnection: vi.fn(async () => {}) }));

const routeAlert = vi.fn(async () => ({}));
vi.mock("../alerts/route", () => ({ routeAlert: (...a: unknown[]) => routeAlert(...a) }));

const { advanceDrillRun, runRestoreDrillPass } = await import("../backups/drill-pass");

type Run = Parameters<typeof advanceDrillRun>[0];

const STARTED = new Date("2026-11-18T10:00:00.000Z");

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    organizationId: "org1",
    scheduleId: "sched1",
    accountId: "acct1",
    resourceId: "acct1:neon-branch:p/br",
    resourceTypeId: "neon-branch",
    trigger: "schedule",
    state: "restoring",
    outcome: null,
    restorePoint: "point-in-time",
    pointInTimeAt: new Date("2026-11-18T08:00:00.000Z"),
    verifySql: "SELECT count(*) FROM orders",
    verifyMode: "scalar",
    verifyOperator: "gt",
    verifyThreshold: 0,
    copyName: "iw-drill-111111112222",
    copyRef: "p/br-drill",
    restoredFrom: "branch br at 2026-11-18T08:00:00.000Z",
    restorePointAt: new Date("2026-11-18T08:00:00.000Z"),
    startedAt: STARTED,
    deadlineAt: new Date(STARTED.getTime() + 60 * 60_000),
    readyAt: null,
    finishedAt: null,
    restoreSeconds: null,
    verifyValue: null,
    detail: null,
    cleanupState: "pending",
    cleanupError: null,
    cleanupAttempts: 0,
    cleanupAlerted: false,
    restoreDrillId: null,
    nextStepAt: STARTED,
    leaseUntil: null,
    createdByUserId: null,
    ...overrides,
  };
}

const writes = (table: string) =>
  pg.queries.filter(
    (q) => q.sql.startsWith(`insert into "${table}"`) || q.sql.startsWith(`update "${table}"`),
  );
const drillInsert = () => pg.queries.find((q) => q.sql.startsWith('insert into "restore_drills"'));

beforeEach(() => {
  vi.clearAllMocks();
  pg.reset();
  pg.setRows([]);
});

describe("advanceDrillRun", () => {
  it("records a checked restore with its restore time and restore point age, then deletes the copy", async () => {
    client.checkRestoreDrill.mockResolvedValue({
      state: "ready",
      connection: { driver: "postgres", connectionString: "postgresql://u:p@h.example.test/db" },
    });
    query.mockResolvedValue([{ count: "42" }]);
    client.endRestoreDrill.mockResolvedValue(undefined);

    const now = new Date(STARTED.getTime() + 150_000);
    await advanceDrillRun(run(), false, now);

    const insert = drillInsert();
    expect(insert).toBeDefined();
    // outcome, RTO (150 s rounds up to 3 minutes), RPO (2 hours).
    expect(insert!.params).toEqual(expect.arrayContaining(["verified", 3, 120]));
    expect(query).toHaveBeenCalledWith(
      "postgresql://u:p@h.example.test/db",
      "SELECT count(*) FROM orders",
      undefined,
    );
    expect(client.endRestoreDrill).toHaveBeenCalledWith("p/br-drill", "acct1");
    const last = writes("restore_drill_runs").at(-1)!;
    expect(last.params).toEqual(expect.arrayContaining(["done", "done"]));
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("fails a restore whose check does not hold, alerts, and still deletes the copy", async () => {
    client.checkRestoreDrill.mockResolvedValue({
      state: "ready",
      connection: { driver: "postgres", connectionString: "postgresql://u:p@h.example.test/db" },
    });
    query.mockResolvedValue([{ count: 0 }]);
    client.endRestoreDrill.mockResolvedValue(undefined);

    await advanceDrillRun(run(), false, new Date(STARTED.getTime() + 60_000));

    expect(drillInsert()!.params).toEqual(expect.arrayContaining(["failed"]));
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "restoreDrillAlerts", severity: "warning" }),
    );
    expect(client.endRestoreDrill).toHaveBeenCalled();
  });

  it("never runs a check that is not read-only", async () => {
    client.checkRestoreDrill.mockResolvedValue({
      state: "ready",
      connection: { driver: "postgres", connectionString: "postgresql://u:p@h.example.test/db" },
    });
    client.endRestoreDrill.mockResolvedValue(undefined);

    await advanceDrillRun(
      run({ verifySql: "DELETE FROM orders" }),
      false,
      new Date(STARTED.getTime() + 60_000),
    );

    expect(query).not.toHaveBeenCalled();
    expect(drillInsert()!.params).toEqual(expect.arrayContaining(["failed"]));
  });

  it("records a restore without a check as not checked", async () => {
    client.checkRestoreDrill.mockResolvedValue({
      state: "ready",
      connection: { driver: "postgres", connectionString: "postgresql://u:p@h.example.test/db" },
    });
    client.endRestoreDrill.mockResolvedValue(undefined);

    await advanceDrillRun(run({ verifySql: null }), false, new Date(STARTED.getTime() + 60_000));

    expect(drillInsert()!.params).toEqual(expect.arrayContaining(["restored-unverified"]));
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps waiting while the copy comes up", async () => {
    client.checkRestoreDrill.mockResolvedValue({ state: "pending", detail: "Branch is init." });

    await advanceDrillRun(run(), false, new Date(STARTED.getTime() + 60_000));

    expect(drillInsert()).toBeUndefined();
    expect(client.endRestoreDrill).not.toHaveBeenCalled();
  });

  it("fails at the time limit without asking the provider again, and deletes the copy", async () => {
    client.endRestoreDrill.mockResolvedValue(undefined);

    await advanceDrillRun(run(), false, new Date(STARTED.getTime() + 61 * 60_000));

    expect(client.checkRestoreDrill).not.toHaveBeenCalled();
    expect(drillInsert()!.params).toEqual(expect.arrayContaining(["failed"]));
    expect(client.endRestoreDrill).toHaveBeenCalledWith("p/br-drill", "acct1");
  });

  it("retries a failed delete and raises it as critical after three attempts", async () => {
    client.endRestoreDrill.mockRejectedValue(new Error("provider said no"));

    await advanceDrillRun(
      run({ state: "cleaning", outcome: "verified", cleanupAttempts: 2 }),
      false,
      STARTED,
    );

    const update = writes("restore_drill_runs")[0]!;
    expect(update.params).toEqual(expect.arrayContaining(["failed", "provider said no", 3]));
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "restoreDrillAlerts", severity: "critical" }),
    );
  });

  it("does not start a second copy when a start was interrupted", async () => {
    await advanceDrillRun(
      run({ state: "starting", copyRef: null, cleanupState: "pending" }),
      true,
      STARTED,
    );

    expect(client.startRestoreDrill).not.toHaveBeenCalled();
    expect(drillInsert()!.params).toEqual(expect.arrayContaining(["failed"]));
    expect(routeAlert).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
  });

  it("starts a copy from the schedule's point in time", async () => {
    client.startRestoreDrill.mockResolvedValue({
      ref: "p/br-drill",
      restoredFrom: "branch br",
      restorePointAt: "2026-11-18T08:00:00.000Z",
    });

    await advanceDrillRun(
      run({ state: "starting", copyRef: null, cleanupState: "none" }),
      false,
      STARTED,
    );

    expect(client.startRestoreDrill).toHaveBeenCalledWith({
      resourceTypeId: "neon-branch",
      resourceId: "acct1:neon-branch:p/br",
      accountId: "acct1",
      restorePoint: { kind: "point-in-time", at: "2026-11-18T08:00:00.000Z" },
      copyName: "iw-drill-111111112222",
    });
    // Marked as possibly holding a copy before the provider is asked.
    const [mark, saved] = writes("restore_drill_runs");
    expect(mark!.params).toContain("pending");
    expect(saved!.params).toEqual(expect.arrayContaining(["restoring", "p/br-drill"]));
  });
});

describe("runRestoreDrillPass", () => {
  it("queues due schedules without a run in flight, and claims runs with a lease", async () => {
    const result = await runRestoreDrillPass();
    expect(result).toEqual({ queued: 0, stepped: 0 });
    const [queue, claim] = pg.queries;
    expect(queue!.sql).toContain('update "restore_drill_schedules"');
    expect(queue!.sql).toContain("for update skip locked");
    expect(queue!.sql).toContain("NOT EXISTS");
    expect(queue!.sql).toContain("make_interval(days =>");
    expect(claim!.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim!.sql).toContain("lease_until IS NULL OR lease_until < now()");
  });
});
