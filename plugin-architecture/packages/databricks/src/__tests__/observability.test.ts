import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { DatabricksClient } from "../client.js";
import { plugin } from "../plugin.js";
import {
  bucketSeconds,
  clusterEventLines,
  clusterWorkerSeries,
  jobRunSeries,
  nodeTimelineSeries,
  nodeTimelineSql,
  pipelineEventLines,
  servedEntityNames,
  servingEndpointSeries,
  warehouseQuerySeries,
} from "../observability.js";

const HOST = "https://dbc-test.cloud.databricks.com";

interface Call {
  method: string;
  path: string;
  body: unknown;
}
let calls: Call[] = [];

/** Routes match on method + path prefix; a string body is returned as raw text. */
function route(routes: Array<[string, string, unknown]>) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace(HOST, "");
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    for (const [m, p, body] of routes) {
      if (m === method && path.startsWith(p)) {
        if (body instanceof Error) {
          return { ok: false, status: 400, text: async () => body.message } as Response;
        }
        const text = typeof body === "string" ? body : JSON.stringify(body);
        return { ok: true, status: 200, text: async () => text } as Response;
      }
    }
    throw new Error(`unrouted: ${method} ${path}`);
  }) as typeof fetch);
}

function client() {
  return new DatabricksClient(
    { host: "dbc-test.cloud.databricks.com", token: "dapi123" },
    plugin.resourceTypes,
  );
}

function resource(typeId: string, externalId: string): ResourceInstance {
  return {
    id: `acct:${typeId}:${externalId}`,
    pluginId: "databricks",
    resourceTypeId: typeId,
    accountId: "acct",
    displayName: externalId,
    fields: { state: "RUNNING" },
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: "",
    updatedAt: "",
  };
}

afterEach(() => {
  calls = [];
  vi.restoreAllMocks();
});

describe("servingEndpointSeries", () => {
  const body = [
    "# TYPE cpu_usage_percentage gauge",
    'cpu_usage_percentage{served_entity="a"} 40',
    'cpu_usage_percentage{served_entity="b"} 60',
    'mem_usage_percentage{served_entity="a"} 25.5',
    'request_count_total{served_entity="a"} 10',
    'request_count_total{served_entity="b"} 5',
    'request_5xx_count_total{served_entity="a"} 1',
    'request_latency_ms_bucket{le="100"} 3',
    "request_latency_ms_sum 300",
    "request_latency_ms_count 3",
    "model_queue_time_ms_sum 0",
    "model_queue_time_ms_count 0",
  ].join("\n");

  it("averages utilisation, sums counts and takes the histogram mean", () => {
    const series = servingEndpointSeries(body, 1000);
    const byLabel = Object.fromEntries(series.map((s) => [s.label, s]));
    expect(byLabel["CPU usage"]).toEqual({
      label: "CPU usage",
      unit: "%",
      points: [{ timestamp: 1000, value: 50 }],
    });
    expect(byLabel["Memory usage"]!.points[0]!.value).toBe(25.5);
    expect(byLabel["Requests"]!.points[0]!.value).toBe(15);
    expect(byLabel["5xx errors"]!.points[0]!.value).toBe(1);
    expect(byLabel["Avg request latency"]).toMatchObject({ unit: "ms", points: [{ value: 100 }] });
    // A histogram with no observations has no mean.
    expect(byLabel["Avg request queue time"]).toBeUndefined();
    expect(byLabel["4xx errors"]).toBeUndefined();
  });

  it("lists served entities from both config shapes", () => {
    expect(
      servedEntityNames({
        served_entities: [{ name: "a" }],
        served_models: [{ name: "b" }, { name: "a" }],
      }),
    ).toEqual(["a", "b"]);
  });
});

describe("cluster events", () => {
  const events = [
    {
      timestamp: 3000,
      type: "UPSIZE_COMPLETED",
      details: { current_num_workers: 4, target_num_workers: 4 },
    },
    { timestamp: 1000, type: "CREATING", details: { user: "a@b.c", target_num_workers: 2 } },
    { timestamp: 2000, type: "TERMINATING", details: { reason: { code: "INACTIVITY" } } },
  ];

  it("renders events oldest first", () => {
    const lines = clusterEventLines(events).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("CREATING");
    expect(lines[0]).toContain("user=a@b.c");
    expect(lines[1]).toContain("reason=INACTIVITY");
    expect(lines[2]).toContain("workers=4");
  });

  it("charts worker and target counts from the events that report them", () => {
    expect(clusterWorkerSeries(events)).toEqual([
      { label: "Workers", points: [{ timestamp: 3000, value: 4 }] },
      {
        label: "Target workers",
        points: [
          { timestamp: 1000, value: 2 },
          { timestamp: 3000, value: 4 },
        ],
      },
    ]);
  });
});

