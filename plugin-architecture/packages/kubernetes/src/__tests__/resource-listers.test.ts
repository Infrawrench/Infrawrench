import { describe, expect, it, vi } from "vitest";
import * as listers from "../resource-listers.js";
import type { ListerContext } from "../resource-listers.js";

function ctxFor(map: Record<string, unknown>, onDelete?: (path: string) => void): ListerContext {
  return {
    k8sFetch: vi.fn(async (path: string, options?: RequestInit) => {
      if (options?.method === "DELETE") {
        onDelete?.(path);
        return {};
      }
      if (path in map) return map[path];
      throw new Error(`unexpected path ${path}`);
    }) as unknown as ListerContext["k8sFetch"],
  };
}

const meta = (name: string, namespace?: string) => ({
  name,
  ...(namespace ? { namespace } : {}),
  uid: `uid-${name}`,
  creationTimestamp: "2024-01-01T00:00:00Z",
});

describe("listClusters", () => {
  it("includes the git version when /version succeeds", async () => {
    const [c] = await listers.listClusters(ctxFor({ "/version": { gitVersion: "v1.30.1" } }), "a");
    expect(c!.displayName).toBe("cluster (v1.30.1)");
    expect(c!.id).toBe("a:k8s-cluster:default");
    expect(c!.resourceTypeId).toBe("k8s-cluster");
  });
  it("falls back to a default name when /version throws", async () => {
    const ctx: ListerContext = {
      k8sFetch: vi.fn(async () => {
        throw new Error("nope");
      }),
    };
    const [c] = await listers.listClusters(ctx, "a");
    expect(c!.displayName).toBe("cluster");
  });
});

describe("listNamespaces", () => {
  it("maps namespaces and flags system ones", async () => {
    const ctx = ctxFor({
      "/api/v1/namespaces": {
        items: [
          { metadata: meta("prod"), status: { phase: "Active" } },
          { metadata: meta("kube-system"), status: { phase: "Active" } },
        ],
      },
    });
    const result = await listers.listNamespaces(ctx, "a");
    expect(result.map((r) => r.fields["system"])).toEqual(["false", "true"]);
    expect(result[0]!.parentResourceId).toBe("a:k8s-cluster:default");
    expect(result[0]!.fields["phase"]).toBe("Active");
  });
});

