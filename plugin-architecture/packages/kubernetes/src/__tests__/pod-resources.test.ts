import { describe, it, expect } from "vitest";

import { effectivePodResources, ownerWorkload } from "../pod-resources.js";
import type { K8sPodSpec } from "../types.js";

const GIB = 1024 ** 3;

function container(name: string, cpu?: string, memory?: string, restartPolicy?: string) {
  return {
    name,
    image: "img",
    ...(cpu || memory
      ? {
          resources: {
            requests: {
              ...(cpu ? { cpu } : {}),
              ...(memory ? { memory } : {}),
            },
          },
        }
      : {}),
    ...(restartPolicy ? { restartPolicy } : {}),
  };
}

describe("effectivePodResources", () => {
  it("sums app containers", () => {
    const spec: K8sPodSpec = {
      containers: [container("a", "250m", "512Mi"), container("b", "250m", "512Mi")],
    };
    expect(effectivePodResources(spec).requests).toEqual({ cpuCores: 0.5, memoryBytes: GIB });
  });

  it("returns zero for a pod that requests nothing", () => {
    const spec: K8sPodSpec = { containers: [container("a")] };
    expect(effectivePodResources(spec).requests).toEqual({ cpuCores: 0, memoryBytes: 0 });
    expect(effectivePodResources(spec).limits).toEqual({ cpuCores: 0, memoryBytes: 0 });
  });

  it("takes the MAX of init containers, not their sum", () => {
    // Init containers run one at a time and finish before the app containers
    // start, so two 2-core init containers never need 4 cores.
    const spec: K8sPodSpec = {
      initContainers: [container("i1", "2"), container("i2", "2")],
      containers: [container("a", "500m")],
    };
    expect(effectivePodResources(spec).requests.cpuCores).toBe(2);
  });

  it("takes the app-container sum when it exceeds the init peak", () => {
    const spec: K8sPodSpec = {
      initContainers: [container("i1", "500m")],
      containers: [container("a", "1"), container("b", "1")],
    };
    expect(effectivePodResources(spec).requests.cpuCores).toBe(2);
  });

  it("compares init and app phases per dimension, not as a whole", () => {
    // An init container that is CPU-heavy and an app container that is
    // memory-heavy each win their own dimension.
    const spec: K8sPodSpec = {
      initContainers: [container("i1", "4", "128Mi")],
      containers: [container("a", "500m", "8Gi")],
    };
    expect(effectivePodResources(spec).requests).toEqual({
      cpuCores: 4,
      memoryBytes: 8 * GIB,
    });
  });

  it("adds sidecars to the app-container sum", () => {
    // A sidecar (initContainer with restartPolicy: Always) runs for the pod's
    // whole life, so it is part of the steady state.
    const spec: K8sPodSpec = {
      initContainers: [container("proxy", "500m", undefined, "Always")],
      containers: [container("a", "1")],
    };
    expect(effectivePodResources(spec).requests.cpuCores).toBe(1.5);
  });

  it("charges a later init container for the sidecars already running", () => {
    // InitContainerUse(i) = Sum(sidecars before i) + InitContainer(i).
    // The 1-core init container runs while the 2-core sidecar is up, so the
    // init peak is 3 — higher than the 2.5 steady state.
    const spec: K8sPodSpec = {
      initContainers: [container("sidecar", "2", undefined, "Always"), container("migrate", "1")],
      containers: [container("a", "500m")],
    };
    expect(effectivePodResources(spec).requests.cpuCores).toBe(3);
  });

  it("does not charge an init container that ran BEFORE the sidecar started", () => {
    // Ordering matters: `migrate` completes before `sidecar` exists, so it is
    // measured alone. The steady state (sidecar + app) wins at 2.5.
    const spec: K8sPodSpec = {
      initContainers: [container("migrate", "1"), container("sidecar", "2", undefined, "Always")],
      containers: [container("a", "500m")],
    };
    expect(effectivePodResources(spec).requests.cpuCores).toBe(2.5);
  });

  it("adds pod overhead on top of everything", () => {
    const spec: K8sPodSpec = {
      containers: [container("a", "1", "1Gi")],
      overhead: { cpu: "250m", memory: "120Mi" },
    };
    const { requests } = effectivePodResources(spec);
    expect(requests.cpuCores).toBe(1.25);
    expect(requests.memoryBytes).toBe(GIB + 120 * 1024 ** 2);
  });

  it("lets pod-level resources REPLACE the container aggregate", () => {
    // KEP-2837: pod-level resources override, they do not add.
    const spec: K8sPodSpec = {
      containers: [container("a", "1", "1Gi"), container("b", "1", "1Gi")],
      resources: { requests: { cpu: "500m", memory: "512Mi" } },
    };
    expect(effectivePodResources(spec).requests).toEqual({
      cpuCores: 0.5,
      memoryBytes: 536_870_912,
    });
  });

  it("overrides only the dimensions pod-level resources actually name", () => {
    const spec: K8sPodSpec = {
      containers: [container("a", "1", "1Gi")],
      resources: { requests: { cpu: "4" } },
    };
    expect(effectivePodResources(spec).requests).toEqual({ cpuCores: 4, memoryBytes: GIB });
  });

  it("applies overhead after a pod-level override", () => {
    const spec: K8sPodSpec = {
      containers: [container("a", "1")],
      resources: { requests: { cpu: "2" } },
      overhead: { cpu: "250m" },
    };
    expect(effectivePodResources(spec).requests.cpuCores).toBe(2.25);
  });

  it("computes limits by the same rules as requests", () => {
    const spec: K8sPodSpec = {
      containers: [
        { name: "a", image: "i", resources: { limits: { cpu: "1", memory: "1Gi" } } },
        { name: "b", image: "i", resources: { limits: { cpu: "1", memory: "1Gi" } } },
      ],
    };
    expect(effectivePodResources(spec).limits).toEqual({
      cpuCores: 2,
      memoryBytes: 2 * GIB,
    });
  });
});

