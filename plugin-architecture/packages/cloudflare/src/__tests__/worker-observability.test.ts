import { describe, it, expect, vi, type Mock } from "vitest";
import {
  WORKER_LOG_FILTERS,
  calculationSeries,
  enrichWorkerDetail,
  fetchRecentWorkerTraces,
  fetchWorkerLogs,
  fetchWorkerTelemetrySeries,
  formatWorkerLogLine,
} from "../clients/worker-observability.js";
import { workerBucketDimension } from "../worker-metrics.js";
import { renderWorkerDetail } from "../detail-renderers.js";
import { makeApi } from "./_helpers.js";
import type { ResourceInstance } from "@infrawrench/plugin-base";

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);

function obsApi(
  opts: {
    query?: Mock;
    observability?: Record<string, unknown> | null;
  } = {},
) {
  const query = opts.query ?? vi.fn(async () => ({ events: { events: [] } }));
  const settingsGet = vi.fn(async () => ({
    observability: opts.observability === undefined ? { enabled: true } : opts.observability,
  }));
  const api = makeApi({
    cf: {
      workers: {
        observability: { telemetry: { query } },
        scripts: { settings: { get: settingsGet } },
      },
    },
  });
  return { api, query, settingsGet };
}

const invocation = {
  timestamp: T0,
  dataset: "cloudflare-workers",
  source: {},
  $metadata: {
    id: "e1",
    type: "cf-worker-event",
    trigger: "GET /api/users",
    statusCode: 500,
    requestId: "abcdef1234567890",
    region: "LHR",
  },
  $workers: {
    eventType: "fetch",
    outcome: "exception",
    requestId: "abcdef1234567890",
    scriptName: "w1",
    cpuTimeMs: 3.21,
    wallTimeMs: 41,
  },
};
const consoleLog = {
  timestamp: T0 - 1000,
  dataset: "cloudflare-workers",
  source: { message: "hello" },
  $metadata: {
    id: "e2",
    type: "cf-worker-log",
    level: "warn",
    message: "cache miss",
    requestId: "abcdef1234567890",
  },
};

describe("worker observability: logs", () => {
  it("formats an invocation with request metadata", () => {
    const line = formatWorkerLogLine(invocation as never);
    expect(line).toContain("2026-10-03T12:00:00.000Z");
    expect(line).toContain("ERROR");
    expect(line).toContain("GET /api/users");
    expect(line).toContain("500");
    expect(line).toContain("outcome=exception");
    expect(line).toContain("cpu=3.2ms");
    expect(line).toContain("wall=41ms");
    expect(line).toContain("colo=LHR");
    expect(line).toContain("req=abcdef12");
  });

  it("formats a console log with its level and message", () => {
    const line = formatWorkerLogLine(consoleLog as never);
    expect(line).toMatch(/WARN\s+req=abcdef12\s+cache miss$/);
  });

  it("queries events for the script, oldest first, with the picked filter", async () => {
    const { api, query } = obsApi({
      query: vi.fn(async () => ({ events: { events: [invocation, consoleLog] } })),
    });
    const out = await fetchWorkerLogs(api, "w1", { tailLines: 50, container: "errors" });
    expect(out.activeContainer).toBe("errors");
    expect(out.containers).toEqual(WORKER_LOG_FILTERS.map((f) => f.id));
    const lines = out.text.trim().split("\n");
    expect(lines[0]).toContain("cache miss");
    expect(lines[1]).toContain("outcome=exception");

    const body = query.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({
      account_id: "acct-cf",
      view: "events",
      limit: 50,
      dry: true,
      parameters: {
        datasets: ["cloudflare-workers"],
        filters: [
          { key: "$metadata.service", operation: "eq", value: "w1" },
          { key: "$metadata.level", operation: "eq", value: "error" },
        ],
      },
    });
  });

  it("clamps tailLines to the API's 2000-event cap", async () => {
    const { api, query } = obsApi({
      query: vi.fn(async () => ({ events: { events: [consoleLog] } })),
    });
    await fetchWorkerLogs(api, "w1", { tailLines: 50_000 });
    expect((query.mock.calls[0]![0] as { limit: number }).limit).toBe(2000);
  });

  it("widens to the retention window, then explains when observability is off", async () => {
    const { api, query } = obsApi({ observability: { enabled: false } });
    const out = await fetchWorkerLogs(api, "w1", {});
    expect(query).toHaveBeenCalledTimes(2);
    const [first, second] = query.mock.calls.map(
      (c) => (c[0] as { timeframe: { from: number; to: number } }).timeframe,
    );
    expect(first!.to - first!.from).toBe(24 * 3_600_000);
    expect(second!.to - second!.from).toBe(7 * 24 * 3_600_000);
    expect(out.text).toMatch(/Workers Logs is off/);
    expect(out.text).toMatch(/Settings tab/);
  });

  it("explains a quiet Worker differently from a disabled one", async () => {
    const { api } = obsApi({ observability: { enabled: true } });
    const out = await fetchWorkerLogs(api, "w1", { container: "errors" });
    expect(out.text).toMatch(/No log events matching "errors"/);
  });

  it("explains logs switched off under an enabled observability block", async () => {
    const { api } = obsApi({
      observability: { enabled: true, logs: { enabled: false, invocation_logs: false } },
    });
    const out = await fetchWorkerLogs(api, "w1", {});
    expect(out.text).toMatch(/logs are turned off/);
  });

  it("maps an auth failure onto the Workers Observability permission hint", async () => {
    const err = Object.assign(new Error("403"), {
      status: 403,
      errors: [{ code: 10000, message: "Authentication error" }],
    });
    const { api } = obsApi({ query: vi.fn(async () => Promise.reject(err)) });
    await expect(fetchWorkerLogs(api, "w1", {})).rejects.toThrow(/Workers Observability/);
  });
});

