import { describe, it, expect } from "vitest";

import {
  allocateClusterCost,
  type CostModelNode,
  type CostModelPod,
  type CostModelVolume,
} from "../cost-model.js";
import {
  buildEfficiencyReport,
  formatEfficiencyCell,
  formatEfficiencyReportText,
  formatPair,
  RIGHTSIZING_NOTE,
} from "../efficiency-report.js";

const GIB = 1024 ** 3;
const AT = "2026-08-11T09:00:00.000Z";

function node(over: Partial<CostModelNode> = {}): CostModelNode {
  return {
    name: "node-1",
    capacity: { cpuCores: 8, memoryBytes: 32 * GIB },
    allocatable: { cpuCores: 8, memoryBytes: 32 * GIB },
    instanceType: "m5.2xlarge",
    hourlyRate: 1,
    ...over,
  };
}

function pod(over: Partial<CostModelPod> = {}): CostModelPod {
  return {
    name: "p",
    namespace: "app",
    nodeName: "node-1",
    workload: "web",
    workloadKind: "Deployment",
    requests: { cpuCores: 1, memoryBytes: 4 * GIB },
    limits: { cpuCores: 1, memoryBytes: 4 * GIB },
    ...over,
  };
}

/** A cluster with one badly over-requested workload and one well-sized one. */
function mixedCluster() {
  return allocateClusterCost({
    nodes: [node()],
    pods: [
      // Wastes almost everything it asked for.
      pod({
        name: "hog-1",
        workload: "hog",
        requests: { cpuCores: 4, memoryBytes: 8 * GIB },
        usage: { cpuCores: 0.1, memoryBytes: GIB },
      }),
      // Uses what it asked for.
      pod({
        name: "tight-1",
        workload: "tight",
        requests: { cpuCores: 1, memoryBytes: 4 * GIB },
        usage: { cpuCores: 0.95, memoryBytes: 3.8 * GIB },
      }),
    ],
  });
}

