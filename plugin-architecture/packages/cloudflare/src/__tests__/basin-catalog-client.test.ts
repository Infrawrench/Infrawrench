import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listCatalogs,
  enableCatalog,
  editCatalog,
  disableCatalog,
  listTables,
  getTable,
  editTable,
  maintenanceBody,
  normaliseSnapshotAge,
  parseTableExternalId,
  tableExternalId,
  catalogUri,
  runBasinSql,
  introspectCatalog,
  getUncatalogedBucketOptions,
} from "../clients/basin-catalog-client.js";
import { makeApi } from "./_helpers.js";

const WAREHOUSE = {
  id: "wh-uuid",
  bucket: "lake",
  name: "acct-cf_lake",
  status: "active",
  credential_status: "present",
  maintenance_config: {
    compaction: { state: "enabled", target_size_mb: "128" },
    snapshot_expiration: { state: "enabled", max_snapshot_age: "30d", min_snapshots_to_keep: 5 },
  },
};

function catalogApi() {
  const tablesMaint = {
    get: vi.fn(async () => ({
      maintenance_config: { compaction: { state: "disabled", target_size_mb: "64" } },
    })),
    update: vi.fn(async () => ({})),
  };
  const r2DataCatalog = {
    list: vi.fn(async () => ({
      warehouses: [
        WAREHOUSE,
        { ...WAREHOUSE, bucket: "old", name: "acct-cf_old", status: "inactive" },
      ],
    })),
    get: vi.fn(async () => WAREHOUSE),
    enable: vi.fn(async () => ({ id: "wh-uuid", name: "acct-cf_lake" })),
    disable: vi.fn(async () => undefined),
    maintenanceConfigs: { update: vi.fn(async () => ({})) },
    credentials: { create: vi.fn(async () => null) },
    namespaces: {
      list: vi.fn(async (_b: string, p: { page_token?: string }) =>
        p.page_token
          ? { namespaces: [["web", "prod"]], next_page_token: null }
          : { namespaces: [["default"]], next_page_token: "p2" },
      ),
      tables: {
        list: vi.fn(async (_b: string, ns: string) => ({
          identifiers: [],
          details: [
            {
              identifier: { name: ns === "default" ? "events" : "hits", namespace: [] },
              table_uuid: `uuid-${ns}`,
              location: "s3://lake/x",
              created_at: "2026-09-01T00:00:00Z",
            },
          ],
        })),
        maintenanceConfigs: tablesMaint,
      },
    },
  };
  const r2 = {
    buckets: { list: vi.fn(async () => ({ buckets: [{ name: "lake" }, { name: "raw" }] })) },
  };
  return makeApi({ apiToken: "secret-token", cf: { r2DataCatalog, r2 } });
}

describe("basin catalogs", () => {
  it("maps warehouses, maintenance and the Iceberg URI", async () => {
    const [c, old] = await listCatalogs(catalogApi(), "acct");
    expect(c!.id).toBe("acct:basin-catalog:lake");
    expect(c!.fields).toMatchObject({
      warehouseName: "acct-cf_lake",
      catalogUri: "https://catalog.cloudflarestorage.com/acct-cf/lake",
      status: "active",
      compaction: "enabled",
      targetSizeMb: "128",
      snapshotExpiration: "enabled",
      maxSnapshotAge: "30d",
      minSnapshotsToKeep: 5,
    });
    expect(old!.fields["status"]).toBe("inactive");
    expect(catalogUri("abc_my_bucket")).toBe("https://catalog.cloudflarestorage.com/abc/my_bucket");
  });

  it("enable stores a credential and maintenance config when maintenance is on", async () => {
    const api = catalogApi();
    await enableCatalog(api, "acct", {
      bucket: "lake",
      compaction: "enabled",
      targetSizeMb: "256",
      snapshotExpiration: "disabled",
    });
    expect(api.cf.r2DataCatalog.enable).toHaveBeenCalledWith("lake", { account_id: "acct-cf" });
    expect(api.cf.r2DataCatalog.credentials.create).toHaveBeenCalledWith("lake", {
      account_id: "acct-cf",
      token: "secret-token",
    });
    expect(api.cf.r2DataCatalog.maintenanceConfigs.update).toHaveBeenCalledWith("lake", {
      account_id: "acct-cf",
      compaction: { state: "enabled", target_size_mb: "256" },
      snapshot_expiration: { state: "disabled" },
    });
  });

  it("enable without maintenance skips the credential", async () => {
    const api = catalogApi();
    await enableCatalog(api, "acct", { bucket: "lake" });
    expect(api.cf.r2DataCatalog.credentials.create).not.toHaveBeenCalled();
    await expect(enableCatalog(api, "acct", {})).rejects.toThrow(/Pick the R2 bucket/);
  });

  it("edit only replaces the credential when a new token was typed", async () => {
    const api = catalogApi();
    await editCatalog(
      api,
      "acct",
      "lake",
      { compaction: "enabled", credentialStatus: "present", maintenanceToken: "" },
      ["compaction"],
    );
    expect(api.cf.r2DataCatalog.credentials.create).not.toHaveBeenCalled();
    await editCatalog(
      api,
      "acct",
      "lake",
      { compaction: "enabled", credentialStatus: "present", maintenanceToken: "new" },
      ["maintenanceToken"],
    );
    expect(api.cf.r2DataCatalog.credentials.create).toHaveBeenCalledWith("lake", {
      account_id: "acct-cf",
      token: "new",
    });
    await disableCatalog(api, "lake");
    expect(api.cf.r2DataCatalog.disable).toHaveBeenCalledWith("lake", { account_id: "acct-cf" });
  });

  it("maintenanceBody normalises ages and drops unset keys", () => {
    expect(
      maintenanceBody({
        snapshotExpiration: "enabled",
        maxSnapshotAge: "14",
        minSnapshotsToKeep: "3",
        targetSizeMb: "999",
        compaction: "enabled",
      }),
    ).toEqual({
      compaction: { state: "enabled" },
      snapshot_expiration: { state: "enabled", max_snapshot_age: "14d", min_snapshots_to_keep: 3 },
    });
    expect(maintenanceBody({})).toEqual({});
    expect(normaliseSnapshotAge("12h")).toBe("12h");
    expect(() => normaliseSnapshotAge("soon")).toThrow(/duration/);
  });

  it("offers only buckets without an active catalog for enabling", async () => {
    expect(await getUncatalogedBucketOptions(catalogApi())).toEqual([{ id: "raw", label: "raw" }]);
  });
});

