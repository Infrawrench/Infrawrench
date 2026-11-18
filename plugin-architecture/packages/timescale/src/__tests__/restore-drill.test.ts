import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimescaleClient } from "../client.js";
import { mockFetch } from "./helpers.js";

// mockFetch answers every request itself (unrouted ones with a 404), so nothing reaches Tiger Cloud.
afterEach(() => vi.unstubAllGlobals());

const client = () => hostClient(new TimescaleClient({ accessKey: "pub", secretKey: "sec" }));
const SVC = "/projects/p1/services/s1";
const FORK = "/projects/p1/services/f1";

const request = {
  resourceTypeId: "ts-service",
  resourceId: "acc:ts-service:p1/s1",
  accountId: "acc",
  copyName: "iw-drill-abc",
} as const;

describe("Tiger Cloud restore drills", () => {
  it("forks from the last snapshot, or to a point in time", async () => {
    const { calls } = mockFetch({
      [`POST ${SVC}/forkService`]: { service_id: "f1", project_id: "p1", name: "iw-drill-abc" },
    });
    const handle = await client().startRestoreDrill!({
      ...request,
      restorePoint: { kind: "latest-backup" },
    });
    expect(calls[0]!.body).toEqual({ fork_strategy: "LAST_SNAPSHOT", name: "iw-drill-abc" });
    expect(handle).toEqual({ ref: "p1/f1", restoredFrom: "s1, last snapshot" });

    await client().startRestoreDrill!({
      ...request,
      restorePoint: { kind: "point-in-time", at: "2026-11-17T10:00:00.000Z" },
    });
    expect(calls[1]!.body).toEqual({
      fork_strategy: "PITR",
      target_time: "2026-11-17T10:00:00.000Z",
      name: "iw-drill-abc",
    });
  });

  it("is pending until the fork is ready, then sets a fresh password for the check", async () => {
    mockFetch({ [`GET ${FORK}`]: { service_id: "f1", name: "iw-drill-abc", status: "QUEUED" } });
    expect(await client().checkRestoreDrill!("p1/f1", "acc")).toEqual({
      state: "pending",
      detail: "The fork is queued.",
    });

    vi.unstubAllGlobals();
    const { calls } = mockFetch({
      [`GET ${FORK}`]: {
        service_id: "f1",
        name: "iw-drill-abc",
        status: "READY",
        endpoint: { host: "f1.example.test", port: 30000 },
      },
      [`POST ${FORK}/updatePassword`]: null,
    });
    const status = await client().checkRestoreDrill!("p1/f1", "acc");
    expect(status.state).toBe("ready");
    const set = calls.find((c) => c.method === "POST");
    const password = (set!.body as { password: string }).password;
    expect(password.length).toBeGreaterThanOrEqual(8);
    if (status.state === "ready") {
      expect(status.connection.driver).toBe("postgres");
      expect(status.connection.connectionString).toContain("f1.example.test:30000");
      expect(status.connection.connectionString).toContain(encodeURIComponent(password));
    }
  });

  it("deletes only drill forks, and treats a missing one as deleted", async () => {
    const { calls } = mockFetch({
      [`GET ${FORK}`]: { service_id: "f1", name: "iw-drill-abc", status: "READY" },
      [`DELETE ${FORK}`]: null,
    });
    await client().endRestoreDrill!("p1/f1", "acc");
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);

    vi.unstubAllGlobals();
    mockFetch({});
    await expect(client().endRestoreDrill!("p1/f1", "acc")).resolves.toBeUndefined();

    vi.unstubAllGlobals();
    const foreign = mockFetch({ [`GET ${SVC}`]: { service_id: "s1", name: "metrics-prod" } });
    await expect(client().endRestoreDrill!("p1/s1", "acc")).rejects.toThrow("refusing");
    expect(foreign.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
