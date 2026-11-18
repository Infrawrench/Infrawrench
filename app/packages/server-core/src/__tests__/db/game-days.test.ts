/**
 * The game-day pass against a real Postgres: inject at the start, undo at the
 * time limit, abort, a restart mid-injection, a change freeze at the start, an
 * undo that keeps failing, and the alerts `routeAlert` records while one runs.
 *
 * The plugin calls are faked (`../../game-days/actions`), so nothing reaches a
 * provider; everything else (the claim, the conditional state changes, the
 * undo state written before the inject) runs as it does in production.
 *
 * Skipped unless DATABASE_URL is set, migrations applied, scratch databases
 * only: it writes an organization and its game days, and deletes them after.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const configured = !!process.env["DATABASE_URL"];

const calls: string[] = [];
const behaviour = {
  alreadyInEffect: false,
  undoFails: false,
};

vi.mock("../../game-days/actions", () => ({
  prepareFailureTarget: async (t: { resourceId: string }) => {
    calls.push(`prepare ${t.resourceId}`);
    return {
      undo: { replicas: 3 },
      alreadyInEffect: behaviour.alreadyInEffect,
      currentState: "3 replicas",
    };
  },
  injectFailureTarget: async (t: { resourceId: string }) => {
    calls.push(`inject ${t.resourceId}`);
  },
  undoFailureTarget: async (t: { resourceId: string }, undo: Record<string, unknown>) => {
    calls.push(`undo ${t.resourceId} ${JSON.stringify(undo)}`);
    if (behaviour.undoFails) throw new Error("provider said no");
  },
  failureActionsFor: async () => [],
  resourceTypeFor: async () => null,
}));

const orgId = `test-org-${randomUUID()}`;

describe.skipIf(!configured)("game days, against a real Postgres", () => {
  async function modules() {
    const { db } = await import("../../db/client");
    const schema = await import("../../db/schema");
    const pass = await import("../../game-days/pass");
    const store = await import("../../game-days/store");
    const signals = await import("../../game-days/signals");
    const { eq } = await import("drizzle-orm");
    return { db, schema, pass, store, signals, eq };
  }

  /** A game day straight into the table, so each test starts in the state it is about. */
  async function insertGameDay(values: {
    status: "armed" | "injecting" | "running";
    startsAt?: Date;
    endsAt?: Date | null;
    targetState?: "pending" | "injecting" | "injected";
  }): Promise<string> {
    const { db, schema } = await modules();
    const id = randomUUID();
    const now = new Date();
    await db.insert(schema.gameDays).values({
      id,
      organizationId: orgId,
      name: `game day ${id.slice(0, 6)}`,
      status: values.status,
      startsAt: values.startsAt ?? new Date(now.getTime() - 1000),
      durationMinutes: 15,
      recoveryTimeoutMinutes: 30,
      injectedAt: values.status === "armed" ? null : now,
      endsAt: values.endsAt ?? null,
      relatedResourceIds: ["res-a"],
      nextCheckAt: new Date(now.getTime() - 1000),
    });
    await db.insert(schema.gameDayTargets).values({
      id: randomUUID(),
      gameDayId: id,
      organizationId: orgId,
      position: 0,
      resourceId: "res-a",
      accountId: "acct-1",
      pluginId: "kubernetes",
      resourceTypeId: "k8s-deployment",
      displayName: "checkout",
      actionId: "scale-to-zero",
      actionLabel: "Scale to zero replicas",
      undoLabel: "Scale back",
      state: values.targetState ?? "pending",
      undoState: values.targetState && values.targetState !== "pending" ? { replicas: 3 } : null,
    });
    return id;
  }

  async function read(id: string) {
    const { db, schema, eq } = await modules();
    const [row] = await db.select().from(schema.gameDays).where(eq(schema.gameDays.id, id));
    const targets = await db
      .select()
      .from(schema.gameDayTargets)
      .where(eq(schema.gameDayTargets.gameDayId, id));
    return { row: row!, targets };
  }

  /** Run the pass until this game day is not due any more (or a few rounds). */
  async function drive(id: string) {
    const { db, schema, pass, eq } = await modules();
    for (let i = 0; i < 6; i += 1) {
      await db
        .update(schema.gameDays)
        .set({ nextCheckAt: new Date(Date.now() - 1000) })
        .where(eq(schema.gameDays.id, id));
      await pass.runGameDayPass({ limit: 50 });
      const { row } = await read(id);
      if (row.status === "completed" || row.status === "cancelled" || row.status === "undo_failed")
        return;
    }
  }

  beforeEach(() => {
    calls.length = 0;
    behaviour.alreadyInEffect = false;
    behaviour.undoFails = false;
  });

  afterAll(async () => {
    if (!configured) return;
    const { db, schema, eq } = await modules();
    await db.delete(schema.changeFreezes).where(eq(schema.changeFreezes.organizationId, orgId));
    await db.delete(schema.gameDays).where(eq(schema.gameDays.organizationId, orgId));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    await db.$client.end();
  });

  it("sets up an organization", async () => {
    const { db, schema } = await modules();
    await db.insert(schema.organizations).values({ id: orgId, displayName: "Game day test" });
  });

  it("injects at the start, storing the undo state first, and runs to the time limit", async () => {
    const { pass } = await modules();
    const id = await insertGameDay({ status: "armed" });
    await pass.runGameDayPass({ limit: 50 });
    const { row, targets } = await read(id);
    expect(row.status).toBe("running");
    expect(row.injectedAt).not.toBeNull();
    expect(row.endsAt!.getTime() - row.injectedAt!.getTime()).toBe(15 * 60_000);
    expect(targets[0]!.state).toBe("injected");
    expect(targets[0]!.undoState).toEqual({ replicas: 3 });
    expect(calls).toEqual(["prepare res-a", "inject res-a"]);
  });

  it("undoes at the time limit and completes without probes to wait for", async () => {
    const id = await insertGameDay({
      status: "running",
      endsAt: new Date(Date.now() - 1000),
      targetState: "injected",
    });
    await drive(id);
    const { row, targets } = await read(id);
    expect(row.status).toBe("completed");
    expect(row.endReason).toBe("time_limit");
    expect(row.undoneAt).not.toBeNull();
    expect(targets[0]!.state).toBe("reverted");
    expect(calls).toEqual(['undo res-a {"replicas":3}']);
  });

  it("aborts a running game day on the next pass", async () => {
    const { store } = await modules();
    const id = await insertGameDay({
      status: "running",
      endsAt: new Date(Date.now() + 3600_000),
      targetState: "injected",
    });
    await store.requestGameDayEnd(orgId, id, null, "aborted");
    await drive(id);
    const { row } = await read(id);
    expect(row.status).toBe("completed");
    expect(row.endReason).toBe("aborted");
    expect(calls).toEqual(['undo res-a {"replicas":3}']);
  });

  it("reverts, never resumes, a game day found mid-injection", async () => {
    const id = await insertGameDay({ status: "injecting", targetState: "injecting" });
    await drive(id);
    const { row } = await read(id);
    expect(row.endReason).toBe("interrupted");
    expect(row.status).toBe("completed");
    expect(calls).toEqual(['undo res-a {"replicas":3}']);
  });

  it("leaves a target already in that state alone", async () => {
    behaviour.alreadyInEffect = true;
    const id = await insertGameDay({ status: "armed" });
    const { pass } = await modules();
    await pass.runGameDayPass({ limit: 50 });
    const { targets } = await read(id);
    expect(targets[0]!.state).toBe("skipped");
    expect(calls).toEqual(["prepare res-a"]);
  });

  it("parks a game day whose undo keeps failing as undo_failed", async () => {
    behaviour.undoFails = true;
    const { db, schema, pass, eq } = await modules();
    const id = await insertGameDay({
      status: "running",
      endsAt: new Date(Date.now() - 1000),
      targetState: "injected",
    });
    for (let i = 0; i < 12; i += 1) {
      await db
        .update(schema.gameDays)
        .set({ nextCheckAt: new Date(Date.now() - 1000) })
        .where(eq(schema.gameDays.id, id));
      await pass.runGameDayPass({ limit: 50 });
    }
    const { row, targets } = await read(id);
    expect(row.status).toBe("undo_failed");
    expect(targets[0]!.state).toBe("undo_failed");
    expect(targets[0]!.attempts).toBe(10);
    expect(row.lastError).toMatch(/provider said no/);
  });

  it("does not start while somebody else's change freeze is in effect", async () => {
    const { db, schema, pass } = await modules();
    const freezeId = randomUUID();
    await db.insert(schema.changeFreezes).values({
      id: freezeId,
      organizationId: orgId,
      name: "Quarter end",
      startsAt: new Date(Date.now() - 60_000),
      active: true,
    });
    const id = await insertGameDay({ status: "armed" });
    await pass.runGameDayPass({ limit: 50 });
    const { row } = await read(id);
    expect(row.status).toBe("cancelled");
    expect(row.endReason).toBe("freeze");
    expect(calls).toEqual([]);
    const { eq } = await modules();
    await db.delete(schema.changeFreezes).where(eq(schema.changeFreezes.id, freezeId));
  });

  it("records alerts sent while it runs and reads them back as signals", async () => {
    const { signals } = await modules();
    const id = await insertGameDay({
      status: "running",
      endsAt: new Date(Date.now() + 3600_000),
      targetState: "injected",
    });
    const at = new Date();
    await signals.recordGameDayAlert({
      organizationId: orgId,
      trigger: "metricAlerts",
      severity: "critical",
      title: "CPU on checkout",
      resourceId: "res-a",
      lifecycleKey: undefined,
      destinationKinds: ["on-call"],
      unrouted: false,
      deliveryIds: [],
      at,
    });
    await signals.recordGameDayAlert({
      organizationId: orgId,
      trigger: "costAnomalies",
      severity: "warning",
      title: "Spend jumped",
      resourceId: "res-elsewhere",
      lifecycleKey: undefined,
      destinationKinds: ["slack"],
      unrouted: false,
      deliveryIds: [],
      at,
    });
    const { row } = await read(id);
    const observed = await signals.sampleGameDaySignals({
      id,
      organizationId: orgId,
      serviceId: null,
      injectedAt: row.injectedAt!,
      watchedProbeIds: [],
      watchedSloIds: [],
      relatedResourceIds: ["res-a"],
    });
    expect(observed.alertedAt).toBe(at.toISOString());
    expect(observed.pagedAt).toBe(at.toISOString());
    const detail = await (await modules()).store.getGameDayDetail(orgId, id);
    expect(detail!.alerts.map((a) => [a.title, a.related, a.paged])).toEqual(
      expect.arrayContaining([
        ["CPU on checkout", true, true],
        ["Spend jumped", false, false],
      ]),
    );
  });
});
