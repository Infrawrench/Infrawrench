import { describe, it, expect, vi } from "vitest";
import {
  listStreams,
  createStream,
  editStream,
  deleteStream,
  parseStreamSchema,
  listSinks,
  createSink,
  resolveR2Credentials,
  listPipelines,
  getPipeline,
  createPipeline,
  deletePipeline,
  defaultPipelineSql,
} from "../clients/basin-pipelines-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const STREAM = {
  id: "str-1",
  name: "events",
  created_at: "2026-09-01T00:00:00Z",
  modified_at: "2026-09-02T00:00:00Z",
  version: 1,
  endpoint: "https://str-1.ingest.cloudflare.com",
  http: { enabled: true, authentication: true, cors: { origins: ["https://a.com"] } },
  worker_binding: { enabled: true },
  format: { type: "json" },
  schema: {
    fields: [
      { name: "user_id", type: "string", required: true },
      { name: "amount", type: "float64", required: false },
    ],
  },
};

const CATALOG_SINK = {
  id: "snk-1",
  name: "events_sink",
  type: "r2_data_catalog",
  created_at: "2026-09-01T00:00:00Z",
  modified_at: "2026-09-01T00:00:00Z",
  format: { type: "parquet", compression: "zstd" },
  config: {
    account_id: "acct-cf",
    bucket: "lake",
    namespace: "default",
    table_name: "events",
    rolling_policy: { interval_seconds: 300, file_size_bytes: 104_857_600 },
  },
};

const PIPELINE = {
  id: "pl-1",
  name: "events_pipeline",
  sql: "INSERT INTO events_sink SELECT * FROM events",
  status: "running",
  created_at: "2026-09-01T00:00:00Z",
  modified_at: "2026-09-01T00:00:00Z",
};

function pipelinesApi() {
  const pipelines = {
    listV1: vi.fn(() => asyncIter([PIPELINE])),
    getV1: vi.fn(async () => ({
      ...PIPELINE,
      tables: [
        { id: "str-1", name: "events", type: "stream", version: 1, latest: 1 },
        { id: "snk-1", name: "events_sink", type: "sink", version: 1, latest: 1 },
      ],
      failure_reason: "",
    })),
    createV1: vi.fn(async (p: { name: string; sql: string }) => ({ ...PIPELINE, ...p })),
    deleteV1: vi.fn(async () => undefined),
    streams: {
      list: vi.fn(() => asyncIter([STREAM])),
      get: vi.fn(async () => STREAM),
      create: vi.fn(async (p: Record<string, unknown>) => ({ ...STREAM, ...p })),
      update: vi.fn(async () => STREAM),
      delete: vi.fn(async () => undefined),
    },
    sinks: {
      list: vi.fn(() => asyncIter([CATALOG_SINK])),
      get: vi.fn(async () => CATALOG_SINK),
      create: vi.fn(async (p: Record<string, unknown>) => ({ ...CATALOG_SINK, ...p })),
      delete: vi.fn(async () => undefined),
    },
  };
  const get = vi.fn(async () => ({ success: true, result: { id: "tok-id", status: "active" } }));
  return makeApi({ apiToken: "secret-token", cf: { pipelines, get } });
}

describe("basin streams", () => {
  it("maps HTTP, binding, CORS and schema", async () => {
    const [s] = await listStreams(pipelinesApi(), "acct");
    expect(s!.id).toBe("acct:basin-stream:str-1");
    expect(s!.fields).toMatchObject({
      name: "events",
      endpoint: "https://str-1.ingest.cloudflare.com",
      httpEnabled: true,
      httpAuthentication: true,
      corsOrigins: "https://a.com",
      workerBinding: true,
      schema: "user_id: string, amount?: float64",
      schemaFieldCount: 2,
    });
    expect(s!.resolvedOutputs).toMatchObject({ streamId: "str-1", endpoint: STREAM.endpoint });
  });

  it("surfaces the Pipelines permission on a 403", async () => {
    const api = makeApi({
      cf: {
        pipelines: {
          streams: {
            list: vi.fn(() => {
              throw { status: 403 };
            }),
          },
        },
      },
    });
    await expect(listStreams(api, "acct")).rejects.toThrow(/Pipelines:Read/);
  });

  it("creates an unstructured stream when no schema is given", async () => {
    const api = pipelinesApi();
    await createStream(api, "acct", { name: "events", httpAuthentication: "false" });
    expect(api.cf.pipelines.streams.create).toHaveBeenCalledWith({
      account_id: "acct-cf",
      name: "events",
      http: { enabled: true, authentication: false },
      worker_binding: { enabled: true },
      format: { type: "json", unstructured: true },
    });
  });

  it("passes a structured schema and CORS origins through", async () => {
    const api = pipelinesApi();
    await createStream(api, "acct", {
      name: "events",
      corsOrigins: "https://a.com, https://b.com",
      schema: '[{"name":"id","type":"string","required":true}]',
    });
    const params = vi.mocked(api.cf.pipelines.streams.create).mock.calls[0]![0];
    expect(params.http?.cors).toEqual({ origins: ["https://a.com", "https://b.com"] });
    expect(params.schema).toEqual({ fields: [{ name: "id", type: "string", required: true }] });
    expect(params.format).toBeUndefined();
  });

  it("rejects malformed schema JSON with an example", () => {
    expect(() => parseStreamSchema("{nope")).toThrow(/fields/);
    expect(() => parseStreamSchema('{"fields": []}')).toThrow(/non-empty/);
    expect(parseStreamSchema("  ")).toBeUndefined();
  });

  it("edits only HTTP ingest and the Worker binding", async () => {
    const api = pipelinesApi();
    await editStream(api, "acct", "str-1", {
      httpEnabled: "false",
      httpAuthentication: "true",
      corsOrigins: "",
      workerBinding: "true",
    });
    expect(api.cf.pipelines.streams.update).toHaveBeenCalledWith("str-1", {
      account_id: "acct-cf",
      http: { enabled: false, authentication: true, cors: { origins: [] } },
      worker_binding: { enabled: true },
    });
    await deleteStream(api, "str-1");
    expect(api.cf.pipelines.streams.delete).toHaveBeenCalledWith("str-1", {
      account_id: "acct-cf",
    });
  });
});

