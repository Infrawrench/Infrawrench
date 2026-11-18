import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, it, expect, vi, afterEach } from "vitest";

import { TursoClient } from "../client.js";

const DB_PATH = "/v1/organizations/myorg/databases";

function client() {
  return hostClient(new TursoClient({ apiToken: "tok", organizationName: "myorg" }));
}

function response(json: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response;
}

/** Every request is answered here; an unrouted one gets a 404, so nothing reaches Turso. */
function routeFetch(routes: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    if (key in routes) return response(routes[key]);
    return response({ error: `unrouted ${key}` }, 404);
  });
}

afterEach(() => vi.restoreAllMocks());

describe("Turso restore drills", () => {
  it("seeds a new database in the source's group from a point in time", async () => {
    const fetch = routeFetch({
      [`GET ${DB_PATH}/orders`]: { database: { Name: "orders", group: "default" } },
      [`POST ${DB_PATH}`]: { database: { Name: "iw-drill-abc" } },
    });
    const handle = await client().startRestoreDrill!({
      resourceTypeId: "turso-database",
      resourceId: "acct:turso-database:orders",
      accountId: "acct",
      restorePoint: { kind: "point-in-time", at: "2026-11-17T10:00:00.000Z" },
      copyName: "iw-drill-abc",
    });
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post![1]!.body))).toEqual({
      name: "iw-drill-abc",
      group: "default",
      seed: { type: "database", name: "orders", timestamp: "2026-11-17T10:00:00.000Z" },
    });
    expect(handle).toEqual({
      ref: "iw-drill-abc",
      restoredFrom: "orders at 2026-11-17T10:00:00.000Z",
      restorePointAt: "2026-11-17T10:00:00.000Z",
    });
  });

  it("has no backups to restore from", async () => {
    routeFetch({});
    await expect(
      client().startRestoreDrill!({
        resourceTypeId: "turso-database",
        resourceId: "acct:turso-database:orders",
        accountId: "acct",
        restorePoint: { kind: "latest-backup" },
        copyName: "iw-drill-abc",
      }),
    ).rejects.toThrow("point in time");
  });

  it("connects with a read-only token on the copy's hostname", async () => {
    const fetch = routeFetch({
      [`GET ${DB_PATH}/iw-drill-abc`]: {
        database: { Name: "iw-drill-abc", Hostname: "iw-drill-abc-myorg.turso.io" },
      },
      [`POST ${DB_PATH}/iw-drill-abc/auth/tokens`]: { jwt: "jwt-value" },
    });
    expect(await client().checkRestoreDrill!("iw-drill-abc", "acct")).toEqual({
      state: "ready",
      connection: {
        driver: "libsql",
        connectionString: "libsql://iw-drill-abc-myorg.turso.io?authToken=jwt-value",
      },
    });
    const tokenCall = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(new URL(String(tokenCall![0])).searchParams.get("authorization")).toBe("read-only");
  });

  it("deletes only drill databases, and treats a missing one as deleted", async () => {
    const fetch = routeFetch({ [`DELETE ${DB_PATH}/iw-drill-abc`]: {} });
    await client().endRestoreDrill!("iw-drill-abc", "acct");
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    routeFetch({});
    await expect(client().endRestoreDrill!("iw-drill-abc", "acct")).resolves.toBeUndefined();
    await expect(client().endRestoreDrill!("orders", "acct")).rejects.toThrow("malformed");
  });
});
