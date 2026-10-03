import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpClientContext } from "../shared.js";
import {
  alignmentPeriodSeconds,
  fetchMetricSeries,
  getLogs,
  GCP_LOG_TYPES,
} from "../monitoring-client.js";
import { plugin } from "../plugin.js";
import { GcpClient } from "../client.js";

function resource(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:type:ext",
    pluginId: "gcp",
    resourceTypeId: "x",
    accountId: "acct",
    displayName: "name",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    externalId: "ext",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

/** Fields that satisfy every type's metric and log scope. */
const FIELDS = {
  name: "thing",
  numericId: "123",
  region: "us-central1",
  location: "us-central1",
};

interface Query {
  filter: string;
  aligner: string | null;
  reducer: string | null;
  period: string | null;
}

function metricsCtx(fields: ResourceInstance["fields"] = FIELDS, externalId = "ext") {
  const queries: Query[] = [];
  const get = vi.fn(async (url: string) => {
    const u = new URL(url);
    queries.push({
      filter: u.searchParams.get("filter") ?? "",
      aligner: u.searchParams.get("aggregation.perSeriesAligner"),
      reducer: u.searchParams.get("aggregation.crossSeriesReducer"),
      period: u.searchParams.get("aggregation.alignmentPeriod"),
    });
    // Newest first, as Cloud Monitoring returns them.
    return {
      timeSeries: [
        {
          points: [
            { interval: { endTime: "2026-01-01T00:02:00Z" }, value: { doubleValue: 0.25 } },
            { interval: { endTime: "2026-01-01T00:01:00Z" }, value: { int64Value: "2" } },
          ],
        },
      ],
    };
  });
  const ctx: GcpClientContext = {
    project: "proj",
    serviceAccountKey: { client_email: "sa@x", project_id: "proj" } as never,
    hostServices: undefined,
    token: vi.fn(async () => "tok"),
    get: get as never,
    paginate: vi.fn(async () => []),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-01-01T00:00:00.000Z",
    getResource: vi.fn(async () => resource({ fields, externalId })),
  };
  return { ctx, queries };
}

let fetchSpy: Mock;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy as never);
});
afterEach(() => vi.restoreAllMocks());

const metricTypes = plugin.resourceTypes.filter((t) => t.supportsMetrics === true).map((t) => t.id);

describe("fetchMetricSeries", () => {
  it.each(metricTypes)("%s has a metric plan", async (typeId) => {
    const { ctx, queries } = metricsCtx();
    const series = await fetchMetricSeries(ctx, typeId, "rid", "acct");
    expect(series.length).toBeGreaterThan(0);
    expect(queries.length).toBe(series.length);
    for (const q of queries) expect(q.reducer).toBeTruthy();
  });

  it("collapses labelled series, sorts oldest first and scales fractions", async () => {
    const { ctx, queries } = metricsCtx();
    const series = await fetchMetricSeries(ctx, "gce-instance", "rid", "acct");
    const cpu = series.find((s) => s.label === "CPU Utilization")!;
    expect(cpu.unit).toBe("%");
    expect(cpu.points.map((p) => p.value)).toEqual([200, 25]);
    expect(cpu.points[0]!.timestamp).toBeLessThan(cpu.points[1]!.timestamp);

    const sent = series.find((s) => s.label === "Network Sent")!;
    expect(sent.unit).toBe("bytes/s");
    const sentQuery = queries.find((q) => q.filter.includes("network/sent_bytes_count"))!;
    expect(sentQuery.aligner).toBe("ALIGN_RATE");
    expect(sentQuery.reducer).toBe("REDUCE_SUM");
    expect(sentQuery.filter).toContain('resource.type="gce_instance"');
    expect(sentQuery.filter).toContain('resource.labels.instance_id="123"');
  });

  it("charts Cloud Run latency as a real p95 and 5xx by response class", async () => {
    const { ctx, queries } = metricsCtx();
    await fetchMetricSeries(ctx, "cloud-run-service", "rid", "acct");
    const latency = queries.find((q) => q.filter.includes("run.googleapis.com/request_latencies"))!;
    expect(latency.aligner).toBe("ALIGN_DELTA");
    expect(latency.reducer).toBe("REDUCE_PERCENTILE_95");
    expect(queries.some((q) => q.filter.includes('metric.labels.response_code_class="5xx"'))).toBe(
      true,
    );
  });

  it("counts GKE nodes from per-node series", async () => {
    const { ctx, queries } = metricsCtx();
    const series = await fetchMetricSeries(ctx, "gke-cluster", "rid", "acct");
    expect(series.map((s) => s.label)).toContain("Node Count");
    const count = queries.find((q) => q.reducer === "REDUCE_COUNT")!;
    expect(count.filter).toContain('resource.type="k8s_node"');
    expect(count.filter).toContain('resource.labels.cluster_name="thing"');
    expect(queries.some((q) => q.filter.includes("kubernetes.io/cluster/"))).toBe(false);
  });

  it("scopes the new types by their monitored-resource labels", async () => {
    const cases: [string, string][] = [
      ["gcs-bucket", 'resource.labels.bucket_name="thing"'],
      ["bigquery-dataset", 'resource.labels.dataset_id="thing"'],
      ["spanner-instance", 'resource.labels.instance_id="thing"'],
      ["bigtable-instance", 'resource.labels.instance="thing"'],
      ["filestore-instance", 'resource.labels.instance_name="thing"'],
      ["workflow", 'resource.labels.workflow_id="thing"'],
      ["dataflow-job", 'resource.labels.job_name="thing"'],
      ["memorystore-memcached", 'resource.type="memcache_node"'],
      ["app-engine-service", 'resource.labels.module_id="thing"'],
      ["composer-environment", 'resource.labels.environment_name="thing"'],
    ];
    for (const [typeId, clause] of cases) {
      const { ctx, queries } = metricsCtx();
      await fetchMetricSeries(ctx, typeId, "rid", "acct");
      expect(
        queries.every((q) => q.filter.includes(clause)),
        typeId,
      ).toBe(true);
    }
  });

  it("keys Vertex endpoints by the trailing endpoint id", async () => {
    const { ctx, queries } = metricsCtx({
      name: "projects/proj/locations/us-central1/endpoints/42",
      region: "us-central1",
    });
    await fetchMetricSeries(ctx, "vertex-ai-endpoint", "rid", "acct");
    expect(queries.every((q) => q.filter.includes('resource.labels.endpoint_id="42"'))).toBe(true);
  });

  it("converts Pub/Sub publish latency from microseconds to ms", async () => {
    const { ctx } = metricsCtx();
    const series = await fetchMetricSeries(ctx, "pubsub-topic", "rid", "acct");
    const latency = series.find((s) => s.label === "Publish Latency (p95)")!;
    expect(latency.unit).toBe("ms");
    expect(latency.points[1]!.value).toBeCloseTo(0.00025);
  });

  it("returns nothing for types without a plan", async () => {
    const { ctx, queries } = metricsCtx();
    expect(await fetchMetricSeries(ctx, "kms-key", "rid", "acct")).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("drops empty and failing series", async () => {
    const { ctx } = metricsCtx();
    let n = 0;
    ctx.get = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("403");
      return { timeSeries: [] };
    }) as never;
    expect(await fetchMetricSeries(ctx, "bigquery-dataset", "rid", "acct")).toEqual([]);
  });
});

