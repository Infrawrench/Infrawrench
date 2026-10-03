import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { fetchAzureMetricSeries, metricInterval, normalizeAzureUnit } from "../metrics.js";
import { fetchAzureLogs, formatStreamLine, SYSTEM_LOGS } from "../logs.js";
import { renderAzureDetail } from "../renderers.js";
import { plugin } from "../plugin.js";
import type { AzureHttpContext } from "../shared.js";

const SUB = "/subscriptions/sub1/resourceGroups/rg1/providers";

function ctxWith(
  get: (url: string) => unknown,
  post: (url: string) => unknown = () => ({}),
): AzureHttpContext & { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (url: string) => {
      const out = get(url);
      if (out instanceof Error) throw out;
      return out;
    }),
    post: vi.fn(async (url: string) => post(url)),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    subscriptionId: "sub1",
    tenantId: "t1",
  } as never;
}

function instance(resourceTypeId: string, fields: Record<string, unknown>): ResourceInstance {
  return {
    id: `acct:${resourceTypeId}:rg1/x1`,
    pluginId: "azure",
    resourceTypeId,
    accountId: "acct",
    displayName: "x1",
    fields: { name: "x1", resourceGroup: "rg1", ...fields },
    resolvedOutputs: {},
    secretStates: [],
    externalId: "rg1/x1",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  } as ResourceInstance;
}

describe("Azure Monitor metric series", () => {
  it("normalizes Azure units into the host's chart units", () => {
    expect(normalizeAzureUnit("Bytes")).toEqual({ unit: "bytes", scale: 1 });
    expect(normalizeAzureUnit("BytesPerSecond")).toEqual({ unit: "bytes/s", scale: 1 });
    expect(normalizeAzureUnit("BitsPerSecond")).toEqual({ unit: "bytes/s", scale: 1 / 8 });
    expect(normalizeAzureUnit("Percent")).toEqual({ unit: "%", scale: 1 });
    expect(normalizeAzureUnit("MilliSeconds")).toEqual({ unit: "ms", scale: 1 });
    expect(normalizeAzureUnit("Count")).toEqual({ unit: "", scale: 1 });
    expect(normalizeAzureUnit("NanoCores")).toEqual({ unit: " cores", scale: 1e-9 });
    expect(normalizeAzureUnit("Furlongs")).toEqual({ unit: "Furlongs", scale: 1 });
  });

  it("widens the bucket as the window grows", () => {
    expect(metricInterval(3_600_000)).toBe("PT5M");
    expect(metricInterval(24 * 3_600_000)).toBe("PT15M");
    expect(metricInterval(3 * 24 * 3_600_000)).toBe("PT30M");
    expect(metricInterval(7 * 24 * 3_600_000)).toBe("PT1H");
    expect(metricInterval(30 * 24 * 3_600_000)).toBe("PT6H");
  });

  it("requests a counter's own aggregation and reads that field", async () => {
    const ctx = ctxWith((url) => {
      if (!url.includes("metricnames=TotalPullCount")) return new Error("400");
      return {
        value: [
          {
            name: { value: "TotalPullCount", localizedValue: "Total Pull Count" },
            unit: "Count",
            timeseries: [{ data: [{ timeStamp: "2026-10-01T00:00:00Z", total: 12, average: 3 }] }],
          },
        ],
      };
    });
    const series = await fetchAzureMetricSeries(
      ctx,
      "azure-container-registry",
      instance("azure-container-registry", {}),
      { startMs: 0, endMs: 3_600_000 },
    );
    expect(series).toEqual([
      {
        label: "Total Pull Count",
        points: [{ timestamp: Date.parse("2026-10-01T00:00:00Z"), value: 12 }],
      },
    ]);
    const pullUrl = ctx.get.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes("TotalPullCount"));
    expect(pullUrl).toContain("&aggregation=Total");
    expect(pullUrl).toContain("&interval=PT5M");
    expect(pullUrl).toContain(
      `${SUB}/Microsoft.ContainerRegistry/registries/x1/providers/Microsoft.Insights/metrics`,
    );
  });

  it("scales nanocores into cores and keeps descriptor order across workers", async () => {
    const ctx = ctxWith((url) => {
      const name = decodeURIComponent(/metricnames=([^&]+)/.exec(url)?.[1] ?? "");
      const unit = name === "UsageNanoCores" ? "NanoCores" : "Count";
      return {
        value: [
          {
            name: { value: name, localizedValue: name },
            unit,
            timeseries: [
              {
                data: [
                  { timeStamp: "2026-10-01T00:00:00Z", total: 5e8, average: 5e8, maximum: 5e8 },
                ],
              },
            ],
          },
        ],
      };
    });
    const series = await fetchAzureMetricSeries(
      ctx,
      "azure-container-app-job",
      instance("azure-container-app-job", {}),
    );
    expect(series.map((s) => s.label)).toEqual([
      "Executions",
      "UsageNanoCores",
      "UsageBytes",
      "RequestedCores",
      "RequestedBytes",
      "RestartCount",
      "RxBytes",
      "TxBytes",
    ]);
    expect(series[1]).toMatchObject({ unit: " cores", points: [{ value: 0.5 }] });
    expect(ctx.get.mock.calls[0]![0]).toContain(`${SUB}/Microsoft.App/jobs/x1/providers`);
  });

  it("renders a Metrics tab for the Container Apps environment and job", () => {
    const client = plugin.createClient({
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
      subscriptionId: "sub1",
    });
    for (const type of ["azure-container-app-environment", "azure-container-app-job"]) {
      expect(client.renderDetail!(instance(type, {})).metricsCapability).toBeDefined();
    }
  });
});

