/**
 * Wiring between the live cluster and the pure allocation model.
 *
 * Everything provider-shaped happens here: three API calls, parsing quantities
 * into cores and bytes, resolving each node's hourly rate, and deciding what
 * to do when metrics-server is missing. `cost-model.ts` stays pure.
 *
 * The result is cached briefly, because a single peer-pane render asks for it
 * from several places (pill subtitles, dashboard stats, the namespace table)
 * and each call is three cluster-wide list requests.
 */

import type { K8sFetch } from "./shared.js";
import type { K8sList, K8sNode, K8sPod } from "./types.js";
import { parseQuantityOrZero, type ResourcePair } from "./quantity.js";
import { effectivePodResources, ownerWorkload } from "./pod-resources.js";
import {
  fetchClusterUtilization,
  podUtilizationKey,
  type ClusterUtilization,
} from "./metrics-api.js";
import {
  parseNodeRates,
  rateForNode,
  hasAnyRate,
  type NodeRateTable,
  type RateSource,
} from "./node-rates.js";
import {
  allocateClusterCost,
  type ClusterAllocation,
  type CostModelNode,
  type CostModelPod,
} from "./cost-model.js";

/** An allocation plus the provenance a caller needs to describe it honestly. */
export interface ClusterCostResult {
  allocation: ClusterAllocation;
  utilization: ClusterUtilization;
  rateSource: RateSource;
  /** True when we had no rate for any node at all — show capacity, not money. */
  unpriced: boolean;
}

function pairFrom(map: Record<string, string> | undefined): ResourcePair {
  return {
    cpuCores: parseQuantityOrZero(map?.["cpu"]),
    memoryBytes: parseQuantityOrZero(map?.["memory"]),
  };
}

/**
 * Build and run the allocation for a cluster.
 *
 * Pods are listed with `includeSystemNamespaces` semantics baked in: this
 * function calls `/api/v1/pods` directly rather than going through `listPods`,
 * precisely so it cannot inherit that lister's `SYSTEM_NAMESPACES` skip-set.
 * kube-system's pods sit on the same nodes and hold real capacity; dropping
 * them would make their spend vanish and inflate everyone else's share.
 */
export async function computeClusterCost(
  k8sFetch: K8sFetch,
  rates: NodeRateTable,
): Promise<ClusterCostResult> {
  const [nodeList, podList, utilization] = await Promise.all([
    k8sFetch<K8sList<K8sNode>>("/api/v1/nodes"),
    k8sFetch<K8sList<K8sPod>>("/api/v1/pods"),
    fetchClusterUtilization(k8sFetch),
  ]);

  const nodes: CostModelNode[] = (nodeList.items ?? []).map((n) => {
    const labels = n.metadata.labels ?? {};
    const instanceType =
      labels["node.kubernetes.io/instance-type"] ??
      labels["beta.kubernetes.io/instance-type"] ??
      "";
    const capacity = pairFrom(n.status?.capacity);
    const allocatableRaw = pairFrom(n.status?.allocatable);
    // A node that reports allocatable but no capacity (some virtual-kubelet
    // providers) would otherwise get a zero denominator and silently allocate
    // nothing. Fall back to allocatable so the money still lands somewhere.
    const effectiveCapacity =
      capacity.cpuCores > 0 || capacity.memoryBytes > 0 ? capacity : allocatableRaw;
    const rate = rateForNode(rates, n.metadata.name, instanceType);
    return {
      name: n.metadata.name,
      capacity: effectiveCapacity,
      allocatable: allocatableRaw,
      instanceType,
      zone: labels["topology.kubernetes.io/zone"] ?? "",
      region: labels["topology.kubernetes.io/region"] ?? "",
      ...(rate !== undefined ? { hourlyRate: rate } : {}),
      ...(utilization.nodes.get(n.metadata.name)
        ? { usage: utilization.nodes.get(n.metadata.name)! }
        : {}),
    };
  });

  const pods: CostModelPod[] = [];
  for (const pod of podList.items ?? []) {
    // Terminal pods hold no capacity — a Succeeded Job pod is not costing
    // anything, and charging for it would double-count against whatever
    // replaced it.
    const phase = pod.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") continue;

    const namespace = pod.metadata.namespace ?? "default";
    const { requests, limits } = effectivePodResources(pod.spec);
    const { workload, workloadKind } = ownerWorkload(
      pod.metadata.ownerReferences,
      pod.metadata.labels,
      pod.metadata.name,
    );
    const usage = utilization.pods.get(podUtilizationKey(namespace, pod.metadata.name));
    pods.push({
      name: pod.metadata.name,
      namespace,
      nodeName: pod.spec.nodeName ?? "",
      workload,
      workloadKind,
      requests,
      limits,
      ...(usage ? { usage } : {}),
    });
  }

  const allocation = allocateClusterCost({ nodes, pods, currency: rates.currency });

  return {
    allocation,
    utilization,
    rateSource: rates.source,
    unpriced: allocation.pricedNodeCount === 0,
  };
}

/** Convenience: parse the credential and run, in one call. */
export async function computeClusterCostFromCredential(
  k8sFetch: K8sFetch,
  rawRates: string | undefined,
): Promise<ClusterCostResult> {
  return computeClusterCost(k8sFetch, parseNodeRates(rawRates));
}

export { hasAnyRate };
