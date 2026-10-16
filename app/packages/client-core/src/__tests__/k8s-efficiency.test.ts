import { describe, expect, it } from "vitest";

import {
  buildKubernetesEfficiencyResult,
  classifyKubernetesCostRow,
  DEFAULT_K8S_EFFICIENCY_CONFIG,
  formatKubernetesEfficiency,
  kubernetesEfficiency,
  kubernetesEfficiencyBuckets,
  kubernetesEfficiencyBucketStart,
  kubernetesEfficiencyConfigProblem,
  kubernetesEfficiencyCsv,
  type KubernetesEfficiencyConfig,
  type KubernetesEfficiencyScanRow,
} from "../k8s-efficiency";

const config = (over: Partial<KubernetesEfficiencyConfig> = {}): KubernetesEfficiencyConfig => ({
  ...DEFAULT_K8S_EFFICIENCY_CONFIG,
  dateRange: { kind: "absolute", from: "2026-10-01", to: "2026-10-02" },
  ...over,
});

function row(over: Partial<KubernetesEfficiencyScanRow>): KubernetesEfficiencyScanRow {
  return {
    bucket: "2026-10-01",
    group: "",
    accountId: "c1",
    service: "kubernetes-workload",
    resource: "cpu",
    usage: "used",
    currency: "USD",
    amount: 0,
    ...over,
  };
}

/** One cluster, one day: two namespaces, idle and overhead. */
const SCAN: KubernetesEfficiencyScanRow[] = [
  row({ group: "payments", resource: "cpu", usage: "used", amount: 30 }),
  row({ group: "payments", resource: "cpu", usage: "unused", amount: 10 }),
  row({ group: "payments", resource: "memory", usage: "used", amount: 10 }),
  row({ group: "search", resource: "memory", usage: "unmeasured", amount: 20 }),
  row({ group: "search", service: "kubernetes-storage", resource: "storage", amount: 5 }),
  row({ service: "kubernetes-idle", resource: "cpu", usage: "idle", amount: 15 }),
  row({
    service: "kubernetes-control-plane",
    resource: "control_plane",
    usage: "overhead",
    amount: 10,
  }),
];

const TOTAL = 100;

describe("classifyKubernetesCostRow", () => {
  it("reads the tags when the row carries them", () => {
    expect(classifyKubernetesCostRow("kubernetes-workload", "memory", "unused")).toEqual({
      category: "memory",
      state: "unused",
      legacy: false,
    });
  });

  it("derives rows written before the tags from their service", () => {
    expect(classifyKubernetesCostRow("kubernetes-workload", "", "")).toMatchObject({
      category: "compute",
      state: "unmeasured",
      legacy: true,
    });
    expect(classifyKubernetesCostRow("kubernetes-idle", "", "")).toMatchObject({
      category: "compute",
      state: "idle",
    });
    expect(classifyKubernetesCostRow("kubernetes-gpu-idle", "", "")).toMatchObject({
      category: "gpu",
      state: "idle",
    });
    expect(classifyKubernetesCostRow("kubernetes-control-plane", "", "")).toMatchObject({
      category: "control_plane",
      state: "overhead",
    });
    expect(classifyKubernetesCostRow("kubernetes-storage", "", "")).toMatchObject({
      category: "storage",
      state: "used",
    });
    expect(classifyKubernetesCostRow("kubernetes-load-balancer", "", "")).toMatchObject({
      category: "network",
      state: "used",
    });
  });
});

describe("kubernetesEfficiency", () => {
  const amounts = { total: 100, used: 40, unused: 20, unmeasured: 20, idle: 15, overhead: 5 };

  it("divides used by the measured total on the total basis", () => {
    expect(kubernetesEfficiency(amounts, "total")).toBeCloseTo(40 / 80, 12);
  });

  it("divides used by what was reserved on the allocated basis", () => {
    expect(kubernetesEfficiency(amounts, "allocated")).toBeCloseTo(40 / 60, 12);
  });

  it("is null, never zero, when nothing was measured", () => {
    const blind = { total: 10, used: 0, unused: 0, unmeasured: 10, idle: 0, overhead: 0 };
    expect(kubernetesEfficiency(blind, "total")).toBeNull();
    expect(kubernetesEfficiency(blind, "allocated")).toBeNull();
    expect(formatKubernetesEfficiency(null)).toBe("n/a");
    expect(formatKubernetesEfficiency(0.625)).toBe("63%");
  });
});

