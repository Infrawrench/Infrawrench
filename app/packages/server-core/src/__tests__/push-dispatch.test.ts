import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * Push dispatch tests. The DB is a real Drizzle over a recording driver
 * (fake-postgres): the member → device → preference join renders its actual
 * SQL and resolves from canned rows, device updates/deletes are read back from
 * the recorded statements, and `fetch` is spied on `globalThis` to fake the
 * Expo push API.
 */

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

// Rows returned by the select (org fan-out join or user device list). Keys in
// projection order — see helpers/fake-postgres.ts.
function setTargets(rows: Array<{ id: string; expoPushToken: string }>) {
  pg.setRows(rows);
}

/** The bookkeeping statements against push_devices, newest last. */
const deviceUpdates = () => pg.queries.filter((q) => q.sql.startsWith('update "push_devices"'));
const deviceDeletes = () =>
  pg.queries.filter((q) => q.sql.startsWith('delete from "push_devices"'));

let dispatch: typeof import("../push/dispatch");
let fetchSpy: MockInstance<typeof fetch>;

function expoResponse(
  ticketsPerCall: Array<{ status: "ok" | "error"; details?: { error?: string } }>,
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: ticketsPerCall }),
    text: async () => "",
  } as unknown as Response;
}

function device(i: number) {
  return { id: `dev${i}`, expoPushToken: `ExponentPushToken[tok${i}]` };
}

const msg = {
  title: "t",
  body: "b",
  data: { type: "test", orgId: "org1" } as const,
};

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  dispatch = await import("../push/dispatch");
});

afterEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks does not cover stubEnv, and vitest.config.ts does not set
  // unstubEnvs — without this PUSH_CRITICAL_ALERTS leaks into later tests.
  vi.unstubAllEnvs();
});