describe("node timeline", () => {
  it("rejects cluster ids that are not plain identifiers", () => {
    expect(() => nodeTimelineSql("x' OR 1=1 --", 0, 1, 60)).toThrow();
    expect(nodeTimelineSql("0123-456789-abc", 0, 3_600_000, 60)).toContain(
      "cluster_id = '0123-456789-abc'",
    );
  });

  it("keeps the window near 300 buckets, never below a minute", () => {
    expect(bucketSeconds(0, 3_600_000)).toBe(60);
    expect(bucketSeconds(0, 7 * 86_400_000)).toBe(2040);
  });

  it("maps statement rows into series with byte-rate network", () => {
    const series = nodeTimelineSeries(
      ["bucket", "cpu", "cpu_wait", "mem", "net_out", "net_in"],
      [
        ["60", "12.345", "1", "50", "1024", null],
        ["120", "20", "2", "55", "2048", "10"],
      ],
    );
    expect(series.map((s) => s.label)).toEqual([
      "CPU usage",
      "CPU I/O wait",
      "Memory used",
      "Network in",
      "Network out",
    ]);
    expect(series[0]!.points[0]).toEqual({ timestamp: 60_000, value: 12.35 });
    expect(series.find((s) => s.label === "Network in")).toMatchObject({
      unit: "bytes/s",
      points: [{ timestamp: 120_000, value: 10 }],
    });
  });
});

describe("warehouseQuerySeries", () => {
  it("buckets counts, failures, mean duration and bytes read", () => {
    const series = warehouseQuerySeries(
      [
        {
          query_start_time_ms: 10_000,
          status: "FINISHED",
          duration: 100,
          metrics: { read_bytes: 5 },
        },
        { query_start_time_ms: 20_000, status: "FINISHED", duration: 300 },
        { query_start_time_ms: 70_000, status: "FAILED", duration: 50 },
        { query_start_time_ms: 999_999_999, status: "FINISHED", duration: 1 },
      ],
      0,
      120_000,
    );
    const byLabel = Object.fromEntries(series.map((s) => [s.label, s]));
    expect(byLabel["Queries"]!.points).toEqual([
      { timestamp: 0, value: 2 },
      { timestamp: 60_000, value: 1 },
    ]);
    expect(byLabel["Failed queries"]!.points.map((p) => p.value)).toEqual([0, 1]);
    expect(byLabel["Avg query duration"]!.points).toEqual([{ timestamp: 0, value: 200 }]);
    expect(byLabel["Data read"]).toMatchObject({ unit: "bytes" });
  });
});

describe("jobRunSeries", () => {
  it("plots one point per run with failures flagged", () => {
    const series = jobRunSeries([
      { start_time: 2000, end_time: 5000, queue_duration: 0, state: { result_state: "FAILED" } },
      {
        start_time: 1000,
        run_duration: 60_000,
        status: { termination_details: { type: "SUCCESS" } },
      },
    ]);
    expect(series.find((s) => s.label === "Run duration")!.points).toEqual([
      { timestamp: 1000, value: 60 },
      { timestamp: 2000, value: 3 },
    ]);
    expect(series.find((s) => s.label === "Failed runs")!.points.map((p) => p.value)).toEqual([
      0, 1,
    ]);
    expect(series.find((s) => s.label === "Queue time")!.points).toHaveLength(1);
  });
});

describe("pipelineEventLines", () => {
  it("orders events and prints exception messages under the line", () => {
    const text = pipelineEventLines([
      {
        timestamp: "2026-10-01T10:00:01.000Z",
        level: "ERROR",
        event_type: "flow_progress",
        origin: { flow_name: "orders" },
        message: "Flow failed",
        error: { exceptions: [{ class_name: "SparkException", message: "boom" }] },
      },
      {
        timestamp: "2026-10-01T10:00:00.000Z",
        level: "INFO",
        event_type: "create_update",
        message: "Started",
      },
    ]);
    expect(text).toBe(
      "2026-10-01 10:00:00  INFO     create_update  Started\n" +
        "2026-10-01 10:00:01  ERROR    flow_progress [orders]  Flow failed\n    SparkException: boom\n",
    );
  });
});

