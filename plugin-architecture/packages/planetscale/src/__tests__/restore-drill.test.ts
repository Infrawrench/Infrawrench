import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, it, expect, vi, afterEach } from "vitest";
import { PlanetScaleClient } from "../client.js";

const DB = "/v1/organizations/myorg/databases/shop";

function client() {
  return hostClient(
    new PlanetScaleClient({
      serviceTokenId: "tid",
      serviceTokenSecret: "tsecret",
      organizationName: "myorg",
    }),
  );
}

function response(json: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response;
}

/** Every request is answered here; an unrouted one gets a 404, so nothing reaches PlanetScale. */
function routeFetch(routes: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    if (key in routes) return response(routes[key]);
    return response({ message: `unrouted ${key}` }, 404);
  });
}

function bodyOf(mock: ReturnType<typeof routeFetch>, method: string): unknown {
  const call = mock.mock.calls.find(([, init]) => init?.method === method);
  return call ? JSON.parse(String(call[1]!.body)) : undefined;
}

afterEach(() => vi.restoreAllMocks());

const request = {
  resourceTypeId: "ps-branch",
  resourceId: "acct:ps-branch:shop/main",
  accountId: "acct",
  copyName: "iw-drill-abc",
} as const;

describe("PlanetScale restore drills", () => {
  it("restores the newest successful backup into a branch of the source's size", async () => {
    const fetch = routeFetch({
      [`GET ${DB}/branches/main`]: { name: "main", kind: "mysql", cluster_name: "PS_10" },
      [`GET ${DB}/branches/main/backups`]: {
        data: [
          { id: "b-failed", name: "x", state: "failed", completed_at: "2026-11-17T00:00:00Z" },
          { id: "b-new", name: "nightly", state: "success", completed_at: "2026-11-16T00:00:00Z" },
          { id: "b-old", name: "older", state: "success", completed_at: "2026-11-10T00:00:00Z" },
        ],
      },
      [`POST ${DB}/branches`]: { name: "iw-drill-abc" },
    });
    const handle = await client().startRestoreDrill!({
      ...request,
      restorePoint: { kind: "latest-backup" },
    });
    expect(bodyOf(fetch, "POST")).toEqual({
      name: "iw-drill-abc",
      parent_branch: "main",
      cluster_size: "PS_10",
      backup_id: "b-new",
    });
    expect(handle.ref).toBe("shop/iw-drill-abc");
    expect(handle.restoredFrom).toBe("backup nightly");
  });

  it("restores a Postgres branch to a point in time, and refuses that on Vitess", async () => {
    const fetch = routeFetch({
      [`GET ${DB}/branches/main`]: { name: "main", kind: "postgresql", cluster_name: "PS_5" },
      [`POST ${DB}/branches`]: { name: "iw-drill-abc" },
    });
    await client().startRestoreDrill!({
      ...request,
      restorePoint: { kind: "point-in-time", at: "2026-11-17T09:00:00.000Z" },
    });
    expect(bodyOf(fetch, "POST")).toMatchObject({ restore_point: "2026-11-17T09:00:00.000Z" });

    vi.restoreAllMocks();
    routeFetch({
      [`GET ${DB}/branches/main`]: { name: "main", kind: "mysql", cluster_name: "PS_5" },
    });
    await expect(
      client().startRestoreDrill!({
        ...request,
        restorePoint: { kind: "point-in-time", at: "2026-11-17T09:00:00.000Z" },
      }),
    ).rejects.toThrow("only on Postgres");
  });

  it("waits for the branch, then mints a read-only login on it", async () => {
    routeFetch({ [`GET ${DB}/branches/iw-drill-abc`]: { ready: false, kind: "postgresql" } });
    expect(await client().checkRestoreDrill!("shop/iw-drill-abc", "acct")).toMatchObject({
      state: "pending",
    });

    vi.restoreAllMocks();
    const fetch = routeFetch({
      [`GET ${DB}/branches/iw-drill-abc`]: { ready: true, kind: "postgresql" },
      [`POST ${DB}/branches/iw-drill-abc/roles`]: {
        username: "u",
        password: "p",
        access_host_url: "h.example.test",
      },
    });
    const status = await client().checkRestoreDrill!("shop/iw-drill-abc", "acct");
    expect(status).toEqual({
      state: "ready",
      connection: {
        driver: "postgres",
        connectionString: "postgresql://u:p@h.example.test:5432/postgres?sslmode=require",
      },
    });
    expect(bodyOf(fetch, "POST")).toEqual({
      name: "iw-drill-abc-check",
      inherited_roles: ["pg_read_all_data"],
    });
  });

  it("deletes the drill branch, treats a missing one as deleted, and refuses a foreign one", async () => {
    const fetch = routeFetch({ [`DELETE ${DB}/branches/iw-drill-abc`]: {} });
    await client().endRestoreDrill!("shop/iw-drill-abc", "acct");
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    routeFetch({});
    await expect(client().endRestoreDrill!("shop/iw-drill-abc", "acct")).resolves.toBeUndefined();
    await expect(client().endRestoreDrill!("shop/main", "acct")).rejects.toThrow("malformed");
  });
});
