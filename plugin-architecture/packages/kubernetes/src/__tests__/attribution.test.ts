import { describe, it, expect } from "vitest";

import {
  namespacedKey,
  resolveLoadBalancerTarget,
  resolveVolumeMounts,
  selectorMatches,
  type AttributablePod,
} from "../attribution.js";

function pod(over: Partial<AttributablePod> = {}): AttributablePod {
  return {
    namespace: "app",
    labels: { app: "web", tier: "frontend" },
    workload: "web",
    workloadKind: "Deployment",
    claimNames: [],
    ...over,
  };
}

describe("selectorMatches", () => {
  it("matches when every selector pair is present on the pod", () => {
    expect(selectorMatches({ app: "web" }, { app: "web", tier: "frontend" })).toBe(true);
    expect(
      selectorMatches({ app: "web", tier: "frontend" }, { app: "web", tier: "frontend" }),
    ).toBe(true);
  });

  it("does not match on a partial or wrong value", () => {
    expect(selectorMatches({ app: "web", tier: "backend" }, { app: "web", tier: "frontend" })).toBe(
      false,
    );
    expect(selectorMatches({ app: "api" }, { app: "web" })).toBe(false);
  });

  it("treats an absent or empty selector as matching nothing", () => {
    // A Service with no selector has hand-managed Endpoints; it does NOT mean
    // "every pod". Reading it as a wildcard would attribute one load balancer
    // to the entire namespace's workloads at once.
    expect(selectorMatches(undefined, { app: "web" })).toBe(false);
    expect(selectorMatches({}, { app: "web" })).toBe(false);
  });
});

describe("resolveVolumeMounts", () => {
  it("maps a claim to the workload that mounts it", () => {
    const mounts = resolveVolumeMounts([pod({ claimNames: ["data"] })]);
    expect(mounts.get(namespacedKey("app", "data"))).toEqual([
      { workload: "web", workloadKind: "Deployment" },
    ]);
  });

  it("counts two pods of the same workload once", () => {
    const mounts = resolveVolumeMounts([
      pod({ claimNames: ["data"] }),
      pod({ claimNames: ["data"] }),
    ]);
    expect(mounts.get(namespacedKey("app", "data"))).toHaveLength(1);
  });

  it("reports every distinct workload for a shared claim", () => {
    const mounts = resolveVolumeMounts([
      pod({ claimNames: ["shared"] }),
      pod({ workload: "worker", claimNames: ["shared"] }),
    ]);
    expect(mounts.get(namespacedKey("app", "shared"))).toHaveLength(2);
  });

  it("keys by namespace, so the same claim name in two namespaces is two claims", () => {
    const mounts = resolveVolumeMounts([
      pod({ claimNames: ["data"] }),
      pod({ namespace: "other", workload: "api", claimNames: ["data"] }),
    ]);
    expect(mounts.get(namespacedKey("app", "data"))).toEqual([
      { workload: "web", workloadKind: "Deployment" },
    ]);
    expect(mounts.get(namespacedKey("other", "data"))).toEqual([
      { workload: "api", workloadKind: "Deployment" },
    ]);
  });

  it("has no entry for a claim nobody mounts", () => {
    const mounts = resolveVolumeMounts([pod()]);
    expect(mounts.get(namespacedKey("app", "orphan"))).toBeUndefined();
  });
});

describe("resolveLoadBalancerTarget", () => {
  it("resolves to the single workload its selector matches", () => {
    expect(resolveLoadBalancerTarget("app", { app: "web" }, [pod()])).toEqual({
      workload: "web",
      workloadKind: "Deployment",
    });
  });

  it("refuses to pick when two workloads match — a canary pair is ambiguous", () => {
    const pods = [pod(), pod({ workload: "web-canary", labels: { app: "web", tier: "canary" } })];
    expect(resolveLoadBalancerTarget("app", { app: "web" }, pods)).toBeUndefined();
  });

  it("returns undefined when the selector matches nothing", () => {
    expect(resolveLoadBalancerTarget("app", { app: "missing" }, [pod()])).toBeUndefined();
  });

  it("returns undefined for a selectorless Service", () => {
    expect(resolveLoadBalancerTarget("app", undefined, [pod()])).toBeUndefined();
    expect(resolveLoadBalancerTarget("app", {}, [pod()])).toBeUndefined();
  });

  it("never matches a pod in another namespace", () => {
    const pods = [pod({ namespace: "other" })];
    expect(resolveLoadBalancerTarget("app", { app: "web" }, pods)).toBeUndefined();
  });
});
