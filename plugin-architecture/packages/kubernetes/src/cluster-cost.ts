/**
 * Wiring between the live cluster and the pure allocation model.
 *
 * Everything provider-shaped happens here: the cluster-wide list calls, parsing
 * quantities into cores and bytes, resolving each node's hourly rate, and
 * deciding what to do when metrics-server is missing. `cost-model.ts` stays
 * pure.
 *
 * Five reads: nodes, pods and metrics for compute, plus PVCs and Services for
 * the storage and load-balancer money. The last two are optional — a
 * kubeconfig allowed to list pods but not PVCs still produces the whole compute
 * allocation, with storage reported as unavailable rather than as zero.
 *
 * The result is cached briefly, because a single peer-pane render asks for it
 * from several places (pill subtitles, dashboard stats, the namespace table)
 * and each call is a handful of cluster-wide list requests.
 */

import type { K8sFetch } from "./shared.js";
import type { K8sList, K8sNode, K8sPersistentVolumeClaim, K8sPod, K8sService } from "./types.js";
import {
  BYTES_PER_GIB,
  parseQuantity,
  parseQuantityOrZero,
  type ResourcePair,
} from "./quantity.js";
import { effectivePodResources, ownerWorkload } from "./pod-resources.js";
import {
  fetchClusterUtilization,
  podUtilizationKey,
  type ClusterUtilization,
} from "./metrics-api.js";
import {
  loadBalancerRate,
  rateForNode,
  storageRate,
  type NodeRateTable,
  type RateSource,
} from "./node-rates.js";
import {
  namespacedKey,
  resolveLoadBalancerTarget,
  resolveVolumeMounts,
  type AttributablePod,
} from "./attribution.js";
import {
  allocateClusterCost,
  type ClusterAllocation,
  type CostModelLoadBalancer,
  type CostModelNode,
  type CostModelPod,
  type CostModelVolume,
} from "./cost-model.js";

/** An allocation plus the provenance a caller needs to describe it honestly. */
export interface ClusterCostResult {
  allocation: ClusterAllocation;
  utilization: ClusterUtilization;
  rateSource: RateSource;
  /** True when we had no rate for any node at all — show capacity, not money. */
  unpriced: boolean;
  /**
   * True when the PVC or Service list could not be read (RBAC, usually).
   * Storage and load-balancer figures are then absent rather than zero, and the
   * surfaces say so instead of claiming the cluster has no disks.
   */
  extrasUnavailable: boolean;
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
  const [nodeList, podList, utilization, claimResult, serviceResult] = await Promise.all([
    k8sFetch<K8sList<K8sNode>>("/api/v1/nodes"),
    k8sFetch<K8sList<K8sPod>>("/api/v1/pods"),
    fetchClusterUtilization(k8sFetch),
    // Storage and load balancers are additive: a kubeconfig that may list pods
    // but not PVCs still gets the full compute allocation. `allSettled` rather
    // than a try/catch each, so one forbidden list never costs us the other.
    k8sFetch<K8sList<K8sPersistentVolumeClaim>>("/api/v1/persistentvolumeclaims").catch(() => null),
    k8sFetch<K8sList<K8sService>>("/api/v1/services").catch(() => null),
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
  const attributable: AttributablePod[] = [];
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
    attributable.push({
      namespace,
      labels: pod.metadata.labels ?? {},
      workload,
      workloadKind,
      claimNames: (pod.spec.volumes ?? [])
        .map((v) => v.persistentVolumeClaim?.claimName ?? "")
        .filter(Boolean),
    });
  }

  const volumes = claimResult ? buildVolumes(claimResult, attributable, rates) : undefined;
  const loadBalancers = serviceResult
    ? buildLoadBalancers(serviceResult, attributable, rates)
    : undefined;

  const allocation = allocateClusterCost({
    nodes,
    pods,
    currency: rates.currency,
    ...(volumes ? { volumes } : {}),
    ...(loadBalancers ? { loadBalancers } : {}),
    ...(rates.controlPlaneHourly !== undefined
      ? { controlPlaneHourlyRate: rates.controlPlaneHourly }
      : {}),
  });

  return {
    allocation,
    utilization,
    rateSource: rates.source,
    unpriced: allocation.pricedNodeCount === 0,
    extrasUnavailable: claimResult == null || serviceResult == null,
  };
}

/**
 * PersistentVolumeClaims, sized and resolved to the workloads that mount them.
 *
 * Which number is "the size" matters. A bound claim reports what the
 * provisioner actually made in `status.capacity.storage`, and that can exceed
 * `spec.resources.requests.storage` — providers round up to their own minimum
 * or granularity, and the bill follows the provisioned size, not the ask. So
 * status wins where it exists and the request is only the fallback for a claim
 * that has not bound.
 */
function buildVolumes(
  list: K8sList<K8sPersistentVolumeClaim>,
  pods: AttributablePod[],
  rates: NodeRateTable,
): CostModelVolume[] {
  const mounts = resolveVolumeMounts(pods);

  return (list.items ?? []).map((pvc) => {
    const namespace = pvc.metadata.namespace ?? "default";
    const provisioned = parseQuantity(pvc.status?.capacity?.["storage"]);
    const requested = parseQuantityOrZero(pvc.spec?.resources?.requests?.["storage"]);
    const bytes = provisioned ?? requested;
    const storageClass = pvc.spec?.storageClassName ?? "";
    const rate = storageRate(rates, storageClass);

    return {
      name: pvc.metadata.name,
      namespace,
      phase: pvc.status?.phase ?? "Pending",
      storageClass,
      gib: bytes / BYTES_PER_GIB,
      capacityBasis: provisioned != null ? ("provisioned" as const) : ("requested" as const),
      mountedBy: mounts.get(namespacedKey(namespace, pvc.metadata.name)) ?? [],
      ...(rate !== undefined ? { gibMonthRate: rate } : {}),
    };
  });
}

/**
 * `LoadBalancer` Services, resolved to their workload where the selector is
 * unambiguous.
 *
 * Every type is listed and only `LoadBalancer` is kept: a ClusterIP costs
 * nothing, and a NodePort costs nothing beyond the nodes already accounted for.
 * `spec.loadBalancerClass` is carried through rather than acted on — a
 * non-default class may be an in-cluster implementation that is free (MetalLB)
 * or a cloud controller that is not (the AWS Load Balancer Controller), and
 * only the operator knows which. The per-Service rate override is how you say.
 */
function buildLoadBalancers(
  list: K8sList<K8sService>,
  pods: AttributablePod[],
  rates: NodeRateTable,
): CostModelLoadBalancer[] {
  const out: CostModelLoadBalancer[] = [];

  for (const service of list.items ?? []) {
    if (service.spec?.type !== "LoadBalancer") continue;
    const namespace = service.metadata.namespace ?? "default";
    const address = (service.status?.loadBalancer?.ingress ?? [])
      .map((entry) => entry.ip ?? entry.hostname ?? "")
      .filter(Boolean)
      .join(", ");
    const target = resolveLoadBalancerTarget(namespace, service.spec.selector, pods);
    const rate = loadBalancerRate(rates, namespace, service.metadata.name);

    out.push({
      name: service.metadata.name,
      namespace,
      address,
      loadBalancerClass: service.spec.loadBalancerClass ?? "",
      ...(target ? { target } : {}),
      ...(rate !== undefined ? { hourlyRate: rate } : {}),
    });
  }

  return out;
}
