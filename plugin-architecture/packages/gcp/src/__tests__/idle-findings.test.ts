import { describe, expect, it, vi } from "vitest";
import {
  pluginManifestSchema,
  type IdleScanRequest,
  type IdleScanResource,
} from "@infrawrench/plugin-base";
import {
  fetchGcpIdleFindings,
  GCP_IDLE_FINDINGS,
  isSystemNamespace,
  monitoringReader,
  type DailySeries,
  type SeriesQuery,
} from "../idle-findings.js";
import { gcpRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

const DAYS = 14;
const days = (v: number, n = DAYS) => Array.from({ length: n }, () => v);

function res(
  id: string,
  resourceTypeId: string,
  fields: IdleScanResource["fields"],
): IdleScanResource {
  return { id, resourceTypeId, externalId: id, displayName: id, fields, resolvedOutputs: {} };
}

function request(resources: IdleScanResource[]): IdleScanRequest {
  const rules: IdleScanRequest["rules"] = {};
  for (const r of GCP_IDLE_FINDINGS.rules) {
    rules[r.id] = { thresholds: Object.fromEntries(r.thresholds.map((t) => [t.key, t.default])) };
  }
  return { lookbackDays: DAYS, windowEnd: "2026-10-16T12:00:00Z", rules, resources };
}

function reader(answer: (q: SeriesQuery) => DailySeries[]) {
  const seen: SeriesQuery[] = [];
  return {
    seen,
    read: async (q: SeriesQuery) => {
      seen.push(q);
      return answer(q);
    },
  };
}

const cluster = res("prod", "gke-cluster", {
  name: "prod",
  location: "europe-west1",
  status: "RUNNING",
  machineType: "e2-standard-4",
  nodeCount: 3,
});

describe("declaration", () => {
  it("is on the manifest, validates, and names declared types", () => {
    expect(plugin.manifest.idleFindings).toBe(GCP_IDLE_FINDINGS);
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    const types = new Set(plugin.resourceTypes.map((t) => t.id));
    for (const rule of GCP_IDLE_FINDINGS.rules) {
      for (const id of rule.resourceTypeIds) expect(types.has(id)).toBe(true);
    }
  });

  it("treats GKE-managed namespaces as system", () => {
    for (const ns of [
      "kube-system",
      "kube-node-lease",
      "gke-gmp-system",
      "gmp-public",
      "gke-managed-cim",
    ]) {
      expect(isSystemNamespace(ns)).toBe(true);
    }
    for (const ns of ["default", "payments", "istio-system"])
      expect(isSystemNamespace(ns)).toBe(false);
  });
});

describe("GKE cluster", () => {
  const nodeSeries = (cpuFraction: number): DailySeries[] => [
    { labels: {}, values: days(cpuFraction) },
  ];

  it("flags a cluster running only system pods, priced with the management fee and nodes", async () => {
    const { read, seen } = reader((q) =>
      q.metricType.endsWith("allocatable_utilization")
        ? nodeSeries(0.08)
        : [
            { labels: { namespace_name: "kube-system" }, values: days(0.2) },
            { labels: { namespace_name: "gke-gmp-system" }, values: days(0.05) },
          ],
    );
    const estimateCost = vi.fn(async () => ({
      monthlyAmount: 300,
      currency: "USD",
      lineItems: [],
    }));
    const [f] = await fetchGcpIdleFindings(request([cluster]), { read, estimateCost });
    expect(f!.reason).toMatch(/^No workloads outside GKE's own namespaces/);
    expect(f!.estimate).toMatchObject({ monthlyAmount: 373, currency: "USD", basis: "list-price" });
    const containers = seen.find((q) => q.metricType.endsWith("core_usage_time"))!;
    expect(containers.groupBy).toEqual(["resource.labels.namespace_name"]);
    expect(containers.filters).toContain('resource.labels.cluster_name="prod"');
    expect(containers.filters).toContain('resource.labels.location="europe-west1"');
  });

  it("flags near-zero node CPU even with a workload, and not a busy cluster", async () => {
    const quiet = reader((q) =>
      q.metricType.endsWith("allocatable_utilization")
        ? nodeSeries(0.01)
        : [{ labels: { namespace_name: "shop" }, values: days(0.01) }],
    );
    const [f] = await fetchGcpIdleFindings(request([cluster]), { read: quiet.read });
    expect(f!.reason).toMatch(/^Nodes averaged 1% CPU/);
    expect(f!.estimate?.note).toMatch(/^Management fee only/);

    const busy = reader((q) =>
      q.metricType.endsWith("allocatable_utilization")
        ? nodeSeries(0.4)
        : [{ labels: { namespace_name: "shop" }, values: days(2) }],
    );
    expect(await fetchGcpIdleFindings(request([cluster]), { read: busy.read })).toEqual([]);
  });

  it("skips a cluster with no node metrics (system metrics off) or not running", async () => {
    const none = reader(() => []);
    expect(await fetchGcpIdleFindings(request([cluster]), { read: none.read })).toEqual([]);
    const stopped = res("x", "gke-cluster", { ...cluster.fields, status: "STOPPING" });
    const r = reader(() => []);
    expect(await fetchGcpIdleFindings(request([stopped]), { read: r.read })).toEqual([]);
    expect(r.seen).toEqual([]);
  });
});

describe("Cloud NAT", () => {
  const nat = res("europe-west1/router-1/nat-1", "cloud-nat", {
    name: "nat-1",
    region: "europe-west1",
    router: "router-1",
  });

  it("flags a gateway holding ports but sending nothing, unpriced", async () => {
    const { read, seen } = reader((q) =>
      q.metricType.endsWith("allocated_ports") ? [{ labels: {}, values: days(64) }] : [],
    );
    const [f] = await fetchGcpIdleFindings(request([nat]), { read });
    expect(f).toMatchObject({ ruleId: "cloud-nat", estimate: null });
    expect(f!.evidence[0]).toMatchObject({ value: 0, threshold: 1_000_000 });
    expect(seen[0]!.filters).toContain('resource.labels.gateway_name="nat-1"');
  });

  it("does not judge a gateway with no assigned VMs, or one with traffic", async () => {
    expect(await fetchGcpIdleFindings(request([nat]), { read: reader(() => []).read })).toEqual([]);
    const busy = reader((q) => [
      { labels: {}, values: q.metricType.endsWith("allocated_ports") ? days(64) : days(5e7) },
    ]);
    expect(await fetchGcpIdleFindings(request([nat]), { read: busy.read })).toEqual([]);
  });
});

describe("monitoringReader", () => {
  it("asks for one-day alignment, groups, and returns values oldest first", async () => {
    const get = vi.fn(async (_url: string) => ({
      timeSeries: [
        {
          resource: { labels: { namespace_name: "shop" } },
          points: [
            { interval: { endTime: "2026-10-15T00:00:00Z" }, value: { doubleValue: 2 } },
            { interval: { endTime: "2026-10-14T00:00:00Z" }, value: { int64Value: "1" } },
          ],
        },
      ],
    }));
    const read = monitoringReader("proj-1", get as never);
    const out = await read(
      {
        metricType: "kubernetes.io/container/cpu/core_usage_time",
        filters: ['resource.type="k8s_container"'],
        aligner: "ALIGN_RATE",
        reducer: "REDUCE_SUM",
        groupBy: ["resource.labels.namespace_name"],
      },
      { start: new Date("2026-10-02T00:00:00Z"), end: new Date("2026-10-16T00:00:00Z") },
    );
    expect(out).toEqual([{ labels: { namespace_name: "shop" }, values: [1, 2] }]);
    const url = new URL(get.mock.calls[0]![0]);
    expect(url.pathname).toBe("/v3/projects/proj-1/timeSeries");
    expect(url.searchParams.get("aggregation.alignmentPeriod")).toBe("86400s");
    expect(url.searchParams.getAll("aggregation.groupByFields")).toEqual([
      "resource.labels.namespace_name",
    ]);
    expect(url.searchParams.get("filter")).toBe(
      'metric.type="kubernetes.io/container/cpu/core_usage_time" AND resource.type="k8s_container"',
    );
  });

  it("turns a permission denial into an access error, but not a disabled API", async () => {
    const denied = monitoringReader("p", (async () => {
      throw new Error("GCP API error 403: PERMISSION_DENIED");
    }) as never);
    await expect(
      denied(
        { metricType: "x", filters: [], aligner: "ALIGN_MEAN", reducer: "REDUCE_MEAN" },
        { start: new Date(), end: new Date() },
      ),
    ).rejects.toMatchObject({ name: "IdleFindingAccessError" });
    const disabled = monitoringReader("p", (async () => {
      throw new Error("403: Cloud Monitoring API has not been used in project p");
    }) as never);
    await expect(
      disabled(
        { metricType: "x", filters: [], aligner: "ALIGN_MEAN", reducer: "REDUCE_MEAN" },
        { start: new Date(), end: new Date() },
      ),
    ).rejects.not.toMatchObject({ name: "IdleFindingAccessError" });
  });
});

describe("remediation", () => {
  it("deletes an idle cluster and an idle NAT config with the project placeholder", () => {
    const lines = (ruleId: string, resource: IdleScanResource) =>
      gcpRemediationCommands({
        kind: "orphan",
        reason: "idle",
        idleRuleId: ruleId,
        resource: {
          resourceTypeId: resource.resourceTypeId,
          displayName: resource.displayName,
          externalId: resource.externalId,
          fields: resource.fields,
        },
      }).map((c) => c.command);
    expect(lines("gke-cluster", cluster)).toEqual([
      'gcloud container clusters delete prod --location europe-west1 --project "$GCP_PROJECT"',
    ]);
    expect(lines("cloud-nat", nat())).toEqual([
      'gcloud compute routers nats delete nat-1 --router router-1 --region europe-west1 --project "$GCP_PROJECT"',
    ]);
  });
});

function nat(): IdleScanResource {
  return res("europe-west1/router-1/nat-1", "cloud-nat", {
    name: "nat-1",
    region: "europe-west1",
    router: "router-1",
  });
}