describe("client wiring", () => {
  it("declares Metrics and Logs tabs on the types that have them", () => {
    const c = client();
    for (const t of [
      "databricks-cluster",
      "databricks-sql-warehouse",
      "databricks-job",
      "databricks-serving-endpoint",
    ]) {
      expect(c.renderDetail(resource(t, "x")).metricsCapability).toBeDefined();
    }
    expect(c.renderDetail(resource("databricks-catalog", "x")).metricsCapability).toBeUndefined();
    for (const t of ["databricks-cluster", "databricks-serving-endpoint", "databricks-pipeline"]) {
      expect(c.renderDetail(resource(t, "x")).logs).toBeDefined();
    }
    expect(c.renderDetail(resource("databricks-job", "x")).logs).toBeUndefined();
  });

  it("reads serving metrics as text", async () => {
    route([["GET", "/api/2.0/serving-endpoints/ep/metrics", "cpu_usage_percentage 12\n"]]);
    const series = await client().fetchMetricSeries(
      "databricks-serving-endpoint",
      "acct:databricks-serving-endpoint:ep",
      "acct",
    );
    expect(series).toEqual([
      { label: "CPU usage", unit: "%", points: [expect.objectContaining({ value: 12 })] },
    ]);
  });

  it("charts cluster node timeline only on a running warehouse", async () => {
    route([
      [
        "POST",
        "/api/2.1/clusters/events",
        { events: [{ timestamp: 5, details: { current_num_workers: 2 } }] },
      ],
      ["GET", "/api/2.0/sql/warehouses", { warehouses: [{ id: "w0", state: "STOPPED" }] }],
    ]);
    const series = await client().fetchMetricSeries(
      "databricks-cluster",
      "acct:databricks-cluster:0123-abc",
      "acct",
      { startMs: 0, endMs: 3_600_000 },
    );
    expect(series.map((s) => s.label)).toEqual(["Workers"]);
    expect(calls.some((c) => c.path === "/api/2.0/sql/statements")).toBe(false);
    expect(calls[0]!.body).toMatchObject({
      cluster_id: "0123-abc",
      start_time: 0,
      end_time: 3_600_000,
    });
  });

  it("queries node_timeline on a running warehouse", async () => {
    route([
      ["POST", "/api/2.1/clusters/events", { events: [] }],
      ["GET", "/api/2.0/sql/warehouses", { warehouses: [{ id: "w1", state: "RUNNING" }] }],
      [
        "POST",
        "/api/2.0/sql/statements",
        {
          status: { state: "SUCCEEDED" },
          manifest: { schema: { columns: [{ name: "bucket" }, { name: "cpu" }] } },
          result: { data_array: [["60", "30"]] },
        },
      ],
    ]);
    const series = await client().fetchMetricSeries(
      "databricks-cluster",
      "acct:databricks-cluster:0123-abc",
      "acct",
      { startMs: 0, endMs: 3_600_000 },
    );
    expect(series).toEqual([
      { label: "CPU usage", unit: "%", points: [{ timestamp: 60_000, value: 30 }] },
    ]);
    const stmt = calls.find((c) => c.path === "/api/2.0/sql/statements")!.body as Record<
      string,
      string
    >;
    expect(stmt.warehouse_id).toBe("w1");
    expect(stmt.on_wait_timeout).toBe("CANCEL");
    expect(stmt.statement).toContain("system.compute.node_timeline");
  });

  it("filters query history by warehouse and window", async () => {
    route([["GET", "/api/2.0/sql/history/queries", { res: [], has_next_page: false }]]);
    await client().fetchMetricSeries(
      "databricks-sql-warehouse",
      "acct:databricks-sql-warehouse:w1",
      "acct",
      {
        startMs: 1000,
        endMs: 2000,
      },
    );
    expect(calls[0]!.path).toContain("filter_by.warehouse_ids=w1");
    expect(calls[0]!.path).toContain("filter_by.query_start_time_range.start_time_ms=1000");
    expect(calls[0]!.path).toContain("include_metrics=true");
  });

  it("serves model logs and build logs from a dropdown", async () => {
    route([
      ["GET", "/api/2.0/serving-endpoints/ep/served-models/m1/build-logs", { logs: "built\n" }],
      ["GET", "/api/2.0/serving-endpoints/ep/served-models/m1/logs", { logs: "a\nb\nc\n" }],
      ["GET", "/api/2.0/serving-endpoints/ep", { config: { served_entities: [{ name: "m1" }] } }],
    ]);
    const c = client();
    const live = await c.getLogs(
      "databricks-serving-endpoint",
      "acct:databricks-serving-endpoint:ep",
      "acct",
      {
        tailLines: 2,
      },
    );
    expect(live).toEqual({
      text: "b\nc\n",
      containers: ["m1", "m1 (build)"],
      activeContainer: "m1",
    });
    const build = await c.getLogs(
      "databricks-serving-endpoint",
      "acct:databricks-serving-endpoint:ep",
      "acct",
      {
        container: "m1 (build)",
      },
    );
    expect(build.text).toBe("built\n");
  });

  it("reads the pipeline event log newest first", async () => {
    route([
      [
        "GET",
        "/api/2.0/pipelines/p1/events",
        {
          events: [
            { timestamp: "2026-10-01T10:00:00Z", level: "INFO", event_type: "x", message: "m" },
          ],
        },
      ],
    ]);
    const logs = await client().getLogs(
      "databricks-pipeline",
      "acct:databricks-pipeline:p1",
      "acct",
      {
        tailLines: 50,
      },
    );
    expect(calls[0]!.path).toContain("max_results=50");
    expect(calls[0]!.path).toContain("order_by=timestamp%20desc");
    expect(logs.text).toContain("INFO");
  });
});
