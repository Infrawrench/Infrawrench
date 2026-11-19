import { describe, expect, it, vi } from "vitest";

// The state machine a ping drives, as a pure function over the row: no
// database, no alert delivery.
vi.mock("../db/client", () => ({ db: {} }));
vi.mock("../heartbeats/notify", () => ({
  notifyHeartbeatDown: vi.fn(),
  notifyHeartbeatRecovered: vi.fn(),
}));

const { applyPing } = await import("../heartbeats/ping");
const { generatePingToken, isPingTokenShape } = await import("../heartbeats/store");
type Row = Parameters<typeof applyPing>[0];

const at = (iso: string) => new Date(iso);
const row = (over: Partial<Row> = {}): Row => ({
  id: "h1",
  organizationId: "org-1",
  name: "Nightly backup",
  scheduleKind: "cron",
  cronExpression: "0 2 * * *",
  timezone: "UTC",
  intervalMinutes: null,
  graceMinutes: 30,
  enabled: true,
  pingToken: "t",
  status: "up",
  downReason: null,
  lastPingAt: at("2026-11-17T02:05:00Z"),
  lastStartAt: null,
  lastFailAt: null,
  lastDurationMs: null,
  nextExpectedAt: null,
  deadlineAt: null,
  lastStateChangeAt: null,
  pingWindowStart: null,
  pingWindowCount: 1,
  accountId: null,
  resourceId: null,
  pluginId: null,
  resourceTypeId: null,
  fieldKey: null,
  createdByUserId: null,
  createdAt: at("2026-11-01T00:00:00Z"),
  updatedAt: at("2026-11-01T00:00:00Z"),
  ...over,
});

describe("applyPing", () => {
  it("sets the next deadline from the schedule plus grace on success", () => {
    const { set, transition } = applyPing(row(), "success", at("2026-11-18T02:04:00Z"), null);
    expect(set.status).toBe("up");
    expect(set.nextExpectedAt?.toISOString()).toBe("2026-11-19T02:00:00.000Z");
    expect(set.deadlineAt?.toISOString()).toBe("2026-11-19T02:30:00.000Z");
    expect(transition).toBeNull();
  });

  it("takes a new heartbeat up on its first ping without announcing it", () => {
    const { set, transition } = applyPing(
      row({ status: "new", lastPingAt: null }),
      "success",
      at("2026-11-18T02:04:00Z"),
      null,
    );
    expect(set.status).toBe("up");
    expect(set.lastStateChangeAt).toBeDefined();
    expect(transition).toBeNull();
  });

  it("measures the run from its start ping", () => {
    const { durationMs, set } = applyPing(
      row({ lastStartAt: at("2026-11-18T02:00:00Z") }),
      "success",
      at("2026-11-18T02:04:00Z"),
      null,
    );
    expect(durationMs).toBe(240_000);
    expect(set.lastDurationMs).toBe(240_000);
  });

  it("does not pair a ping with a start that an earlier ping already closed", () => {
    const { durationMs } = applyPing(
      row({ lastStartAt: at("2026-11-17T02:00:00Z") }),
      "success",
      at("2026-11-18T02:04:00Z"),
      null,
    );
    expect(durationMs).toBeNull();
  });

  it("records a start without touching state", () => {
    const { set, transition } = applyPing(row(), "start", at("2026-11-18T02:00:00Z"), null);
    expect(set).toEqual({
      updatedAt: at("2026-11-18T02:00:00Z"),
      lastStartAt: at("2026-11-18T02:00:00Z"),
    });
    expect(transition).toBeNull();
  });

  it("goes down on a failure and announces it once", () => {
    const first = applyPing(row(), "fail", at("2026-11-18T02:04:00Z"), "disk full");
    expect(first.set).toMatchObject({ status: "down", downReason: "failed", deadlineAt: null });
    expect(first.transition).toMatchObject({ kind: "down", detail: "disk full" });
    const again = applyPing(
      row({ status: "down", downReason: "failed" }),
      "fail",
      at("2026-11-19T02:04:00Z"),
      null,
    );
    expect(again.transition).toBeNull();
  });

  it("announces a recovery when a down heartbeat pings", () => {
    const { set, transition } = applyPing(
      row({ status: "down", downReason: "missed" }),
      "success",
      at("2026-11-18T02:04:00Z"),
      null,
    );
    expect(set).toMatchObject({ status: "up", downReason: null });
    expect(transition?.kind).toBe("recovered");
  });

  it("keeps a paused heartbeat's history and nothing else", () => {
    const { set, transition } = applyPing(
      row({ enabled: false }),
      "fail",
      at("2026-11-18T02:04:00Z"),
      null,
    );
    expect(set.status).toBeUndefined();
    expect(set.deadlineAt).toBeUndefined();
    expect(set.lastPingAt).toEqual(at("2026-11-18T02:04:00Z"));
    expect(transition).toBeNull();
  });

  it("uses an interval schedule's minutes", () => {
    const { set } = applyPing(
      row({ scheduleKind: "interval", cronExpression: null, intervalMinutes: 15, graceMinutes: 5 }),
      "success",
      at("2026-11-18T10:00:00Z"),
      null,
    );
    expect(set.deadlineAt?.toISOString()).toBe("2026-11-18T10:20:00.000Z");
  });
});

describe("ping tokens", () => {
  it("are 32 characters of an unambiguous alphabet, and shape-checked", () => {
    const tokens = new Set(Array.from({ length: 200 }, generatePingToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(isPingTokenShape(t)).toBe(true);
    expect(isPingTokenShape("short")).toBe(false);
    expect(isPingTokenShape("A".repeat(32))).toBe(false);
  });
});