describe("buildKubernetesEfficiencyResult", () => {
  const range = { from: "2026-10-01", to: "2026-10-02" };

  it("keeps idle and overhead as their own rows when separate", () => {
    const result = buildKubernetesEfficiencyResult(SCAN, { config: config(), ...range });
    const block = result.currencies[0]!;
    expect(block.totals.total).toBeCloseTo(TOTAL, 9);
    expect(block.rows.map((r) => r.key)).toEqual([
      "payments",
      "search",
      "__idle__",
      "__overhead__",
    ]);
    const payments = block.rows[0]!;
    expect(payments.figures.efficiency).toBeCloseTo(40 / 50, 12);
    // Storage counts as used; the unmeasured memory stays out of the ratio.
    const search = block.rows[1]!;
    expect(search.figures.efficiency).toBe(1);
    expect(search.figures.measuredShare).toBeCloseTo(5 / 25, 12);
    const idle = block.rows[2]!;
    expect(idle.kind).toBe("idle");
    expect(idle.figures.efficiency).toBe(0);
    expect(block.totals.efficiency).toBeCloseTo(45 / 80, 12);
  });

  it("shares idle and overhead out by allocation when spread, without changing the total", () => {
    const result = buildKubernetesEfficiencyResult(SCAN, {
      config: config({ idle: "spread" }),
      ...range,
    });
    const block = result.currencies[0]!;
    expect(block.rows.map((r) => r.key)).toEqual(["payments", "search"]);
    expect(block.totals.total).toBeCloseTo(TOTAL, 9);
    // payments held 50 of the 75 allocated, so it takes two thirds of 25.
    const payments = block.rows[0]!;
    expect(payments.figures.idle + payments.figures.overhead).toBeCloseTo((25 * 50) / 75, 9);
    expect(payments.figures.total).toBeCloseTo(50 + (25 * 50) / 75, 9);
    expect(payments.figures.efficiency).toBeCloseTo(40 / payments.figures.total, 9);
  });

  it("never spreads one cluster's idle capacity over another cluster", () => {
    const scan = [
      ...SCAN,
      row({
        accountId: "c2",
        service: "kubernetes-idle",
        resource: "cpu",
        usage: "idle",
        amount: 7,
      }),
    ];
    const block = buildKubernetesEfficiencyResult(scan, {
      config: config({ idle: "spread" }),
      ...range,
    }).currencies[0]!;
    const idle = block.rows.find((r) => r.kind === "idle")!;
    expect(idle.figures.total).toBeCloseTo(7, 9);
    expect(block.totals.total).toBeCloseTo(TOTAL + 7, 9);
  });

  it("keeps idle in its own group when the grouping gives it a value", () => {
    const scan = SCAN.map((r) => ({ ...r, group: "c1" }));
    const block = buildKubernetesEfficiencyResult(scan, {
      config: config({ groupBy: "cluster" }),
      ...range,
      labels: { c1: "prod-eks" },
    }).currencies[0]!;
    expect(block.rows).toHaveLength(1);
    expect(block.rows[0]!.label).toBe("prod-eks");
    expect(block.rows[0]!.figures.idle).toBeCloseTo(15, 9);
  });

  it("groups by cost category and filters categories", () => {
    const byCategory = buildKubernetesEfficiencyResult(SCAN, {
      config: config({ groupBy: "category" }),
      ...range,
    }).currencies[0]!;
    expect(byCategory.rows.map((r) => r.key).sort()).toEqual([
      "control_plane",
      "cpu",
      "memory",
      "storage",
    ]);
    const cpuOnly = buildKubernetesEfficiencyResult(SCAN, {
      config: config({ categories: ["cpu"] }),
      ...range,
    }).currencies[0]!;
    expect(cpuOnly.totals.total).toBeCloseTo(55, 9);
    expect(cpuOnly.categories.map((c) => c.category)).toEqual(["cpu"]);
  });

  it("puts allocated money the grouping cannot name on its own row", () => {
    const scan = [
      row({ group: "", resource: "storage", service: "kubernetes-storage", amount: 3 }),
    ];
    const block = buildKubernetesEfficiencyResult(scan, {
      config: config({ groupBy: "workload", idle: "spread" }),
      ...range,
    }).currencies[0]!;
    expect(block.rows.map((r) => r.kind)).toEqual(["unattributed"]);
  });

  it("keeps currencies apart and flags rows that predate the tags", () => {
    const result = buildKubernetesEfficiencyResult(
      [
        row({ group: "a", amount: 1 }),
        row({ group: "a", currency: "EUR", resource: "", usage: "", amount: 2 }),
      ],
      { config: config(), ...range },
    );
    expect(result.currencies.map((c) => c.currency)).toEqual(["EUR", "USD"]);
    expect(result.includesLegacyRows).toBe(true);
    expect(result.currencies[0]!.categories[0]!.category).toBe("compute");
  });

  it("lists every bucket in the window", () => {
    const result = buildKubernetesEfficiencyResult(SCAN, { config: config(), ...range });
    expect(result.buckets).toEqual(["2026-10-01", "2026-10-02"]);
  });
});