describe("buildEfficiencyReport", () => {
  it("orders workloads by the money the waste costs, worst first", () => {
    const report = buildEfficiencyReport(mixedCluster(), AT);
    expect(report.workloads.map((w) => w.label)).toEqual(["hog", "tight"]);
    expect(report.workloads[0]!.wastedDailyCost!).toBeGreaterThan(
      report.workloads[1]!.wastedDailyCost!,
    );
  });

  it("reports a workload with no usage data as unknown, never as 0% efficient", () => {
    const cluster = allocateClusterCost({
      nodes: [node()],
      // No `usage` anywhere: metrics-server is absent.
      pods: [pod({ name: "web-1" })],
    });
    const report = buildEfficiencyReport(cluster, AT);
    const row = report.workloads[0]!;

    expect(row.unknown).toBe(true);
    expect(row.usage).toBeNull();
    expect(row.wasted).toBeNull();
    expect(row.wastedDailyCost).toBeNull();
    expect(formatEfficiencyCell(row, "cpu")).toBe("unknown");
    expect(formatEfficiencyCell(row, "memory")).toBe("unknown");
    expect(formatPair(row.usage, row.unknown)).toBe("unknown");
    expect(report.measured).toBe(false);
    expect(report.unknownWorkloads).toBe(1);
  });

  it("sorts unmeasured workloads last, below every measured one", () => {
    const cluster = allocateClusterCost({
      nodes: [node()],
      pods: [
        pod({ name: "blind-1", workload: "blind" }),
        // Perfectly efficient, but measured — it still outranks the unknown.
        pod({
          name: "tight-1",
          workload: "tight",
          usage: { cpuCores: 1, memoryBytes: 4 * GIB },
        }),
      ],
    });
    const report = buildEfficiencyReport(cluster, AT);
    expect(report.workloads.map((w) => w.label)).toEqual(["tight", "blind"]);
    expect(report.workloads.at(-1)!.unknown).toBe(true);
  });

  it("ranks measured-but-unpriced rows by wasted CPU, below the priced ones", () => {
    const cluster = allocateClusterCost({
      nodes: [node({ name: "priced" }), node({ name: "free", hourlyRate: undefined })],
      pods: [
        // Huge waste, no node rate — cannot be ranked by money.
        pod({
          name: "unpriced-1",
          workload: "unpriced",
          nodeName: "free",
          requests: { cpuCores: 6, memoryBytes: 8 * GIB },
          usage: { cpuCores: 0.1, memoryBytes: GIB },
        }),
        // Tiny waste, but priced.
        pod({
          name: "priced-1",
          workload: "priced",
          nodeName: "priced",
          requests: { cpuCores: 1, memoryBytes: 4 * GIB },
          usage: { cpuCores: 0.9, memoryBytes: 3.5 * GIB },
        }),
      ],
    });
    const report = buildEfficiencyReport(cluster, AT);

    expect(report.workloads[0]!.label).toBe("priced");
    expect(report.workloads[1]!.label).toBe("unpriced");
    expect(report.workloads[1]!.wastedDailyCost).toBeNull();
    // Still reported in capacity terms rather than dropped.
    expect(report.workloads[1]!.wasted!.cpuCores).toBeCloseTo(5.9, 10);
    expect(report.partiallyPriced).toBe(true);
  });

  it("scopes to one namespace, totalling that namespace rather than the cluster", () => {
    const cluster = allocateClusterCost({
      nodes: [node()],
      pods: [
        pod({
          name: "a",
          namespace: "app",
          workload: "web",
          usage: { cpuCores: 0.5, memoryBytes: GIB },
        }),
        pod({
          name: "b",
          namespace: "ops",
          workload: "agent",
          usage: { cpuCores: 0.5, memoryBytes: GIB },
        }),
      ],
    });

    const scoped = buildEfficiencyReport(cluster, AT, "ops");
    expect(scoped.namespaces.map((n) => n.label)).toEqual(["ops"]);
    expect(scoped.workloads.map((w) => w.label)).toEqual(["agent"]);
    // Cluster-wide buckets are omitted rather than repeated under a namespace.
    expect(scoped.totals.dailyIdleCost).toBeNull();
    expect(scoped.totals.dailyUnattachedStorageCost).toBeNull();

    const whole = buildEfficiencyReport(cluster, AT);
    expect(whole.totals.dailyIdleCost).not.toBeNull();
    expect(whole.totals.requests.cpuCores).toBeGreaterThan(scoped.totals.requests.cpuCores);
  });

  it("surfaces the idle and unattached-storage buckets separately from waste", () => {
    const volume: CostModelVolume = {
      name: "orphan",
      namespace: "app",
      phase: "Bound",
      storageClass: "gp3",
      gib: 100,
      capacityBasis: "provisioned",
      mountedBy: [],
      gibMonthRate: 0.08,
    };
    const cluster = allocateClusterCost({
      nodes: [node()],
      pods: [pod({ usage: { cpuCores: 0.1, memoryBytes: GIB } })],
      volumes: [volume],
    });
    const report = buildEfficiencyReport(cluster, AT);

    // Three distinct kinds of waste, none folded into another.
    expect(report.totals.wastedDailyCost).toBeGreaterThan(0);
    expect(report.totals.dailyIdleCost).toBeGreaterThan(0);
    expect(report.totals.dailyUnattachedStorageCost).toBeGreaterThan(0);
  });

  it("takes its timestamp from the caller, so the same snapshot renders identically", () => {
    const cluster = mixedCluster();
    expect(formatEfficiencyReportText(buildEfficiencyReport(cluster, AT), "t")).toBe(
      formatEfficiencyReportText(buildEfficiencyReport(cluster, AT), "t"),
    );
  });
});

describe("formatEfficiencyReportText", () => {
  it("carries the figures, the timestamp and the caveats in one pasteable block", () => {
    const text = formatEfficiencyReportText(buildEfficiencyReport(mixedCluster(), AT), "Report");

    expect(text).toContain("Report");
    expect(text).toContain(AT);
    expect(text).toContain("BY NAMESPACE (worst first)");
    expect(text).toContain("BY WORKLOAD (worst first)");
    expect(text).toContain("Derived allocation, not a billed amount");
    expect(text).toContain(RIGHTSIZING_NOTE);
    // The worst offender is above the well-sized one in the rendered text too.
    expect(text.indexOf("app/hog")).toBeLessThan(text.indexOf("app/tight"));
  });

  it("says so out loud when nothing was measured", () => {
    const cluster = allocateClusterCost({ nodes: [node()], pods: [pod()] });
    const text = formatEfficiencyReportText(buildEfficiencyReport(cluster, AT), "Report");

    expect(text).toContain("metrics-server is not reporting");
    expect(text).toContain("unknown");
    // And never claims a zero it does not know.
    expect(text).not.toContain("0%");
  });

  it("counts the unmeasured workloads when only some are missing", () => {
    const cluster = allocateClusterCost({
      nodes: [node()],
      pods: [
        pod({ name: "seen-1", workload: "seen", usage: { cpuCores: 0.5, memoryBytes: GIB } }),
        pod({ name: "blind-1", workload: "blind" }),
      ],
    });
    const text = formatEfficiencyReportText(buildEfficiencyReport(cluster, AT), "Report");
    expect(text).toContain("1 of 2 workloads have no usage data");
  });
});