describe("listPods", () => {
  it("filters system namespaces and maps fields", async () => {
    const ctx = ctxFor({
      "/api/v1/pods": {
        items: [
          {
            metadata: meta("web", "prod"),
            spec: { containers: [{ name: "c1", image: "nginx" }] },
            status: { phase: "Running", containerStatuses: [{ restartCount: 2 }] },
          },
          {
            metadata: meta("sys", "kube-system"),
            spec: { containers: [{ name: "x", image: "y" }] },
            status: { phase: "Running" },
          },
        ],
      },
    });
    const pods = await listers.listPods(ctx, "a");
    expect(pods).toHaveLength(1);
    expect(pods[0]!.fields).toMatchObject({
      name: "web",
      namespace: "prod",
      image: "nginx",
      status: "Running",
      containerName: "c1",
      restarts: 2,
    });
  });

  it("includes ephemeral metadata and auto-deletes terminated ephemeral pods", async () => {
    const deletes: string[] = [];
    const ctx = ctxFor(
      {
        "/api/v1/pods": {
          items: [
            {
              metadata: {
                ...meta("scratch", "default"),
                labels: { "infrawrench.io/ephemeral": "true" },
                annotations: {
                  "infrawrench.io/expires-at": "2024-02-01T00:00:00Z",
                  "infrawrench.io/ttl-seconds": "3600",
                },
              },
              spec: { containers: [{ name: "scratch", image: "ubuntu" }] },
              status: { phase: "Running" },
            },
            {
              metadata: {
                ...meta("dead", "default"),
                labels: { "infrawrench.io/ephemeral": "true" },
              },
              spec: { containers: [{ name: "c", image: "u" }] },
              status: { phase: "Succeeded" },
            },
          ],
        },
      },
      (p) => deletes.push(p),
    );
    const pods = await listers.listPods(ctx, "a");
    // terminated ephemeral pod is excluded; running ephemeral is kept w/ metadata
    expect(pods).toHaveLength(1);
    expect(pods[0]!.fields).toMatchObject({
      ephemeral: "true",
      expiresAt: "2024-02-01T00:00:00Z",
      ttlSeconds: "3600",
    });
    expect(deletes).toEqual(["/api/v1/namespaces/default/pods/dead"]);
  });

  it("defaults containerName to pod name when no container", async () => {
    const ctx = ctxFor({
      "/api/v1/pods": {
        items: [
          {
            metadata: meta("nocon", "prod"),
            spec: { containers: [] },
            status: { phase: "Pending" },
          },
        ],
      },
    });
    const [p] = await listers.listPods(ctx, "a");
    expect(p!.fields["containerName"]).toBe("nocon");
    expect(p!.fields["restarts"]).toBe(0);
  });

  it("records the scheduled node and namespace-qualifies every configmap/secret reference", async () => {
    const ctx = ctxFor({
      "/api/v1/pods": {
        items: [
          {
            metadata: meta("web", "prod"),
            spec: {
              nodeName: "node-1",
              imagePullSecrets: [{ name: "regcred" }],
              volumes: [
                { configMap: { name: "app-config" } },
                { secret: { secretName: "tls" } },
                {
                  projected: {
                    sources: [{ configMap: { name: "ca-bundle" } }, { secret: { name: "token" } }],
                  },
                },
                { emptyDir: {} },
              ],
              initContainers: [
                { name: "init", image: "busybox", envFrom: [{ configMapRef: { name: "shared" } }] },
              ],
              containers: [
                {
                  name: "c1",
                  image: "nginx",
                  // duplicate of the volume mount above -> deduped
                  envFrom: [
                    { configMapRef: { name: "app-config" } },
                    { secretRef: { name: "db" } },
                  ],
                  env: [
                    { valueFrom: { configMapKeyRef: { name: "feature-flags" } } },
                    { valueFrom: { secretKeyRef: { name: "api-key" } } },
                    { value: "literal" },
                  ],
                },
              ],
            },
            status: { phase: "Running" },
          },
        ],
      },
    });
    const [p] = await listers.listPods(ctx, "a");
    expect(p!.fields["nodeName"]).toBe("node-1");
    expect(p!.fields["configMaps"]).toBe(
      "prod/app-config, prod/ca-bundle, prod/shared, prod/feature-flags",
    );
    expect(p!.fields["secrets"]).toBe("prod/tls, prod/token, prod/db, prod/api-key, prod/regcred");
  });

  it("leaves the new reference fields empty when the spec names nothing", async () => {
    const ctx = ctxFor({
      "/api/v1/pods": {
        items: [
          {
            metadata: meta("bare", "prod"),
            spec: { containers: [{ name: "c", image: "img" }] },
            status: { phase: "Pending" },
          },
        ],
      },
    });
    const [p] = await listers.listPods(ctx, "a");
    expect(p!.fields).toMatchObject({ nodeName: "", configMaps: "", secrets: "" });
  });
});

describe("listDeployments / listStatefulSets / listDaemonSets", () => {
  it("maps deployment replica fields", async () => {
    const ctx = ctxFor({
      "/apis/apps/v1/deployments": {
        items: [
          {
            metadata: meta("api", "prod"),
            spec: {
              replicas: 3,
              template: { spec: { containers: [{ name: "a", image: "img" }] } },
            },
            status: { readyReplicas: 2 },
          },
        ],
      },
    });
    const [d] = await listers.listDeployments(ctx, "a");
    expect(d!.fields).toMatchObject({
      replicas: 3,
      readyReplicas: 2,
      image: "img",
      serviceAccountName: "",
    });
  });

  it("carries the pod template's service account through", async () => {
    const ctx = ctxFor({
      "/apis/apps/v1/deployments": {
        items: [
          {
            metadata: meta("api", "prod"),
            spec: {
              template: {
                spec: { serviceAccountName: "api-sa", containers: [{ name: "a", image: "img" }] },
              },
            },
            status: {},
          },
        ],
      },
      "/apis/apps/v1/statefulsets": {
        items: [
          {
            metadata: meta("db", "prod"),
            spec: {
              template: {
                spec: { serviceAccountName: "db-sa", containers: [{ name: "a", image: "pg" }] },
              },
            },
            status: {},
          },
        ],
      },
    });
    const [d] = await listers.listDeployments(ctx, "a");
    const [s] = await listers.listStatefulSets(ctx, "a");
    expect(d!.fields["serviceAccountName"]).toBe("api-sa");
    expect(s!.fields["serviceAccountName"]).toBe("db-sa");
  });

  it("defaults replicas to 0 when missing", async () => {
    const ctx = ctxFor({
      "/apis/apps/v1/statefulsets": {
        items: [
          {
            metadata: meta("db", "prod"),
            spec: { template: { spec: { containers: [{ name: "a", image: "pg" }] } } },
            status: {},
          },
        ],
      },
    });
    const [s] = await listers.listStatefulSets(ctx, "a");
    expect(s!.fields).toMatchObject({ replicas: 0, readyReplicas: 0 });
  });

  it("maps daemonset schedule fields", async () => {
    const ctx = ctxFor({
      "/apis/apps/v1/daemonsets": {
        items: [
          {
            metadata: meta("agent", "prod"),
            spec: { template: { spec: { containers: [{ name: "a", image: "fluentd" }] } } },
            status: { desiredNumberScheduled: 5, numberReady: 5 },
          },
        ],
      },
    });
    const [d] = await listers.listDaemonSets(ctx, "a");
    expect(d!.fields).toMatchObject({ desiredNumberScheduled: 5, numberReady: 5 });
  });
});