describe("sendPushToOrg", () => {
  it("returns zeros without calling Expo when no devices match", async () => {
    setTargets([]);
    const out = await dispatch.sendPushToOrg("org1", "syncIncidents", msg);
    expect(out).toEqual({ attempted: 0, succeeded: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends one message per device and resets failureCount on success", async () => {
    setTargets([device(1), device(2)]);
    fetchSpy.mockResolvedValue(expoResponse([{ status: "ok" }, { status: "ok" }]));
    const out = await dispatch.sendPushToOrg("org1", "syncIncidents", msg);
    expect(out).toEqual({ attempted: 2, succeeded: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body).toHaveLength(2);
    expect(body[0].to).toBe("ExponentPushToken[tok1]");
    expect(body[0].data).toEqual(msg.data);
    // Success bookkeeping resets failureCount ("failure_count" = $1 with $1 = 0).
    expect(
      deviceUpdates().some((q) => q.sql.includes('"failure_count" = $') && q.params[0] === 0),
    ).toBe(true);
  });

  it("sends every notification at the top delivery tier on both platforms", async () => {
    setTargets([device(1)]);
    fetchSpy.mockResolvedValue(expoResponse([{ status: "ok" }]));
    await dispatch.sendPushToOrg("org1", "syncIncidents", msg);
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    // APNs 10 / FCM high, and the level that breaks through iOS Focus. Losing
    // either is invisible in testing — the push still arrives, just late or
    // silently — so pin them.
    expect(body[0].priority).toBe("high");
    expect(body[0].interruptionLevel).toBe("time-sensitive");
    expect(body[0].channelId).toBe("incidents");
  });

  // `critical` is the only iOS level above time-sensitive, and an unentitled
  // build may treat it as *less* urgent — so the flag guards a regression, not
  // just a feature, and both of its states are worth pinning.
  it("leaves workflow pages at time-sensitive while PUSH_CRITICAL_ALERTS is unset", async () => {
    vi.stubEnv("PUSH_CRITICAL_ALERTS", "");
    setTargets([device(1)]);
    fetchSpy.mockResolvedValue(expoResponse([{ status: "ok" }]));
    await dispatch.sendPushToOrg("org1", "workflowPages", msg);
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body[0].interruptionLevel).toBe("time-sensitive");
  });

  it("sends workflow pages as critical when PUSH_CRITICAL_ALERTS=1", async () => {
    vi.stubEnv("PUSH_CRITICAL_ALERTS", "1");
    setTargets([device(1)]);
    fetchSpy.mockResolvedValue(expoResponse([{ status: "ok" }]));
    await dispatch.sendPushToOrg("org1", "workflowPages", msg);
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body[0].interruptionLevel).toBe("critical");
  });

  it("keeps non-page triggers at time-sensitive even with PUSH_CRITICAL_ALERTS=1", async () => {
    vi.stubEnv("PUSH_CRITICAL_ALERTS", "1");
    setTargets([device(1)]);
    fetchSpy.mockResolvedValue(expoResponse([{ status: "ok" }, { status: "ok" }]));
    await dispatch.sendPushToOrg("org1", "syncIncidents", msg);
    await dispatch.sendPushToOrg("org1", "budgetAlerts", msg);
    const levels = fetchSpy.mock.calls.map(
      (c) => JSON.parse(String((c[1] as RequestInit).body))[0].interruptionLevel,
    );
    expect(levels).toEqual(["time-sensitive", "time-sensitive"]);
  });

  it("dispatches the postureAlerts trigger like the other alert triggers", async () => {
    setTargets([device(1)]);
    fetchSpy.mockResolvedValue(expoResponse([{ status: "ok" }]));
    const out = await dispatch.sendPushToOrg("org1", "postureAlerts", msg);
    expect(out).toEqual({ attempted: 1, succeeded: 1 });
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body[0].interruptionLevel).toBe("time-sensitive");
  });

  it("dispatches the probeAlerts trigger through its preference column", async () => {
    setTargets([device(1)]);
    fetchSpy.mockResolvedValue(expoResponse([{ status: "ok" }]));
    const out = await dispatch.sendPushToOrg("org1", "probeAlerts", msg);
    expect(out).toEqual({ attempted: 1, succeeded: 1 });
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    // Probe alerts are ordinary alerts, not pages: time-sensitive, never critical.
    expect(body[0].interruptionLevel).toBe("time-sensitive");
  });

  it("chunks requests at 100 messages", async () => {
    setTargets(Array.from({ length: 150 }, (_, i) => device(i)));
    fetchSpy.mockImplementation(async (_url, init) => {
      const n = JSON.parse(String((init as RequestInit).body)).length;
      return expoResponse(Array.from({ length: n }, () => ({ status: "ok" as const })));
    });
    const out = await dispatch.sendPushToOrg("org1", "budgetAlerts", msg);
    expect(out).toEqual({ attempted: 150, succeeded: 150 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const sizes = fetchSpy.mock.calls.map(
      (c) => JSON.parse(String((c[1] as RequestInit).body)).length,
    );
    expect(sizes).toEqual([100, 50]);
  });

  it("deletes devices Expo reports as DeviceNotRegistered", async () => {
    setTargets([device(1), device(2)]);
    fetchSpy.mockResolvedValue(
      expoResponse([
        { status: "error", details: { error: "DeviceNotRegistered" } },
        { status: "ok" },
      ]),
    );
    const out = await dispatch.sendPushToOrg("org1", "syncIncidents", msg);
    expect(out).toEqual({ attempted: 2, succeeded: 1 });
    // One DELETE, naming exactly the dead device.
    expect(deviceDeletes()).toHaveLength(1);
    expect(deviceDeletes()[0]!.params).toEqual(["dev1"]);
  });

  it("increments failureCount on other ticket errors", async () => {
    setTargets([device(1)]);
    fetchSpy.mockResolvedValue(
      expoResponse([{ status: "error", details: { error: "MessageTooBig" } }]),
    );
    const out = await dispatch.sendPushToOrg("org1", "syncIncidents", msg);
    expect(out).toEqual({ attempted: 1, succeeded: 0 });
    expect(deviceDeletes()).toHaveLength(0);
    // The failure branch increments the counter in SQL rather than setting it.
    const failureUpdate = deviceUpdates().find((q) => q.sql.includes('"failure_count" + 1'));
    expect(failureUpdate).toBeDefined();
  });

  it("treats a network failure as failed tickets and never throws", async () => {
    setTargets([device(1), device(2)]);
    fetchSpy.mockRejectedValue(new Error("network down"));
    const out = await dispatch.sendPushToOrg("org1", "syncIncidents", msg);
    expect(out).toEqual({ attempted: 2, succeeded: 0 });
  });

  it("treats a non-200 Expo response as failed tickets", async () => {
    setTargets([device(1)]);
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    } as unknown as Response);
    const out = await dispatch.sendPushToOrg("org1", "syncIncidents", msg);
    expect(out).toEqual({ attempted: 1, succeeded: 0 });
  });

  it("never throws even when the DB query rejects", async () => {
    const spy = vi.spyOn(pg.db, "select").mockImplementation(() => {
      throw new Error("db exploded");
    });
    const out = await dispatch.sendPushToOrg("org1", "syncIncidents", msg);
    expect(out).toEqual({ attempted: 0, succeeded: 0 });
    spy.mockRestore();
  });

  it("pads missing tickets so bookkeeping stays aligned", async () => {
    setTargets([device(1), device(2)]);
    // Expo returns only one ticket for two messages.
    fetchSpy.mockResolvedValue(expoResponse([{ status: "ok" }]));
    const out = await dispatch.sendPushToOrg("org1", "syncIncidents", msg);
    expect(out).toEqual({ attempted: 2, succeeded: 1 });
  });
});

describe("sendTestPushToUser", () => {
  it("throws when the user has no devices", async () => {
    setTargets([]);
    await expect(dispatch.sendTestPushToUser("u1", "org1")).rejects.toThrow(
      /No registered devices/,
    );
  });

  it("throws when every delivery fails", async () => {
    setTargets([device(1)]);
    fetchSpy.mockRejectedValue(new Error("down"));
    await expect(dispatch.sendTestPushToUser("u1", "org1")).rejects.toThrow(/Test push failed/);
  });

  it("returns counts and sends a test payload on success", async () => {
    setTargets([device(1)]);
    fetchSpy.mockResolvedValue(expoResponse([{ status: "ok" }]));
    const out = await dispatch.sendTestPushToUser("u1", "org1");
    expect(out).toEqual({ attempted: 1, succeeded: 1 });
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body[0].data).toEqual({ type: "test", orgId: "org1" });
  });
});
