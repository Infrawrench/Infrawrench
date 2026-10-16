import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClickHouse } from "./helpers/fake-clickhouse";

const ch = fakeClickHouse();

vi.mock("../clickhouse/client", () => ({
  isClickHouseConfigured: () => true,
  getClickHouseDb: () => ch.db,
  getClickHouseClient: () => ch.client,
}));

const { scanKubernetesEfficiency, getKubernetesDimensionValues } =
  await import("../clickhouse/k8s-efficiency-readers");

const BASE = {
  from: "2026-09-01",
  to: "2026-09-30",
  granularity: "week" as const,
  filters: [],
};

beforeEach(() => {
  ch.queries.length = 0;
  ch.setRows?.([]);
});

describe("scanKubernetesEfficiency", () => {
  it("reads only Kubernetes rows, FINAL, with the resource and usage tags", async () => {
    await scanKubernetesEfficiency("org-1", { ...BASE, groupBy: "namespace" });
    const q = ch.queries[0]!;
    expect(q.toLowerCase()).toContain(" final");
    expect(q).toContain("'kubernetes'");
    expect(q).toContain("'k8s_resource'");
    expect(q).toContain("'k8s_usage'");
    expect(q).toContain("toStartOfWeek");
    expect(q).toContain("'namespace'");
  });

  it("namespace-qualifies workloads and groups labels by their tag key", async () => {
    await scanKubernetesEfficiency("org-1", { ...BASE, groupBy: "workload" });
    expect(ch.queries[0]).toContain("concat(");
    await scanKubernetesEfficiency("org-1", {
      ...BASE,
      groupBy: "label",
      groupByLabelKey: "k8s_pod_label:team",
    });
    expect(ch.queries[1]).toContain("'k8s_pod_label:team'");
  });

  it("applies filters through the shared membership vocabulary, escaped", async () => {
    await scanKubernetesEfficiency("org-1", {
      ...BASE,
      groupBy: "cluster",
      filters: [
        { dimension: "tag", tagKey: "namespace", op: "in", values: ["pay'ments"] },
        { dimension: "region", op: "not_in", values: ["eu-west-1"] },
      ],
    });
    const q = ch.queries[0]!;
    expect(q).toContain("pay\\'ments");
    expect(q).toContain("not in");
  });

  it("maps the scan's rows", async () => {
    ch.setRows?.([
      {
        bucket: "2026-09-01",
        grp: "payments",
        account_id: "c1",
        service: "kubernetes-workload",
        resource: "cpu",
        usage: "used",
        currency: "USD",
        amount: 12.5,
      },
    ]);
    const rows = await scanKubernetesEfficiency("org-1", { ...BASE, groupBy: "namespace" });
    expect(rows).toEqual([
      {
        bucket: "2026-09-01",
        group: "payments",
        accountId: "c1",
        service: "kubernetes-workload",
        resource: "cpu",
        usage: "used",
        currency: "USD",
        amount: 12.5,
      },
    ]);
  });
});

describe("getKubernetesDimensionValues", () => {
  it("narrows picker values to Kubernetes rows", async () => {
    await getKubernetesDimensionValues("org-1", { dimension: "tag", tagKey: "node_pool" });
    expect(ch.queries[0]).toContain("'kubernetes'");
    expect(ch.queries[0]).toContain("'node_pool'");
  });
});