describe("basin tables", () => {
  it("lists tables across paged namespaces of active catalogs only", async () => {
    const api = catalogApi();
    const tables = await listTables(api, "acct");
    expect(tables.map((t) => t.displayName)).toEqual(["default.events", "web.prod.hits"]);
    expect(tables[0]!.parentResourceId).toBe("acct:basin-catalog:lake");
    expect(tables[1]!.id).toBe("acct:basin-table:lake/web.prod/hits");
    // Multi-level namespaces travel joined by U+001F.
    expect(vi.mocked(api.cf.r2DataCatalog.namespaces.tables.list).mock.calls[1]![1]).toBe(
      "web%1Fprod",
    );
  });

  it("round-trips table ids", () => {
    const ref = { bucket: "b", namespace: "a.b", name: "t" };
    expect(parseTableExternalId(tableExternalId(ref))).toEqual(ref);
    expect(parseTableExternalId("nope")).toBeNull();
  });

  it("getTable folds in the table's maintenance config; editTable writes it", async () => {
    const api = catalogApi();
    const t = await getTable(api, "lake/default/events", "acct");
    expect(t.fields).toMatchObject({ compaction: "disabled", targetSizeMb: "64" });
    await editTable(api, "acct", "lake/default/events", {
      compaction: "enabled",
      targetSizeMb: "512",
    });
    expect(api.cf.r2DataCatalog.namespaces.tables.maintenanceConfigs.update).toHaveBeenCalledWith(
      "lake",
      "default",
      "events",
      {
        account_id: "acct-cf",
        compaction: { state: "enabled", target_size_mb: "512" },
      },
    );
  });

  it("introspects a catalog as namespace.table entries", async () => {
    expect(await introspectCatalog(catalogApi(), "lake")).toEqual([
      { name: "default.events", columns: [] },
      { name: "web.prod.hits", columns: [] },
    ]);
  });
});

describe("basin sql", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts the query with the warehouse and keeps schema column order", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          errors: [],
          result: {
            schema: [{ name: "b" }, { name: "a" }],
            rows: [{ a: 1, b: 2 }],
            metrics: { bytes_scanned: 10, files_scanned: 1, r2_requests_count: 1 },
          },
        }),
    }));
    globalThis.fetch = fetchMock as never;
    const out = await runBasinSql(catalogApi(), "lake", "SELECT a, b FROM default.events");
    expect(Object.keys(out.rows[0]!)).toEqual(["b", "a"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.sql.cloudflarestorage.com/api/v1/accounts/acct-cf/basin-sql/query/lake",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      warehouse: "acct-cf_lake",
      query: "SELECT a, b FROM default.events",
    });
  });

  it("explains missing permissions and surfaces query errors", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({ success: false, errors: [{ code: 10000, message: "no" }] }),
    })) as never;
    await expect(runBasinSql(catalogApi(), "lake", "SELECT 1")).rejects.toThrow(
      /Workers R2 SQL Read/,
    );
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ success: false, errors: [{ code: 4001, message: "bad column" }] }),
    })) as never;
    await expect(runBasinSql(catalogApi(), "lake", "SELECT x")).rejects.toThrow(
      "bad column (code 4001)",
    );
  });
});