describe("basin sinks", () => {
  it("maps a catalog sink's table, rolling policy and format", async () => {
    const [s] = await listSinks(pipelinesApi(), "acct");
    expect(s!.fields).toMatchObject({
      type: "Basin Catalog table",
      bucket: "lake",
      namespace: "default",
      tableName: "events",
      format: "parquet",
      compression: "zstd",
      rollIntervalSeconds: 300,
      rollSizeMb: 100,
    });
  });

  it("creates a catalog sink, defaulting the token to the account's own", async () => {
    const api = pipelinesApi();
    await createSink(api, "acct", {
      name: "events_sink",
      type: "r2_data_catalog",
      catalogBucket: "lake",
      tableName: "events",
      rollIntervalSeconds: "120",
    });
    expect(api.cf.pipelines.sinks.create).toHaveBeenCalledWith({
      account_id: "acct-cf",
      name: "events_sink",
      type: "r2_data_catalog",
      format: { type: "parquet", compression: "zstd" },
      config: {
        account_id: "acct-cf",
        bucket: "lake",
        namespace: "default",
        table_name: "events",
        token: "secret-token",
        rolling_policy: { interval_seconds: 120 },
      },
    });
  });

  it("creates a JSON R2 sink with derived S3 credentials", async () => {
    const api = pipelinesApi();
    await createSink(api, "acct", {
      name: "raw",
      type: "r2",
      bucket: "logs",
      format: "json",
      path: "events",
      partitioning: "year=%Y",
    });
    const params = vi.mocked(api.cf.pipelines.sinks.create).mock.calls[0]![0];
    expect(params.format).toEqual({ type: "json" });
    expect(params.config).toMatchObject({
      bucket: "logs",
      path: "events",
      partitioning: { time_pattern: "year=%Y" },
      credentials: { access_key_id: "tok-id" },
    });
    // SHA-256("secret-token")
    expect(
      (params.config as { credentials: { secret_access_key: string } }).credentials
        .secret_access_key,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses explicit R2 credentials and rejects half a pair", async () => {
    const api = pipelinesApi();
    expect(
      await resolveR2Credentials(api, "acct-cf", { accessKeyId: "AK", secretAccessKey: "SK" }),
    ).toEqual({ access_key_id: "AK", secret_access_key: "SK" });
    await expect(resolveR2Credentials(api, "acct-cf", { accessKeyId: "AK" })).rejects.toThrow(
      /both/,
    );
  });
});

describe("basin pipelines", () => {
  it("lists pipelines and fetches tables on get", async () => {
    const api = pipelinesApi();
    const [p] = await listPipelines(api, "acct");
    expect(p!.fields).toMatchObject({ name: "events_pipeline", status: "running" });
    expect(p!.fields["streams"]).toBeUndefined();
    const full = await getPipeline(api, "pl-1", "acct");
    expect(full.fields).toMatchObject({ streams: "events", sinks: "events_sink" });
    expect(full.fields["failureReason"]).toBeUndefined();
  });

  it("builds default SQL from the picked stream and sink", async () => {
    const api = pipelinesApi();
    await createPipeline(api, "acct", { name: "p", stream: "events", sink: "my-sink" });
    expect(api.cf.pipelines.createV1).toHaveBeenCalledWith({
      account_id: "acct-cf",
      name: "p",
      sql: 'INSERT INTO "my-sink" SELECT * FROM events',
    });
    expect(defaultPipelineSql("a", "b")).toBe("INSERT INTO b SELECT * FROM a");
  });

  it("prefers hand-written SQL and requires a source otherwise", async () => {
    const api = pipelinesApi();
    await createPipeline(api, "acct", { name: "p", sql: "INSERT INTO s SELECT x FROM t" });
    expect(vi.mocked(api.cf.pipelines.createV1).mock.calls[0]![0].sql).toBe(
      "INSERT INTO s SELECT x FROM t",
    );
    await expect(createPipeline(api, "acct", { name: "p" })).rejects.toThrow(/stream and a sink/);
    await deletePipeline(api, "pl-1");
    expect(api.cf.pipelines.deleteV1).toHaveBeenCalledWith("pl-1", { account_id: "acct-cf" });
  });
});
