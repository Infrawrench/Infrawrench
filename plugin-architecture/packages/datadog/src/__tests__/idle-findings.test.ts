import { describe, expect, it } from "vitest";
import { pluginManifestSchema, type IdleScanRequest } from "@infrawrench/plugin-base";
import {
  DATADOG_IDLE_FINDINGS,
  datadogMetricListFetch,
  fetchDatadogIdleFindings,
  MAX_UNUSED_METRIC_FINDINGS,
} from "../idle-findings.js";
import { datadogRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";
import { DatadogClient } from "../client.js";
import { makeHttp } from "./helpers.js";

function request(thresholds = { notQueriedDays: 30, minIndexedSeries: 1 }): IdleScanRequest {
  return {
    lookbackDays: 14,
    windowEnd: "2026-10-16T00:00:00Z",
    rules: { "unused-custom-metric": { thresholds } },
    resources: [],
  };
}

/** One page of `GET /api/v2/metrics` with volumes. */
function page(metrics: Array<[string, number]>, nextCursor: string | null = null) {
  return {
    data: metrics.map(([id]) => ({ id, type: "metrics" })),
    included: metrics.map(([id, indexed]) => ({
      id,
      type: "metric_volumes",
      attributes: { indexed_volume: indexed, ingested_volume: indexed * 2 },
    })),
    meta: { pagination: { next_cursor: nextCursor } },
  };
}

function client(route: (url: URL) => unknown) {
  const { http, calls } = makeHttp((url) => ({ body: route(url) }));
  const c = new DatadogClient({ apiKey: "test-api-key", appKey: "test-app-key", site: "us5" }, {
    http,
  } as never);
  return { c, calls };
}

describe("declaration", () => {
  it("is on the manifest, validates, and judges no synced type", () => {
    expect(plugin.manifest.idleFindings).toBe(DATADOG_IDLE_FINDINGS);
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(DATADOG_IDLE_FINDINGS.rules[0]!.resourceTypeIds).toEqual([]);
    expect(plugin.remediationCommands).toBe(datadogRemediationCommands);
  });
});

describe("unused custom metrics", () => {
  it("lists unqueried metrics that no asset uses, largest first, priced at list", async () => {
    const { c, calls } = client((url) =>
      url.searchParams.get("filter[related_assets]") === "true"
        ? page([["checkout.latency", 40]])
        : page([
            ["checkout.latency", 40],
            ["legacy.queue.depth", 12],
            ["batch.rows", 900],
          ]),
    );
    const findings = await c.fetchIdleFindings("acct", request());
    expect(findings.map((f) => f.subjectKey)).toEqual(["batch.rows", "legacy.queue.depth"]);
    expect(findings[0]).toMatchObject({
      resourceId: null,
      resourceTypeId: null,
      subjectLabel: "Custom metric",
      estimate: { monthlyAmount: 45, currency: "USD", basis: "list-price" },
      fields: { apiUrl: "https://api.us5.datadoghq.com" },
    });
    expect(findings[0]!.reason).toBe(
      "Not queried in 30 days and used by no dashboard, monitor, notebook or SLO, while indexing 900 series",
    );
    const first = calls[0]!.url;
    expect(first.pathname).toBe("/api/v2/metrics");
    expect(first.searchParams.get("filter[queried]")).toBe("false");
    expect(first.searchParams.get("filter[queried][window][seconds]")).toBe(String(30 * 86_400));
    expect(first.searchParams.get("include")).toBe("metric_volumes");
    expect(first.searchParams.get("window[seconds]")).toBe("86400");
    expect(calls[0]!.headers["DD-API-KEY"]).toBe("test-api-key");
  });

  it("follows the cursor and honours the minimum series threshold", async () => {
    let unqueriedPage = 0;
    const { c } = client((url) => {
      if (url.searchParams.get("filter[related_assets]") === "true") return page([]);
      unqueriedPage += 1;
      return unqueriedPage === 1 ? page([["a", 5]], "next-1") : page([["b", 500]]);
    });
    const findings = await c.fetchIdleFindings(
      "acct",
      request({ notQueriedDays: 90, minIndexedSeries: 10 }),
    );
    expect(findings.map((f) => f.subjectKey)).toEqual(["b"]);
  });

  it("caps the findings and skips the second read when nothing is unqueried", async () => {
    const many = Array.from(
      { length: MAX_UNUSED_METRIC_FINDINGS + 20 },
      (_, i) => [`m${i}`, i + 1] as [string, number],
    );
    const reads: string[] = [];
    const findings = await fetchDatadogIdleFindings(request(), {
      apiUrl: "https://api.datadoghq.com",
      fetchPage: async (q) => {
        reads.push(String(q["filter[related_assets]"] ?? "unqueried"));
        return q["filter[related_assets]"] ? page([]) : page(many);
      },
    });
    expect(findings).toHaveLength(MAX_UNUSED_METRIC_FINDINGS);
    expect(reads).toEqual(["unqueried", "true"]);

    const none: string[] = [];
    expect(
      await fetchDatadogIdleFindings(request(), {
        apiUrl: "https://api.datadoghq.com",
        fetchPage: async (q) => {
          none.push(String(q["filter[related_assets]"] ?? "unqueried"));
          return page([]);
        },
      }),
    ).toEqual([]);
    expect(none).toEqual(["unqueried"]);
  });

  it("does nothing when the rule is off", async () => {
    const { c, calls } = client(() => page([["x", 1]]));
    expect(await c.fetchIdleFindings("acct", { ...request(), rules: {} })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("turns a 403 into an access error naming the scope", async () => {
    const { http } = makeHttp(() => ({ status: 403, body: { errors: ["Forbidden"] } }));
    const fetchPage = datadogMetricListFetch({
      apiKey: "k",
      appKey: "a",
      site: { id: "us1", label: "US1", apiUrl: "https://api.datadoghq.com" } as never,
      http: http as never,
    });
    await expect(fetchPage({})).rejects.toMatchObject({ name: "IdleFindingAccessError" });
  });
});

describe("remediation", () => {
  it("re-checks assets and volumes with read-only curl calls", () => {
    const cmds = datadogRemediationCommands({
      kind: "orphan",
      reason: "unused",
      idleRuleId: "unused-custom-metric",
      resource: {
        resourceTypeId: "",
        displayName: "batch.rows",
        externalId: "batch.rows",
        fields: { apiUrl: "https://api.datadoghq.eu" },
      },
    });
    expect(cmds.map((c) => c.command)).toEqual([
      'curl -sS https://api.datadoghq.eu/api/v2/metrics/batch.rows/assets -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY"',
      'curl -sS https://api.datadoghq.eu/api/v2/metrics/batch.rows/volumes -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY"',
    ]);
    expect(cmds.every((c) => !c.destructive)).toBe(true);
  });

  it("answers nothing else", () => {
    expect(
      datadogRemediationCommands({
        kind: "orphan",
        reason: "x",
        resource: { resourceTypeId: "monitor", displayName: "m", externalId: "1", fields: {} },
      }),
    ).toEqual([]);
  });
});
