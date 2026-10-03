import { describe, it, expect, vi, afterEach } from "vitest";
import { CloudflareClient } from "../client.js";
import { plugin } from "../plugin.js";
import { DATA_PLATFORM_TYPE_IDS, isDataPlatformResourceId } from "../data-platform.js";
import { makeApi, asyncIter } from "./_helpers.js";

const STREAM = {
  id: "str-1",
  name: "events",
  endpoint: "https://str-1.ingest.cloudflare.com",
  http: { enabled: true, authentication: true },
  worker_binding: { enabled: true },
};
const PIPELINE = {
  id: "pl-1",
  name: "p",
  sql: "INSERT INTO s SELECT * FROM events",
  status: "failed",
};
const WAREHOUSE = { id: "w", bucket: "lake", name: "acct-cf_lake", status: "active" };

function api() {
  return makeApi({
    cf: {
      pipelines: {
        listV1: vi.fn(() => asyncIter([PIPELINE])),
        getV1: vi.fn(async () => ({ ...PIPELINE, failure_reason: "sink missing", tables: [] })),
        deleteV1: vi.fn(async () => undefined),
        streams: {
          list: vi.fn(() => asyncIter([STREAM])),
          get: vi.fn(async () => STREAM),
          update: vi.fn(async () => STREAM),
        },
        sinks: { list: vi.fn(() => asyncIter([{ id: "s1", name: "s", type: "r2" }])) },
      },
      r2DataCatalog: {
        list: vi.fn(async () => ({ warehouses: [WAREHOUSE] })),
        get: vi.fn(async () => WAREHOUSE),
        namespaces: {
          list: vi.fn(async () => ({ namespaces: [["default"]] })),
          tables: {
            list: vi.fn(async () => ({
              identifiers: [{ name: "events", namespace: ["default"] }],
            })),
            maintenanceConfigs: { get: vi.fn(async () => ({ maintenance_config: {} })) },
          },
        },
      },
      r2: {
        buckets: { list: vi.fn(async () => ({ buckets: [{ name: "lake" }, { name: "b2" }] })) },
      },
    },
  });
}

function client() {
  const c = new CloudflareClient({ apiToken: "tok" }, plugin.resourceTypes);
  const a = api();
  (c as unknown as { api: unknown }).api = a;
  return { c, api: a };
}

