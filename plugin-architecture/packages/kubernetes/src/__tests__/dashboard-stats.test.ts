import { describe, expect, it, vi } from "vitest";
import { fetchDashboardStats } from "../dashboard-stats.js";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { K8sFetch } from "../shared.js";

function res(resourceTypeId: string, fields: Record<string, unknown>): ResourceInstance {
  return {
    id: `a:${resourceTypeId}:ns:x`,
    pluginId: "kubernetes",
    resourceTypeId,
    accountId: "a",
    displayName: "x",
    fields: fields as ResourceInstance["fields"],
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

const noFetch = vi.fn();

describe("fetchDashboardStats", () => {
  it("cluster: returns version on success", async () => {
    const stats = await fetchDashboardStats(
      res("k8s-cluster", {}),
      vi.fn(async () => ({ gitVersion: "v1.30" })) as unknown as K8sFetch,
    );
    expect(stats).toEqual([{ label: "Version", value: "v1.30" }]);
  });

  it("cluster: returns empty when /version throws", async () => {
    const stats = await fetchDashboardStats(
      res("k8s-cluster", {}),
      vi.fn(async () => {
        throw new Error("x");
      }) as unknown as K8sFetch,
    );
    expect(stats).toEqual([]);
  });

  it("deployment: healthy when ready equals desired, degraded otherwise", async () => {
    const healthy = await fetchDashboardStats(
      res("k8s-deployment", { readyReplicas: 3, replicas: 3, namespace: "prod" }),
      noFetch,
    );
    expect(healthy[0]).toEqual({ label: "Replicas", value: "3/3", variant: "status-healthy" });
    const degraded = await fetchDashboardStats(
      res("k8s-statefulset", { readyReplicas: 1, replicas: 3, namespace: "prod" }),
      noFetch,
    );
    expect(degraded[0]).toMatchObject({ value: "1/3", variant: "status-degraded" });
  });

  it("daemonset: ready/desired ratio", async () => {
    const stats = await fetchDashboardStats(
      res("k8s-daemonset", { numberReady: 5, desiredNumberScheduled: 5, namespace: "kube" }),
      noFetch,
    );
    expect(stats[0]).toEqual({ label: "Ready", value: "5/5", variant: "status-healthy" });
  });

  it("pod: phase variants and optional restartCount", async () => {
    expect(
      (await fetchDashboardStats(res("k8s-pod", { phase: "Running", namespace: "p" }), noFetch))[0],
    ).toMatchObject({ variant: "status-healthy" });
    expect(
      (await fetchDashboardStats(res("k8s-pod", { phase: "Succeeded" }), noFetch))[0],
    ).toMatchObject({ variant: "status-healthy" });
    expect(
      (await fetchDashboardStats(res("k8s-pod", { phase: "Failed" }), noFetch))[0],
    ).toMatchObject({ variant: "status-error" });
    expect(
      (await fetchDashboardStats(res("k8s-pod", { phase: "Pending" }), noFetch))[0],
    ).toMatchObject({ variant: "status-degraded" });
    const withRestarts = await fetchDashboardStats(
      res("k8s-pod", { phase: "Running", restartCount: 4, namespace: "p" }),
      noFetch,
    );
    expect(withRestarts).toContainEqual({ label: "Restarts", value: "4" });
    const noPhase = await fetchDashboardStats(res("k8s-pod", {}), noFetch);
    expect(noPhase[0]).toMatchObject({ value: "Unknown" });
  });

  it("service: type/clusterIP/namespace", async () => {
    const stats = await fetchDashboardStats(
      res("k8s-service", { type: "NodePort", clusterIP: "10.1", namespace: "p" }),
      noFetch,
    );
    expect(stats).toEqual([
      { label: "Type", value: "NodePort" },
      { label: "Cluster IP", value: "10.1" },
      { label: "Namespace", value: "p" },
    ]);
  });

  it("job: succeeded/active/namespace", async () => {
    const stats = await fetchDashboardStats(
      res("k8s-job", { succeeded: 1, active: 0, namespace: "p" }),
      noFetch,
    );
    expect(stats).toEqual([
      { label: "Succeeded", value: "1" },
      { label: "Active", value: "0" },
      { label: "Namespace", value: "p" },
    ]);
  });

  it("ingress and namespace are minimal", async () => {
    expect(await fetchDashboardStats(res("k8s-ingress", { namespace: "p" }), noFetch)).toEqual([
      { label: "Namespace", value: "p" },
    ]);
    expect(await fetchDashboardStats(res("k8s-namespace", { name: "prod" }), noFetch)).toEqual([
      { label: "Name", value: "prod" },
    ]);
  });

  it("cronjob: includes suspended badge only when suspended", async () => {
    const suspended = await fetchDashboardStats(
      res("k8s-cronjob", { schedule: "* * * * *", suspended: "true", namespace: "p" }),
      noFetch,
    );
    expect(suspended).toContainEqual({
      label: "Suspended",
      value: "Yes",
      variant: "status-degraded",
    });
    const active = await fetchDashboardStats(
      res("k8s-cronjob", { schedule: "* * * * *", suspended: "false", namespace: "p" }),
      noFetch,
    );
    expect(active.find((s) => s.label === "Suspended")).toBeUndefined();
  });

  it("secret and configmap stats", async () => {
    expect(
      await fetchDashboardStats(
        res("k8s-secret", { type: "Opaque", dataCount: 2, namespace: "p" }),
        noFetch,
      ),
    ).toEqual([
      { label: "Type", value: "Opaque" },
      { label: "Entries", value: "2" },
      { label: "Namespace", value: "p" },
    ]);
    expect(
      await fetchDashboardStats(res("k8s-configmap", { dataCount: 3, namespace: "p" }), noFetch),
    ).toEqual([
      { label: "Entries", value: "3" },
      { label: "Namespace", value: "p" },
    ]);
  });

  it("unknown type returns empty", async () => {
    expect(await fetchDashboardStats(res("k8s-other", {}), noFetch)).toEqual([]);
  });
});
