import { describe, expect, it } from "vitest";
import {
  namespacePeerGroup,
  podPeerGroup,
  deploymentPeerGroup,
  statefulSetPeerGroup,
  daemonSetPeerGroup,
  servicePeerGroup,
  ingressPeerGroup,
  jobPeerGroup,
  cronJobPeerGroup,
} from "../peer-groups.js";
import type { ResourceInstance } from "@infrawrench/plugin-base";

function ri(
  resourceTypeId: string,
  fields: Record<string, unknown>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  return {
    id: `a:${resourceTypeId}:ns:n`,
    pluginId: "kubernetes",
    resourceTypeId,
    accountId: "a",
    displayName: "n",
    fields: fields as ResourceInstance["fields"],
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...extra,
  };
}

describe("namespacePeerGroup", () => {
  it("maps phase to status and carries externalId", () => {
    const g = namespacePeerGroup([
      ri("k8s-namespace", { name: "prod", phase: "Active" }, { externalId: "uid1" }),
      ri("k8s-namespace", { name: "old", phase: "Terminating" }),
    ]);
    expect(g.title).toBe("Namespaces (2)");
    expect(g.items[0]!.status).toBe("healthy");
    expect(g.items[0]!.externalId).toBe("uid1");
    expect(g.items[1]!.status).toBe("degraded");
  });
});

describe("podPeerGroup", () => {
  it("supports exec and propagates containerName", () => {
    const g = podPeerGroup([
      ri("k8s-pod", { namespace: "prod", image: "nginx", status: "Running", containerName: "c1" }),
    ]);
    expect(g.supportsCreate).toBe(true);
    expect(g.items[0]!.supportsExec).toBe(true);
    expect(g.items[0]!.containerName).toBe("c1");
    expect(g.items[0]!.subtitle).toBe("prod · nginx");
    expect(g.items[0]!.status).toBe("healthy");
  });
});

describe("deploymentPeerGroup / statefulSetPeerGroup", () => {
  it("computes healthy/degraded/error/unknown statuses", () => {
    const g = deploymentPeerGroup([
      ri("k8s-deployment", { namespace: "p", replicas: 3, readyReplicas: 3 }),
      ri("k8s-deployment", { namespace: "p", replicas: 3, readyReplicas: 1 }),
      ri("k8s-deployment", { namespace: "p", replicas: 3, readyReplicas: 0 }),
      ri("k8s-deployment", { namespace: "p", replicas: 0, readyReplicas: 0 }),
    ]);
    expect(g.items.map((i) => i.status)).toEqual(["healthy", "degraded", "error", "unknown"]);
  });

  it("statefulset error when zero ready and zero desired", () => {
    const g = statefulSetPeerGroup([
      ri("k8s-statefulset", { namespace: "p", replicas: 0, readyReplicas: 0 }),
      ri("k8s-statefulset", { namespace: "p", replicas: 2, readyReplicas: 2 }),
    ]);
    expect(g.items[0]!.status).toBe("error");
    expect(g.items[1]!.status).toBe("healthy");
  });
});

describe("daemonSetPeerGroup", () => {
  it("computes scheduled status ratios", () => {
    const g = daemonSetPeerGroup([
      ri("k8s-daemonset", { namespace: "p", desiredNumberScheduled: 3, numberReady: 3 }),
      ri("k8s-daemonset", { namespace: "p", desiredNumberScheduled: 3, numberReady: 1 }),
      ri("k8s-daemonset", { namespace: "p", desiredNumberScheduled: 3, numberReady: 0 }),
    ]);
    expect(g.items.map((i) => i.status)).toEqual(["healthy", "degraded", "error"]);
    expect(g.items[0]!.subtitle).toBe("p · 3/3 scheduled");
  });
});

describe("service / ingress / job / cronjob peer groups", () => {
  it("service group is always healthy with composed subtitle", () => {
    const g = servicePeerGroup([
      ri("k8s-service", { namespace: "p", type: "ClusterIP", ports: "80/TCP" }),
    ]);
    expect(g.items[0]!.status).toBe("healthy");
    expect(g.items[0]!.subtitle).toBe("p · ClusterIP · 80/TCP");
  });

  it("ingress subtitle joins namespace and hosts", () => {
    const g = ingressPeerGroup([ri("k8s-ingress", { namespace: "p", hosts: "a.com" })]);
    expect(g.items[0]!.subtitle).toBe("p · a.com");
  });

  it("job group maps status via mapJobStatus", () => {
    const g = jobPeerGroup([
      ri("k8s-job", { namespace: "p", completions: "1/1", status: "Complete" }),
    ]);
    expect(g.items[0]!.status).toBe("healthy");
  });

  it("cronjob group degrades when suspended", () => {
    const g = cronJobPeerGroup([
      ri("k8s-cronjob", { namespace: "p", schedule: "* * * * *", suspended: "true" }),
      ri("k8s-cronjob", { namespace: "p", schedule: "* * * * *", suspended: "false" }),
    ]);
    expect(g.items[0]!.status).toBe("degraded");
    expect(g.items[1]!.status).toBe("healthy");
  });
});