describe("listServices", () => {
  it("formats ports, hasSelector and scopes to a namespace hint", async () => {
    const ctx = ctxFor({
      "/api/v1/namespaces/prod/services": {
        items: [
          {
            metadata: meta("svc", "prod"),
            spec: {
              type: "ClusterIP",
              clusterIP: "10.0.0.1",
              ports: [{ port: 80, protocol: "TCP" }],
              selector: { app: "web" },
            },
          },
        ],
      },
    });
    const [s] = await listers.listServices(ctx, "a", "prod");
    expect(s!.fields).toMatchObject({
      type: "ClusterIP",
      clusterIP: "10.0.0.1",
      ports: "80/TCP",
      hasSelector: "true",
      qualifiedName: "prod/svc",
    });
    expect(s!.resolvedOutputs).toEqual({ serviceName: "svc" });
  });

  it("uses the all-namespaces path with no hint and reports no selector", async () => {
    const ctx = ctxFor({
      "/api/v1/services": {
        items: [{ metadata: meta("hs", "prod"), spec: { type: "ClusterIP" } }],
      },
    });
    const [s] = await listers.listServices(ctx, "a");
    expect(s!.fields["hasSelector"]).toBe("false");
    expect(s!.fields["ports"]).toBe("");
  });
});

describe("listJobs", () => {
  function jobItem(name: string, status: Record<string, unknown>, completions?: number) {
    return {
      metadata: meta(name, "prod"),
      spec: {
        ...(completions ? { completions } : {}),
        template: { spec: { containers: [{ name: "c", image: "busybox" }] } },
      },
      status,
    };
  }
  it("derives Complete / Failed / Running / Pending statuses", async () => {
    const ctx = ctxFor({
      "/apis/batch/v1/jobs": {
        items: [
          jobItem("done", { succeeded: 1 }, 1),
          jobItem("failed", { failed: 2 }, 1),
          jobItem("running", { active: 1 }, 1),
          jobItem("pending", {}, 1),
        ],
      },
    });
    const jobs = await listers.listJobs(ctx, "a");
    expect(jobs.map((j) => j.fields["status"])).toEqual([
      "Complete",
      "Failed",
      "Running",
      "Pending",
    ]);
    expect(jobs[0]!.fields["completions"]).toBe("1/1");
  });

  it("picks the owning CronJob out of the owner references", async () => {
    const ctx = ctxFor({
      "/apis/batch/v1/jobs": {
        items: [
          {
            metadata: {
              ...meta("backup-28401120", "prod"),
              ownerReferences: [
                { kind: "SomethingElse", name: "noise" },
                { kind: "CronJob", name: "backup", controller: true },
              ],
            },
            spec: { template: { spec: { containers: [{ name: "c", image: "busybox" }] } } },
            status: { succeeded: 1 },
          },
          jobItem("standalone", { active: 1 }),
        ],
      },
    });
    const jobs = await listers.listJobs(ctx, "a");
    expect(jobs.map((j) => j.fields["cronJob"])).toEqual(["backup", ""]);
  });
});

