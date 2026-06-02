import { describe, expect, it, vi, type Mock } from "vitest";
import { getLogs } from "../logs.js";
import type { K8sFetcher } from "../shared.js";

interface FakeFetcher {
  fetch: Mock;
  fetchText: Mock;
}

function fakeFetcher(
  jsonByPath: Record<string, unknown>,
  text = "log output",
): FakeFetcher & K8sFetcher {
  return {
    fetch: vi.fn(async (path: string) => {
      const key = Object.keys(jsonByPath).find((k) => path.startsWith(k));
      if (key) return jsonByPath[key];
      throw new Error(`unexpected fetch path ${path}`);
    }),
    fetchText: vi.fn(async () => text),
  } as unknown as FakeFetcher & K8sFetcher;
}

describe("getLogs for a pod", () => {
  it("reads the pod directly and returns containers + active container", async () => {
    const f = fakeFetcher({
      "/api/v1/namespaces/prod/pods/mypod": {
        spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
      },
    });
    const result = await getLogs("k8s-pod", "a:k8s-pod:prod:mypod", { tailLines: 100 }, f);
    expect(result).toEqual({
      text: "log output",
      containers: ["app", "sidecar"],
      activeContainer: "app",
    });
    // log fetch uses query string with tailLines and timestamps
    const logCall = f.fetchText.mock.calls[0]![0] as string;
    expect(logCall).toContain("/pods/mypod/log");
    expect(logCall).toContain("tailLines=100");
    expect(logCall).toContain("timestamps=true");
  });

  it("honors an explicit container and previous flag, defaults tailLines to 500", async () => {
    const f = fakeFetcher({
      "/api/v1/namespaces/prod/pods/mypod": {
        spec: { containers: [{ name: "app" }, { name: "sidecar" }] },
      },
    });
    const result = await getLogs(
      "k8s-pod",
      "a:k8s-pod:prod:mypod",
      { container: "sidecar", previous: true },
      f,
    );
    expect(result.activeContainer).toBe("sidecar");
    const logCall = f.fetchText.mock.calls[0]![0] as string;
    expect(logCall).toContain("container=sidecar");
    expect(logCall).toContain("previous=true");
    expect(logCall).toContain("tailLines=500");
  });

  it("falls back to the first container when the requested one is missing", async () => {
    const f = fakeFetcher({
      "/api/v1/namespaces/prod/pods/mypod": { spec: { containers: [{ name: "app" }] } },
    });
    const result = await getLogs("k8s-pod", "a:k8s-pod:prod:mypod", { container: "ghost" }, f);
    expect(result.activeContainer).toBe("app");
  });

  it("throws when the resource is not namespaced", async () => {
    const f = fakeFetcher({});
    await expect(getLogs("k8s-pod", "a:k8s-pod:onlyname", {}, f)).rejects.toThrow(
      /require a namespaced resource/,
    );
  });

  it("throws when the pod has no containers", async () => {
    const f = fakeFetcher({
      "/api/v1/namespaces/prod/pods/mypod": { spec: { containers: [] } },
    });
    await expect(getLogs("k8s-pod", "a:k8s-pod:prod:mypod", {}, f)).rejects.toThrow(
      /no containers/,
    );
  });
});

describe("getLogs for workloads via selector", () => {
  it("resolves a deployment's pod via matchLabels, preferring a Running pod", async () => {
    const f = fakeFetcher({
      "/apis/apps/v1/namespaces/prod/deployments/api": {
        spec: { selector: { matchLabels: { app: "api" } } },
      },
      "/api/v1/namespaces/prod/pods?labelSelector=": {
        items: [
          { metadata: { name: "api-aaa" }, status: { phase: "Pending" } },
          { metadata: { name: "api-bbb" }, status: { phase: "Running" } },
        ],
      },
      "/api/v1/namespaces/prod/pods/api-bbb": {
        spec: { containers: [{ name: "api" }] },
      },
    });
    const result = await getLogs("k8s-deployment", "a:k8s-deployment:prod:api", {}, f);
    expect(result.activeContainer).toBe("api");
    // the running pod was selected
    expect(f.fetch).toHaveBeenCalledWith("/api/v1/namespaces/prod/pods/api-bbb");
  });

  it("uses job-name label selector for jobs", async () => {
    const f = fakeFetcher({
      "/api/v1/namespaces/prod/pods?labelSelector=": {
        items: [{ metadata: { name: "job-xyz" }, status: { phase: "Succeeded" } }],
      },
      "/api/v1/namespaces/prod/pods/job-xyz": { spec: { containers: [{ name: "job" }] } },
    });
    const result = await getLogs("k8s-job", "a:k8s-job:prod:myjob", {}, f);
    expect(result.activeContainer).toBe("job");
    const selectorCall = (f.fetch.mock.calls.find((c) =>
      String(c[0]).includes("labelSelector"),
    )?.[0] ?? "") as string;
    expect(decodeURIComponent(selectorCall)).toContain("job-name=myjob");
  });

  it("resolves a service's pod via spec.selector", async () => {
    const f = fakeFetcher({
      "/api/v1/namespaces/prod/services/svc": { spec: { selector: { app: "web" } } },
      "/api/v1/namespaces/prod/pods?labelSelector=": {
        items: [{ metadata: { name: "web-1" }, status: { phase: "Running" } }],
      },
      "/api/v1/namespaces/prod/pods/web-1": { spec: { containers: [{ name: "web" }] } },
    });
    const result = await getLogs("k8s-service", "a:k8s-service:prod:svc", {}, f);
    expect(result.activeContainer).toBe("web");
  });

  it("throws when a workload has no matchLabels", async () => {
    const f = fakeFetcher({
      "/apis/apps/v1/namespaces/prod/statefulsets/db": { spec: { selector: {} } },
    });
    await expect(getLogs("k8s-statefulset", "a:k8s-statefulset:prod:db", {}, f)).rejects.toThrow(
      /no matchLabels/,
    );
  });

  it("throws when a service has no selector", async () => {
    const f = fakeFetcher({
      "/api/v1/namespaces/prod/services/svc": { spec: {} },
    });
    await expect(getLogs("k8s-service", "a:k8s-service:prod:svc", {}, f)).rejects.toThrow(
      /no pod selector/,
    );
  });

  it("throws for unsupported log types", async () => {
    const f = fakeFetcher({});
    await expect(getLogs("k8s-configmap", "a:k8s-configmap:prod:cm", {}, f)).rejects.toThrow(
      /logs not supported/,
    );
  });

  it("throws when no pods match the selector", async () => {
    const f = fakeFetcher({
      "/apis/apps/v1/namespaces/prod/daemonsets/ds": {
        spec: { selector: { matchLabels: { app: "ds" } } },
      },
      "/api/v1/namespaces/prod/pods?labelSelector=": { items: [] },
    });
    await expect(getLogs("k8s-daemonset", "a:k8s-daemonset:prod:ds", {}, f)).rejects.toThrow(
      /no pods matched/,
    );
  });
});
