import { describe, expect, it } from "vitest";
import { injectK8sFailure, prepareK8sFailure, undoK8sFailure } from "../failure-actions.js";
import type { K8sFetch } from "../shared.js";

interface Call {
  path: string;
  method: string;
  body?: string;
  contentType?: string;
}

/** A cluster holding one scale subresource, recording every request. */
function fakeCluster(replicas: number): { fetch: K8sFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (path: string, options?: RequestInit) => {
    const headers = (options?.headers ?? {}) as Record<string, string>;
    calls.push({
      path,
      method: options?.method ?? "GET",
      ...(options?.body !== undefined ? { body: String(options.body) } : {}),
      ...(headers["Content-Type"] ? { contentType: headers["Content-Type"] } : {}),
    });
    if (options?.method === "PATCH") {
      replicas = (JSON.parse(String(options.body)) as { spec: { replicas: number } }).spec.replicas;
    }
    return { kind: "Scale", spec: { replicas } };
  }) as K8sFetch;
  return { fetch, calls };
}

const deployment = "acct:k8s-deployment:shop:checkout";

describe("scale-to-zero", () => {
  it("reads the replica count before anything changes", async () => {
    const { fetch, calls } = fakeCluster(3);
    const prepared = await prepareK8sFailure(fetch, "k8s-deployment", deployment, "scale-to-zero");
    expect(prepared).toEqual({
      undo: { replicas: 3 },
      alreadyInEffect: false,
      currentState: "3 replicas",
    });
    expect(calls).toEqual([
      { path: "/apis/apps/v1/namespaces/shop/deployments/checkout/scale", method: "GET" },
    ]);
  });

  it("scales to zero and back to the stored count through the scale subresource", async () => {
    const { fetch, calls } = fakeCluster(3);
    await injectK8sFailure(fetch, "k8s-deployment", deployment, "scale-to-zero");
    await undoK8sFailure(fetch, "k8s-deployment", deployment, "scale-to-zero", { replicas: 3 });
    expect(calls).toEqual([
      {
        path: "/apis/apps/v1/namespaces/shop/deployments/checkout/scale",
        method: "PATCH",
        body: '{"spec":{"replicas":0}}',
        contentType: "application/merge-patch+json",
      },
      {
        path: "/apis/apps/v1/namespaces/shop/deployments/checkout/scale",
        method: "PATCH",
        body: '{"spec":{"replicas":3}}',
        contentType: "application/merge-patch+json",
      },
    ]);
  });

  it("reports a workload already at zero as in effect", async () => {
    const { fetch } = fakeCluster(0);
    const prepared = await prepareK8sFailure(
      fetch,
      "k8s-statefulset",
      "acct:k8s-statefulset:db:pg",
      "scale-to-zero",
    );
    expect(prepared.alreadyInEffect).toBe(true);
  });

  it("refuses an undo without a stored count, and types it does not scale", async () => {
    const { fetch } = fakeCluster(3);
    await expect(
      undoK8sFailure(fetch, "k8s-deployment", deployment, "scale-to-zero", {}),
    ).rejects.toThrow(/replica count/);
    await expect(
      injectK8sFailure(fetch, "k8s-daemonset", "acct:k8s-daemonset:a:b", "scale-to-zero"),
    ).rejects.toThrow(/no failure action/);
  });
});
