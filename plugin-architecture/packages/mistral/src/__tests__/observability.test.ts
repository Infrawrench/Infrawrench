import { afterEach, describe, expect, it, vi } from "vitest";
import { MistralClient } from "../client.js";
import { plugin } from "../plugin.js";

const ACCOUNT = "acct-1";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function installFetch(handler: (url: string, body: Record<string, unknown>) => Response) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: String(url), body });
    return handler(String(url), body);
  }) as unknown as typeof fetch);
  return calls;
}

const client = () => new MistralClient({ apiKey: "test-key" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("model metrics", () => {
  it("aggregates the model's spans and scales latency to milliseconds", async () => {
    const calls = installFetch((_url, body) => {
      const metric = body["metric"] as { measure: string; aggregation: string };
      const value = metric.measure === "duration_ns" ? 250_000_000 : 7;
      return jsonResponse({
        data: [
          { time_bucket: "2026-10-02T01:00:00Z", metric_name: "m", metric_value: value },
          { time_bucket: "2026-10-02T00:00:00Z", metric_name: "m", metric_value: value },
        ],
        meta: { from_timestamp: "", to_timestamp: "" },
      });
    });

    const series = await client().fetchMetricSeries(
      "mistral-model",
      `${ACCOUNT}:mistral-model:mistral-large-latest`,
      ACCOUNT,
      { startMs: Date.parse("2026-10-02T00:00:00Z"), endMs: Date.parse("2026-10-03T00:00:00Z") },
    );

    expect(series.map((s) => s.label)).toEqual([
      "Calls",
      "Errored calls",
      "Latency p50",
      "Latency p95",
      "Input tokens",
      "Output tokens",
      "Cached input tokens",
    ]);
    expect(series.find((s) => s.label === "Latency p95")?.points).toEqual([
      { timestamp: Date.parse("2026-10-02T00:00:00Z"), value: 250 },
      { timestamp: Date.parse("2026-10-02T01:00:00Z"), value: 250 },
    ]);
    expect(series.find((s) => s.label === "Latency p95")?.unit).toBe("ms");

    const first = calls[0]!;
    expect(first.url).toBe(
      "https://api.mistral.ai/v1/observability/spans/aggregate?from=2026-10-02T00%3A00%3A00.000Z&to=2026-10-03T00%3A00%3A00.000Z",
    );
    expect(first.body).toEqual({
      metric: { measure: "span_id", aggregation: "count" },
      time_dimension: { granularity: "auto" },
      search_expression:
        "(request_model = 'mistral-large-latest' OR response_model = 'mistral-large-latest')",
    });
    expect(calls[1]?.body["search_expression"]).toBe(
      "(request_model = 'mistral-large-latest' OR response_model = 'mistral-large-latest') AND status_code = 'Error'",
    );
  });

  it("drops only the series the server rejects, and is empty without Observability", async () => {
    installFetch((_url, body) => {
      const metric = body["metric"] as { measure: string };
      if (metric.measure === "usage_cache_read_input_tokens") return jsonResponse("bad", 422);
      return jsonResponse({ data: [{ time_bucket: "2026-10-02T00:00:00Z", metric_value: 1 }] });
    });
    const series = await client().fetchMetricSeries(
      "mistral-model",
      `${ACCOUNT}:mistral-model:m`,
      ACCOUNT,
    );
    expect(series).toHaveLength(6);

    vi.restoreAllMocks();
    installFetch(() => jsonResponse({ detail: "forbidden" }, 403));
    expect(
      await client().fetchMetricSeries("mistral-model", `${ACCOUNT}:mistral-model:m`, ACCOUNT),
    ).toEqual([]);
  });
});

describe("agent metrics", () => {
  it("aggregates traces by agent_id, including tool and LLM call counts", async () => {
    const calls = installFetch(() =>
      jsonResponse({ data: [{ time_bucket: "2026-10-02T00:00:00Z", metric_value: 3 }] }),
    );
    const series = await client().fetchMetricSeries(
      "mistral-agent",
      `${ACCOUNT}:mistral-agent:ag_123`,
      ACCOUNT,
    );
    expect(series.map((s) => s.label)).toContain("Tool calls");
    expect(calls.every((c) => c.url.includes("/v1/observability/traces/aggregate?"))).toBe(true);
    expect(calls[0]?.body["search_expression"]).toBe("agent_id = 'ag_123'");
    expect(
      calls.find((c) => (c.body["metric"] as { measure: string }).measure === "tool_call_count"),
    ).toBeDefined();
  });

  it("returns nothing for types without Observability data", async () => {
    const calls = installFetch(() => jsonResponse({}));
    expect(
      await client().fetchMetricSeries("mistral-file", `${ACCOUNT}:mistral-file:f`, ACCOUNT),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("logs", () => {
  it("lists agent runs oldest first", async () => {
    const calls = installFetch(() =>
      jsonResponse({
        traces: {
          results: [
            {
              trace_id: "b",
              root_span_name: "conversation",
              start_time: "2026-10-02T02:00:00Z",
              duration_ns: 1_500_000_000,
              status_code: "Error",
              input_tokens: 10,
              output_tokens: 2,
              llm_call_count: 1,
              tool_call_count: 3,
            },
            {
              trace_id: "a",
              root_span_name: "conversation",
              start_time: "2026-10-02T01:00:00Z",
              duration_ns: 40_000_000,
              status_code: "Unset",
            },
          ],
        },
      }),
    );
    const result = await client().getLogs(
      "mistral-agent",
      `${ACCOUNT}:mistral-agent:ag_123`,
      ACCOUNT,
      { tailLines: 50 },
    );
    expect(calls[0]?.url).toContain("/v1/observability/traces/search?");
    expect(calls[0]?.url).toContain("page_size=50");
    expect(calls[0]?.body).toEqual({ search_expression: "agent_id = 'ag_123'" });
    expect(result.text.split("\n")).toEqual([
      "2026-10-02T01:00:00Z  OK  conversation  40ms  in=0  out=0  llm=0  tools=0  trace=a",
      "2026-10-02T02:00:00Z  ERROR  conversation  1.50s  in=10  out=2  llm=1  tools=3  trace=b",
      "",
    ]);
    expect(result.activeContainer).toBe("runs");
  });

  it("lists model calls from spans and explains a missing entitlement", async () => {
    const calls = installFetch(() =>
      jsonResponse({
        spans: {
          results: [
            {
              trace_id: "t",
              span_name: "chat mistral-small",
              start_time: "2026-10-02T01:00:00Z",
              duration_ns: 900_000_000,
              usage_input_tokens: 5,
              usage_output_tokens: 6,
              response_finish_reasons: ["stop"],
            },
          ],
        },
      }),
    );
    const result = await client().getLogs(
      "mistral-model",
      `${ACCOUNT}:mistral-model:mistral-small`,
      ACCOUNT,
      {},
    );
    expect(calls[0]?.url).toContain("/v1/observability/spans/search?");
    expect(result.text).toBe(
      "2026-10-02T01:00:00Z  OK  chat mistral-small  900ms  in=5  out=6  finish=stop  trace=t\n",
    );

    vi.restoreAllMocks();
    installFetch(() => jsonResponse({ detail: "no" }, 403));
    const denied = await client().getLogs(
      "mistral-model",
      `${ACCOUNT}:mistral-model:mistral-small`,
      ACCOUNT,
      {},
    );
    expect(denied.text).toMatch(/Private Preview/);
  });
});

describe("metrics contract", () => {
  it("renders Metrics and Logs tabs on exactly the metric-capable types", () => {
    for (const type of plugin.resourceTypes) {
      const schema = plugin.createClient({ apiKey: "k" }).renderDetail({
        id: `${ACCOUNT}:${type.id}:x`,
        pluginId: "mistral",
        resourceTypeId: type.id,
        accountId: ACCOUNT,
        displayName: "x",
        externalId: "x",
        fields: {},
        resolvedOutputs: {},
        secretStates: [],
        createdAt: "",
        updatedAt: "",
      });
      expect(Boolean(schema.metricsCapability)).toBe(type.supportsMetrics === true);
      expect(Boolean(schema.logs)).toBe(type.supportsMetrics === true);
    }
  });
});