describe("buckets", () => {
  it("starts weeks on Monday and months on the first", () => {
    expect(kubernetesEfficiencyBucketStart("2026-10-16", "week")).toBe("2026-10-12");
    expect(kubernetesEfficiencyBucketStart("2026-10-12", "week")).toBe("2026-10-12");
    expect(kubernetesEfficiencyBucketStart("2026-10-16", "month")).toBe("2026-10-01");
    expect(kubernetesEfficiencyBuckets("2026-09-28", "2026-10-16", "month")).toEqual([
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(kubernetesEfficiencyBuckets("2026-10-01", "2026-10-16", "week")).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
    ]);
  });
});

describe("kubernetesEfficiencyConfigProblem", () => {
  const today = new Date("2026-10-16T12:00:00Z");

  it("accepts the default", () => {
    expect(kubernetesEfficiencyConfigProblem(DEFAULT_K8S_EFFICIENCY_CONFIG, today)).toBeNull();
  });

  it("needs a label key exactly when grouping by label", () => {
    expect(kubernetesEfficiencyConfigProblem(config({ groupBy: "label" }), today)).toMatch(
      /label key/,
    );
    expect(
      kubernetesEfficiencyConfigProblem(
        config({ groupBy: "namespace", groupByLabelKey: "team" }),
        today,
      ),
    ).toMatch(/only used/);
    expect(
      kubernetesEfficiencyConfigProblem(
        config({ groupBy: "label", groupByLabelKey: "k8s_pod_label:team" }),
        today,
      ),
    ).toBeNull();
  });

  it("refuses dimensions outside cluster, region and label", () => {
    expect(
      kubernetesEfficiencyConfigProblem(
        config({ filters: [{ dimension: "service", op: "in", values: ["x"] }] }),
        today,
      ),
    ).toMatch(/not service/);
    expect(
      kubernetesEfficiencyConfigProblem(
        config({ filters: [{ dimension: "tag", op: "in", values: ["x"] }] }),
        today,
      ),
    ).toMatch(/label key/);
  });

  it("bounds the window", () => {
    expect(
      kubernetesEfficiencyConfigProblem(
        config({ dateRange: { kind: "absolute", from: "2026-10-02", to: "2026-10-01" } }),
        today,
      ),
    ).toMatch(/after/);
    expect(
      kubernetesEfficiencyConfigProblem(
        config({ dateRange: { kind: "absolute", from: "2024-01-01", to: "2026-01-01" } }),
        today,
      ),
    ).toMatch(/at most/);
  });
});

describe("kubernetesEfficiencyCsv", () => {
  it("writes a header, rows, categories and totals, and neutralises formulas", () => {
    const scan = [row({ group: "=HYPERLINK(1)", amount: 4 }), row({ group: "a,b", amount: 2 })];
    const csv = kubernetesEfficiencyCsv(
      buildKubernetesEfficiencyResult(scan, {
        config: config(),
        from: "2026-10-01",
        to: "2026-10-01",
      }),
      { perPeriod: true },
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "currency,period,group,group_kind,category,total,used,unused,unmeasured,idle,overhead,allocated,efficiency,measured_share",
    );
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain('"a,b"');
    expect(lines.some((l) => l.startsWith("USD,,Total,total,,6,"))).toBe(true);
    expect(lines.some((l) => l.startsWith("USD,2026-10-01,Total,total,"))).toBe(true);
  });
});