describe("alignmentPeriodSeconds", () => {
  it("keeps a minute for short windows and widens long ones", () => {
    expect(alignmentPeriodSeconds(0, 3_600_000)).toBe(60);
    expect(alignmentPeriodSeconds(0, 24 * 3_600_000)).toBe(300);
    expect(alignmentPeriodSeconds(0, 30 * 24 * 3_600_000) % 60).toBe(0);
  });
});

describe("getLogs", () => {
  const filterFor = async (typeId: string, fields = FIELDS, externalId = "ext") => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ entries: [] })));
    const { ctx } = metricsCtx(fields, externalId);
    const out = await getLogs(ctx, typeId, "rid", "acct", {});
    const body = JSON.parse(String((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body)) as {
      filter: string;
    };
    return { filter: body.filter, out };
  };

  it("scopes each newly supported type", async () => {
    expect((await filterFor("gce-instance")).filter).toBe(
      'resource.type="gce_instance" AND resource.labels.instance_id="123"',
    );
    expect((await filterFor("cloudsql-instance")).filter).toBe(
      'resource.type="cloudsql_database" AND resource.labels.database_id="proj:thing"',
    );
    expect((await filterFor("cloud-scheduler-job")).filter).toBe(
      'resource.type="cloud_scheduler_job" AND resource.labels.job_id="thing" AND resource.labels.location="us-central1"',
    );
    expect((await filterFor("workflow")).filter).toBe(
      'resource.type="workflows.googleapis.com/Workflow" AND resource.labels.workflow_id="thing" AND resource.labels.location="us-central1"',
    );
    expect((await filterFor("dataflow-job", FIELDS, "2026-01-01_job")).filter).toBe(
      'resource.type="dataflow_step" AND resource.labels.job_id="2026-01-01_job"',
    );
    expect((await filterFor("app-engine-service")).filter).toBe(
      'resource.type="gae_app" AND resource.labels.module_id="thing"',
    );
    expect((await filterFor("composer-environment")).filter).toContain(
      'resource.labels.environment_name="thing"',
    );
    const gke = await filterFor("gke-cluster");
    expect(gke.filter).toContain('resource.type="k8s_container"');
    expect(gke.filter).toContain('resource.labels.cluster_name="thing"');
    expect(gke.out.activeContainer).toBe("cluster");
  });

  it("no longer narrows Cloud Tasks logs with a literal target_type", async () => {
    expect((await filterFor("cloud-tasks-queue")).filter).toBe(
      'resource.type="cloud_tasks_queue" AND resource.labels.queue_id="thing" AND resource.labels.location="us-central1"',
    );
  });

  it("renders protoPayload entries such as audit logs", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          entries: [{ timestamp: "t", severity: "NOTICE", protoPayload: { methodName: "m" } }],
        }),
      ),
    );
    const { ctx } = metricsCtx();
    const out = await getLogs(ctx, "cloudsql-instance", "rid", "acct", {});
    expect(out.text).toBe('t [NOTICE] {"methodName":"m"}');
  });

  it("throws when the keying identifier is missing", async () => {
    const { ctx } = metricsCtx({ name: "thing" });
    await expect(getLogs(ctx, "gce-instance", "rid", "acct", {})).rejects.toThrow(
      "missing the identifier",
    );
  });
});

describe("detail capabilities", () => {
  const client = new GcpClient(
    {
      serviceAccountJson: JSON.stringify({
        type: "service_account",
        project_id: "proj",
        private_key_id: "kid",
        private_key: "k",
        client_email: "sa@proj.iam.gserviceaccount.com",
        client_id: "1",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    },
    plugin.resourceTypes,
  );

  it("every metrics type renders a Metrics tab and every log type a Logs tab", () => {
    for (const t of plugin.resourceTypes) {
      const schema = client.renderDetail(
        resource({ resourceTypeId: t.id, fields: { ...FIELDS }, displayName: "thing" }),
      );
      expect(Boolean(schema.metricsCapability), t.id).toBe(t.supportsMetrics === true);
      if (GCP_LOG_TYPES.has(t.id)) expect(schema.logs, t.id).toBeDefined();
    }
  });
});
