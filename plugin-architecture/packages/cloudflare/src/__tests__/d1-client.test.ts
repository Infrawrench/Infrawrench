import { describe, it, expect, vi } from "vitest";
import {
  listD1Databases,
  getD1Database,
  createD1Database,
  deleteD1Database,
  executeD1Query,
  introspectD1Database,
} from "../clients/d1-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

function d1Api(over: Record<string, unknown> = {}) {
  const database = {
    list: vi.fn(() =>
      asyncIter([
        { uuid: "db1", name: "mydb", version: "production", num_tables: 3, file_size: "1KB" },
      ]),
    ),
    create: vi.fn(async () => ({ uuid: "db2", name: "new" })),
    delete: vi.fn(async () => undefined),
    query: vi.fn(),
  };
  return makeApi({
    cf: { database, get: vi.fn(async () => ({ uuid: "db1", name: "mydb" })), d1: { database } },
    ...over,
  });
}

describe("d1-client", () => {
  it("listD1Databases maps databases", async () => {
    const api = d1Api();
    const out = await listD1Databases(api, "acct");
    expect(out[0].id).toBe("acct:d1-database:db1");
    expect(out[0].fields.numTables).toBe(3);
    expect(out[0].displayName).toBe("mydb");
  });

  it("getD1Database fetches via raw get path", async () => {
    const api = d1Api();
    const out = await getD1Database(api, "db1", "acct");
    expect(api.cf.get).toHaveBeenCalledWith("/accounts/acct-cf/d1/database/db1");
    expect(out.externalId).toBe("db1");
  });

  it("createD1Database creates with name", async () => {
    const api = d1Api();
    const out = await createD1Database(api, "acct", { name: "new" });
    expect(api.cf.d1.database.create).toHaveBeenCalledWith({ account_id: "acct-cf", name: "new" });
    expect(out.externalId).toBe("db2");
  });

  it("deleteD1Database calls SDK delete", async () => {
    const api = d1Api();
    await deleteD1Database(api, "db1");
    expect(api.cf.d1.database.delete).toHaveBeenCalledWith("db1", { account_id: "acct-cf" });
  });

  it("executeD1Query flattens results across pages", async () => {
    const query = vi.fn(() =>
      asyncIter([{ results: [{ a: 1 }, { a: 2 }] }, { results: [{ a: 3 }] }]),
    );
    const api = d1Api({ cf: { get: vi.fn(), d1: { database: { query } } } });
    const out = await executeD1Query(api, "acct:d1-database:db1", "SELECT 1");
    expect(out.rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(query).toHaveBeenCalledWith("db1", { account_id: "acct-cf", sql: "SELECT 1" });
    expect(typeof out.durationMs).toBe("number");
  });

  it("introspectD1Database returns table metadata with pk columns", async () => {
    // First query: sqlite_master tables; subsequent: PRAGMA table_info per table.
    const query = vi
      .fn()
      .mockImplementationOnce(() => asyncIter([{ results: [{ name: "users" }] }]))
      .mockImplementationOnce(() =>
        asyncIter([
          {
            results: [
              { name: "id", type: "INTEGER", pk: 1 },
              { name: "email", type: "TEXT", pk: 0 },
            ],
          },
        ]),
      );
    const api = d1Api({ cf: { get: vi.fn(), d1: { database: { query } } } });
    const meta = await introspectD1Database(api, "acct:d1-database:db1");
    expect(meta).toHaveLength(1);
    expect(meta[0].name).toBe("users");
    expect(meta[0].columns).toEqual([
      { name: "id", type: "INTEGER" },
      { name: "email", type: "TEXT" },
    ]);
    expect(meta[0].pkColumns).toEqual(["id"]);
  });

  it("introspectD1Database skips unnamed tables", async () => {
    const query = vi.fn(() => asyncIter([{ results: [{ name: "" }] }]));
    const api = d1Api({ cf: { get: vi.fn(), d1: { database: { query } } } });
    expect(await introspectD1Database(api, "acct:d1-database:db1")).toEqual([]);
  });
});