describe("data platform wiring", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("registers every data platform type on the plugin", () => {
    const ids = plugin.resourceTypes.map((t) => t.id);
    for (const id of DATA_PLATFORM_TYPE_IDS) expect(ids).toContain(id);
    expect(isDataPlatformResourceId("a:basin-table:b/c/d")).toBe(true);
    expect(isDataPlatformResourceId("a:d1-database:x")).toBe(false);
  });

  it("lists, enriches and renders a failed pipeline with its SQL", async () => {
    const { c } = client();
    const [p] = await c.listResources("basin-pipeline", "acct");
    const enriched = await c.enrichDetail(p!);
    expect(enriched.fields["failureReason"]).toBe("sink missing");
    const schema = c.renderDetail(enriched);
    expect(schema.status).toMatchObject({ status: "error" });
    expect(schema.metricsCapability).toBeTruthy();
    expect(JSON.stringify(schema)).toContain("INSERT INTO s SELECT * FROM events");
    expect(c.renderSidebarItem(p!).status).toMatchObject({ status: "error" });
  });

  it("renders send snippets for a stream and routes edits through the merge", async () => {
    const { c, api: a } = client();
    const s = await c.getResource("basin-stream", "acct:basin-stream:str-1", "acct");
    const json = JSON.stringify(c.renderDetail(s));
    expect(json).toContain("https://str-1.ingest.cloudflare.com");
    expect(json).toContain('stream = \\"str-1\\"');
    await c.updateResource("basin-stream", "acct:basin-stream:str-1", "acct", {
      httpEnabled: "false",
    });
    expect(a.cf.pipelines.streams.update).toHaveBeenCalledWith(
      "str-1",
      expect.objectContaining({
        http: { enabled: false, authentication: true, cors: { origins: [] } },
      }),
    );
    expect(
      await c.resolveOutput("basin-stream", "acct:basin-stream:str-1", "endpoint", "acct"),
    ).toBe(STREAM.endpoint);
  });

  it("gives catalogs, tables and datasets a SQL editor", async () => {
    const { c } = client();
    const [cat] = await c.listResources("basin-catalog", "acct");
    const tables = await c.introspectResource(cat!.id, "acct");
    expect(tables).toEqual([{ name: "default.events", columns: [] }]);
    const catSchema = c.renderDetail({
      ...cat!,
      resolvedOutputs: { ...cat!.resolvedOutputs, __tables__: JSON.stringify(tables) },
    });
    expect(catSchema.sqlEditor?.defaultQuery).toBe("SELECT * FROM default.events LIMIT 10");

    const [table] = await c.listResources("basin-table", "acct");
    expect(c.renderDetail(table!).sqlEditor?.defaultQuery).toBe(
      "SELECT * FROM default.events LIMIT 10",
    );

    const ds = c.renderDetail({
      id: "acct:analytics-engine-dataset:temps",
      pluginId: "cloudflare",
      resourceTypeId: "analytics-engine-dataset",
      accountId: "acct",
      displayName: "temps",
      externalId: "temps",
      fields: { name: "temps" },
      resolvedOutputs: { datasetName: "temps" },
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(ds.sqlEditor?.defaultQuery).toContain("FROM temps");
  });

  it("routes executeQuery by resource id: Basin SQL for tables, D1 otherwise untouched", async () => {
    const { c } = client();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, result: { schema: [], rows: [{ n: 1 }] } }),
    }));
    globalThis.fetch = fetchMock as never;
    const out = await c.executeQuery("acct:basin-table:lake/default/events", "acct", "SELECT 1");
    expect(out.rows).toEqual([{ n: 1 }]);
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain(
      "/basin-sql/query/lake",
    );
  });

  it("fetches pipeline metrics from the three pipelines datasets", async () => {
    const { c } = client();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            accounts: [
              {
                pipelinesOperatorAdaptiveGroups: [
                  {
                    dimensions: { ts: "2026-10-01T00:00:00Z" },
                    sum: { recordsIn: 5, bytesIn: 50 },
                  },
                ],
                pipelinesSinkAdaptiveGroups: [
                  { dimensions: { ts: "2026-10-01T00:00:00Z" }, sum: { recordsWritten: 4 } },
                ],
                pipelinesUserErrorsAdaptiveGroups: [
                  {
                    count: 1,
                    dimensions: { ts: "2026-10-01T00:00:00Z", errorType: "type_mismatch" },
                  },
                ],
              },
            ],
          },
        },
      }),
    }));
    globalThis.fetch = fetchMock as never;
    const series = await c.fetchMetricSeries("basin-pipeline", "acct:basin-pipeline:pl-1", "acct");
    const labels = series.map((s) => s.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Records Ingested",
        "Bytes Ingested",
        "Records Delivered",
        "Dropped Events",
        "Dropped: type mismatch",
      ]),
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as { query: string; variables: Record<string, string> };
    expect(body.variables).toMatchObject({ account: "acct-cf", id: "pl-1" });
    expect(body.query).toContain("pipelinesUserErrorsAdaptiveGroups");
  });

  it("returns create forms with pickers", async () => {
    const { c } = client();
    const catalog = await c.getCreateConfig("basin-catalog");
    expect(catalog.fields.find((f) => f.key === "bucket")?.options).toEqual([
      { id: "b2", label: "b2" },
    ]);
    const pipeline = await c.getCreateConfig("basin-pipeline");
    expect(pipeline.fields.find((f) => f.key === "stream")?.options).toEqual([
      { id: "events", label: "events" },
    ]);
    const sink = await c.getCreateConfig("basin-sink");
    expect(sink.fields.find((f) => f.key === "catalogBucket")?.options).toEqual([
      { id: "lake", label: "lake" },
    ]);
    // Non data platform types still reach the original create configs.
    expect((await c.getCreateConfig("d1-database")).fields.length).toBeGreaterThan(0);
  });

  it("deletes pipelines through the v1 API", async () => {
    const { c, api: a } = client();
    await c.deleteResource("basin-pipeline", "acct:basin-pipeline:pl-1", "acct");
    expect(a.cf.pipelines.deleteV1).toHaveBeenCalledWith("pl-1", { account_id: "acct-cf" });
    await expect(
      c.deleteResource("basin-table", "acct:basin-table:lake/default/events", "acct"),
    ).rejects.toThrow(/not supported/);
  });
});