describe("listCronJobs", () => {
  it("maps schedule, suspended, lastSchedule", async () => {
    const ctx = ctxFor({
      "/apis/batch/v1/cronjobs": {
        items: [
          {
            metadata: meta("cj", "prod"),
            spec: { schedule: "*/5 * * * *", suspend: true },
            status: { lastScheduleTime: "2024-01-02T00:00:00Z" },
          },
          {
            metadata: meta("cj2", "prod"),
            spec: { schedule: "0 0 * * *" },
            status: {},
          },
        ],
      },
    });
    const cjs = await listers.listCronJobs(ctx, "a");
    expect(cjs[0]!.fields).toMatchObject({
      schedule: "*/5 * * * *",
      suspended: "true",
      lastSchedule: "2024-01-02T00:00:00Z",
      qualifiedName: "prod/cj",
    });
    expect(cjs[1]!.fields).toMatchObject({ suspended: "false", lastSchedule: "" });
  });
});

describe("listIngresses", () => {
  it("joins hosts and load-balancer addresses", async () => {
    const ctx = ctxFor({
      "/apis/networking.k8s.io/v1/ingresses": {
        items: [
          {
            metadata: meta("ing", "prod"),
            spec: { ingressClassName: "nginx", rules: [{ host: "a.com" }, {}] },
            status: { loadBalancer: { ingress: [{ ip: "1.2.3.4" }, { hostname: "lb.example" }] } },
          },
        ],
      },
    });
    const [i] = await listers.listIngresses(ctx, "a");
    expect(i!.fields).toMatchObject({
      ingressClassName: "nginx",
      hosts: "a.com, *",
      address: "1.2.3.4, lb.example",
      services: "",
    });
  });

  it("namespace-qualifies every backend service, default backend included", async () => {
    const ctx = ctxFor({
      "/apis/networking.k8s.io/v1/ingresses": {
        items: [
          {
            metadata: meta("ing", "prod"),
            spec: {
              defaultBackend: { service: { name: "fallback" } },
              rules: [
                {
                  host: "a.com",
                  http: {
                    paths: [
                      { path: "/", backend: { service: { name: "web" } } },
                      { path: "/api", backend: { service: { name: "api" } } },
                      // duplicate of /, and a resource-backend path naming no service
                      { path: "/dup", backend: { service: { name: "web" } } },
                      { path: "/static", backend: { resource: { name: "bucket" } } },
                    ],
                  },
                },
              ],
            },
            status: {},
          },
        ],
      },
    });
    const [i] = await listers.listIngresses(ctx, "a");
    expect(i!.fields["services"]).toBe("prod/fallback, prod/web, prod/api");
  });

  it("handles missing status / rules", async () => {
    const ctx = ctxFor({
      "/apis/networking.k8s.io/v1/ingresses": {
        items: [{ metadata: meta("bare", "prod"), spec: {} }],
      },
    });
    const [i] = await listers.listIngresses(ctx, "a");
    expect(i!.fields).toMatchObject({ ingressClassName: "", hosts: "", address: "" });
  });
});

describe("listConfigMaps", () => {
  it("lists keys and counts", async () => {
    const ctx = ctxFor({
      "/api/v1/configmaps": {
        items: [
          { metadata: meta("cm", "prod"), data: { a: "1", b: "2" } },
          { metadata: meta("empty", "prod") },
        ],
      },
    });
    const cms = await listers.listConfigMaps(ctx, "a");
    expect(cms[0]!.fields).toMatchObject({
      keys: "a, b",
      dataCount: 2,
      qualifiedName: "prod/cm",
    });
    expect(cms[1]!.fields).toMatchObject({ keys: "", dataCount: 0 });
  });
});

describe("listSecrets", () => {
  it("filters service-account tokens and maps type/keys", async () => {
    const ctx = ctxFor({
      "/api/v1/secrets": {
        items: [
          { metadata: meta("app", "prod"), type: "Opaque", data: { token: "x" } },
          {
            metadata: meta("sa", "prod"),
            type: "kubernetes.io/service-account-token",
            data: {},
          },
          { metadata: meta("notype", "prod") },
        ],
      },
    });
    const secrets = await listers.listSecrets(ctx, "a");
    expect(secrets.map((s) => s.displayName)).toEqual(["app", "notype"]);
    expect(secrets[0]!.fields).toMatchObject({
      type: "Opaque",
      keys: "token",
      dataCount: 1,
      qualifiedName: "prod/app",
    });
    expect(secrets[1]!.fields["type"]).toBe("Opaque");
  });
});