describe("worker observability: traces and series", () => {
  const trace = {
    traceId: "t1",
    rootSpanName: "fetch",
    rootTransactionName: "GET /",
    service: ["w1", "auth"],
    spans: 7,
    traceDurationMs: 1234,
    traceStartMs: T0,
    traceEndMs: T0 + 1234,
    errors: ["boom"],
  };

  it("fetches traces newest first", async () => {
    const older = { ...trace, traceId: "t0", traceStartMs: T0 - 5000 };
    const { api, query } = obsApi({ query: vi.fn(async () => ({ traces: [older, trace] })) });
    const out = await fetchRecentWorkerTraces(api, "w1", 10);
    expect(out.map((t) => t.traceId)).toEqual(["t1", "t0"]);
    expect(query.mock.calls[0]![0]).toMatchObject({ view: "traces", limit: 10 });
  });

  it("splits a grouped calculation into one series per group", () => {
    const out = calculationSeries(
      {
        calculation: "count",
        alias: "events",
        aggregates: [],
        series: [
          {
            time: new Date(T0).toISOString(),
            data: [
              {
                count: 1,
                interval: 1,
                sampleInterval: 1,
                value: 4,
                groups: [{ key: "l", value: "error" }],
              },
              {
                count: 1,
                interval: 1,
                sampleInterval: 1,
                value: 9,
                groups: [{ key: "l", value: "log" }],
              },
            ],
          },
        ],
      },
      (g) => `Log events: ${g}`,
      "events",
    );
    expect(out.map((s) => s.label)).toEqual(["Log events: error", "Log events: log"]);
    expect(out[0]!.points).toEqual([{ timestamp: T0, value: 4 }]);
  });

  it("builds log-level and span series, dropping a failed half", async () => {
    const time = new Date(T0).toISOString();
    const query = vi.fn(async (body: { queryId: string }) => {
      if (body.queryId === "infrawrench-worker-spans") throw new Error("nope");
      return {
        calculations: [
          {
            calculation: "count",
            alias: "events",
            aggregates: [],
            series: [
              {
                time,
                data: [
                  {
                    count: 1,
                    interval: 1,
                    sampleInterval: 1,
                    value: 3,
                    groups: [{ key: "x", value: "warn" }],
                  },
                ],
              },
            ],
          },
        ],
      };
    });
    const { api } = obsApi({ query });
    const out = await fetchWorkerTelemetrySeries(api, "w1", T0 - 3_600_000, T0);
    expect(out.map((s) => s.label)).toEqual(["Log events: warn"]);
  });

  it("picks coarser buckets for longer windows", () => {
    expect(workerBucketDimension(3_600_000)).toBe("datetimeFiveMinutes");
    expect(workerBucketDimension(48 * 3_600_000)).toBe("datetimeHour");
    expect(workerBucketDimension(30 * 24 * 3_600_000)).toBe("datetimeSixHours");
  });

  const worker: ResourceInstance = {
    id: "acct:worker:w1",
    pluginId: "cloudflare",
    resourceTypeId: "worker",
    accountId: "acct",
    displayName: "w1",
    fields: { name: "w1" },
    resolvedOutputs: { workerName: "w1" },
    secretStates: [],
    externalId: "w1",
    createdAt: "",
    updatedAt: "",
  };

  it("enriches with state and traces, and renders the Traces tab", async () => {
    const { api } = obsApi({
      observability: { enabled: true, traces: { enabled: true, head_sampling_rate: 0.1 } },
      query: vi.fn(async () => ({ traces: [trace] })),
    });
    const enriched = await enrichWorkerDetail(api, worker);
    const schema = renderWorkerDetail(enriched);
    expect(schema.logs).toBeTruthy();
    const tab = schema.customTabs?.find((t) => t.id === "worker-traces");
    const table = tab?.sections?.[0]?.children[0];
    expect(table).toMatchObject({ kind: "table" });
    expect(JSON.stringify(table)).toContain("1.23 s");
    expect(JSON.stringify(schema.sections)).toContain("Workers Traces");
  });

  it("keeps the Logs tab without enrichment and explains disabled traces", async () => {
    expect(renderWorkerDetail(worker).logs).toBeTruthy();
    expect(renderWorkerDetail(worker).customTabs).toBeUndefined();

    const { api, query } = obsApi({ observability: { enabled: false } });
    const enriched = await enrichWorkerDetail(api, worker);
    expect(query).not.toHaveBeenCalled();
    const schema = renderWorkerDetail(enriched);
    expect(JSON.stringify(schema.customTabs)).toMatch(/Workers Traces is off/);
    expect(JSON.stringify(schema.sections)).toMatch(/Workers Logs is off/);
  });
});