describe("ownerWorkload", () => {
  it("falls back to the pod's own name for a bare pod", () => {
    expect(ownerWorkload(undefined, undefined, "adhoc")).toEqual({
      workload: "adhoc",
      workloadKind: "Pod",
    });
    expect(ownerWorkload([], {}, "adhoc")).toEqual({ workload: "adhoc", workloadKind: "Pod" });
  });

  it("rewrites a ReplicaSet owner to its Deployment", () => {
    expect(
      ownerWorkload(
        [{ kind: "ReplicaSet", name: "web-7d9f8c4b6", controller: true }],
        { "pod-template-hash": "7d9f8c4b6" },
        "web-7d9f8c4b6-x9q2p",
      ),
    ).toEqual({ workload: "web", workloadKind: "Deployment" });
  });

  it("keeps the ReplicaSet name when the template hash does not match", () => {
    // Better a slightly noisy name than a wrongly-truncated one.
    expect(
      ownerWorkload(
        [{ kind: "ReplicaSet", name: "web-abc", controller: true }],
        { "pod-template-hash": "zzz" },
        "pod",
      ),
    ).toEqual({ workload: "web-abc", workloadKind: "Deployment" });
  });

  it("reports StatefulSet, DaemonSet and Job owners directly", () => {
    expect(
      ownerWorkload([{ kind: "StatefulSet", name: "db", controller: true }], {}, "db-0"),
    ).toEqual({ workload: "db", workloadKind: "StatefulSet" });
    expect(
      ownerWorkload([{ kind: "DaemonSet", name: "agent", controller: true }], {}, "agent-x"),
    ).toEqual({ workload: "agent", workloadKind: "DaemonSet" });
    expect(ownerWorkload([{ kind: "Job", name: "backup-123", controller: true }], {}, "p")).toEqual(
      { workload: "backup-123", workloadKind: "Job" },
    );
  });

  it("prefers the controller owner over a non-controller reference", () => {
    expect(
      ownerWorkload(
        [
          { kind: "SomethingElse", name: "noise" },
          { kind: "StatefulSet", name: "db", controller: true },
        ],
        {},
        "db-0",
      ),
    ).toEqual({ workload: "db", workloadKind: "StatefulSet" });
  });
});
