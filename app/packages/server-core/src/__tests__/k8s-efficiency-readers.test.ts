import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();

vi.mock("../analytics/client", () => ({ getAnalyticsDb: () => pg.db }));

const { scanKubernetesEfficiency, getKubernetesDimensionValues, getKubernetesTagKeys } =
  await import("../analytics/k8s-efficiency-readers");

const BASE = {
  from: "2026-09-01",
  to: "2026-09-30",
  granularity: "week" as const,
  filters: [],
};

beforeEach(() => {
  pg.reset();
});

describe("scanKubernetesEfficiency", () => {
  it("reads only Kubernetes rows, with the resource and usage tags, in Monday weeks", async () => {
    await scanKubernetesEfficiency("org-1", { ...BASE, groupBy: "namespace" });
    const q = pg.queries[0]!;
    expect(q.params).toContain("kubernetes");
    expect(q.params).toContain("k8s_resource");
    expect(q.params).toContain("k8s_usage");
    expect(q.params).toContain("namespace");
    // ISO weeks start on Monday, which is what the client-core bucketing expects.
    expect(q.sql).toContain("date_trunc('week'");
    // A missing tag must read as '' so it groups with "no value", not as NULL.
    expect(q.sql).toMatch(/coalesce\(("cost_daily"\.)?"tags" ->> \$\d+::text, ''\)/);
  });

  it("namespace-qualifies workloads and groups labels by their tag key", async () => {
    await scanKubernetesEfficiency("org-1", { ...BASE, groupBy: "workload" });
    expect(pg.queries[0]!.sql).toContain("concat(");
    await scanKubernetesEfficiency("org-1", {
      ...BASE,
      groupBy: "label",
      groupByLabelKey: "k8s_pod_label:team",
    });
    expect(pg.queries[1]!.params).toContain("k8s_pod_label:team");
  });

  it("buckets by month and by day as YYYY-MM-DD text", async () => {
    await scanKubernetesEfficiency("org-1", {
      ...BASE,
      granularity: "month",
      groupBy: "cluster",
    });
    expect(pg.queries[0]!.sql).toContain("to_char(date_trunc('month'");
    await scanKubernetesEfficiency("org-1", { ...BASE, granularity: "day", groupBy: "cluster" });
    expect(pg.queries[1]!.sql).toMatch(/to_char\(("cost_daily"\.)?"day", 'YYYY-MM-DD'\)/);
  });

  it("applies filters through the shared membership vocabulary, as bound values", async () => {
    await scanKubernetesEfficiency("org-1", {
      ...BASE,
      groupBy: "cluster",
      filters: [
        { dimension: "tag", tagKey: "namespace", op: "in", values: ["pay'ments"] },
        { dimension: "region", op: "not_in", values: ["eu-west-1"] },
      ],
    });
    const q = pg.queries[0]!;
    expect(q.sql).not.toContain("pay'ments");
    expect(q.params).toContain("pay'ments");
    expect(q.sql).toContain("not in");
  });

  it("maps the scan's rows", async () => {
    pg.setRows([
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
    expect(pg.queries[0]!.params).toContain("kubernetes");
    expect(pg.queries[0]!.params).toContain("node_pool");
  });
});

describe("getKubernetesTagKeys", () => {
  it("lists the distinct keys of the Kubernetes rows' tags", async () => {
    pg.setRows([{ key: "namespace" }, { key: "node_pool" }]);
    expect(await getKubernetesTagKeys("org-1")).toEqual(["namespace", "node_pool"]);
    const q = pg.queries[0]!;
    expect(q.sql).toMatch(/select distinct jsonb_object_keys\(("cost_daily"\.)?"tags"\)/);
    expect(q.params).toContain("kubernetes");
  });
});