describe("Azure container logs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tails a Container Instance container with timestamps", async () => {
    const ctx = ctxWith((url) => {
      if (url.includes("/logs?")) return { content: "2026-10-01T00:00:00Z hello" };
      return { properties: { containers: [{ name: "web" }, { name: "sidecar" }] } };
    });
    const out = await fetchAzureLogs(
      ctx,
      "azure-container-instance",
      "acct:azure-container-instance:rg1/grp",
      { tailLines: 50, container: "sidecar" },
    );
    expect(out).toEqual({
      text: "2026-10-01T00:00:00Z hello\n",
      containers: ["web", "sidecar"],
      activeContainer: "sidecar",
    });
    expect(String(ctx.get.mock.calls[1]![0])).toBe(
      `https://management.azure.com${SUB}/Microsoft.ContainerInstance/containerGroups/grp/containers/sidecar/logs?api-version=2023-05-01&tail=50&timestamps=true`,
    );
  });

  it("streams a Container App replica's console log through the regional host", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response('{"TimeStamp":"2026-10-01T00:00:00Z","Log":"listening on 8080"}\n'),
      );
    const ctx = ctxWith(
      (url) => {
        if (url.includes("/replicas?")) {
          return {
            value: [{ name: "api--r2-abc", properties: { containers: [{ name: "api" }] } }],
          };
        }
        return {
          location: "East US",
          properties: {
            latestRevisionName: "api--r2",
            eventStreamEndpoint:
              "https://eastus.azurecontainerapps.dev/subscriptions/sub1/resourceGroups/rg1/containerApps/api/eventstream",
          },
        };
      },
      () => ({ properties: { token: "stream-tok" } }),
    );
    const out = await fetchAzureLogs(
      ctx,
      "azure-container-app",
      "acct:azure-container-app:rg1/api",
      {
        tailLines: 1000,
      },
    );
    expect(out).toEqual({
      text: "2026-10-01T00:00:00Z listening on 8080\n",
      containers: ["api--r2-abc/api", SYSTEM_LOGS],
      activeContainer: "api--r2-abc/api",
    });
    expect(String(ctx.post.mock.calls[0]![0])).toContain(
      "/Microsoft.App/containerApps/api/getAuthToken?api-version=2025-07-01",
    );
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://eastus.azurecontainerapps.dev/subscriptions/sub1/resourceGroups/rg1/containerApps/api/revisions/api--r2/replicas/api--r2-abc/containers/api/logstream?follow=false&output=json&tailLines=300",
    );
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer stream-tok" });
  });

  it("falls back to system events when the app has no replicas", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    const ctx = ctxWith(
      (url) =>
        url.includes("/replicas?")
          ? { value: [] }
          : { location: "westeurope", properties: { latestRevisionName: "api--r1" } },
      () => ({ properties: { token: "t" } }),
    );
    const out = await fetchAzureLogs(
      ctx,
      "azure-container-app",
      "acct:azure-container-app:rg1/api",
      {},
    );
    expect(out.activeContainer).toBe(SYSTEM_LOGS);
    expect(out.text).toMatch(/scaled to zero/);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://westeurope.azurecontainerapps.dev/subscriptions/sub1/resourceGroups/rg1/containerApps/api/eventstream?follow=false&output=json&tailLines=200",
    );
  });

  it("reads an environment's system event stream", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          '{"TimeStamp":"2026-10-01T00:00:00Z","Type":"Normal","Reason":"ReplicaScheduled","Msg":"Replica scheduled","ReplicaName":"api--r1-x"}\n',
        ),
      );
    const ctx = ctxWith(
      () => ({
        properties: {
          eventStreamEndpoint:
            "https://eastus.azurecontainerapps.dev/subscriptions/sub1/resourceGroups/rg1/managedEnvironments/env1/eventstream",
        },
      }),
      () => ({ properties: { token: "t" } }),
    );
    const out = await fetchAzureLogs(
      ctx,
      "azure-container-app-environment",
      "acct:azure-container-app-environment:rg1/env1",
      { tailLines: 20 },
    );
    expect(out.text).toBe(
      "2026-10-01T00:00:00Z [Normal ReplicaScheduled] Replica scheduled (api--r1-x)\n",
    );
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://eastus.azurecontainerapps.dev/subscriptions/sub1/resourceGroups/rg1/managedEnvironments/env1/eventstream?follow=false&tailLines=20",
    );
  });

  it("passes unparseable stream lines through untouched", () => {
    expect(formatStreamLine("plain text")).toBe("plain text");
    expect(formatStreamLine('{"other":1}')).toBe('{"other":1}');
  });

  it("rejects types without a log source and declares the Logs tab only where one exists", async () => {
    await expect(
      fetchAzureLogs(
        ctxWith(() => ({})),
        "azure-vm",
        "acct:azure-vm:rg1/vm",
        {},
      ),
    ).rejects.toThrow(/not supported/);
    expect(
      renderAzureDetail(instance("azure-container-app", {}), plugin.resourceTypes).logs,
    ).toEqual({
      defaultTailLines: 200,
    });
    expect(renderAzureDetail(instance("azure-vm", {}), plugin.resourceTypes).logs).toBeUndefined();
  });
});
