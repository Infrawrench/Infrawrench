/**
 * Live utilization from the `metrics.k8s.io/v1beta1` aggregated API.
 *
 * This API is served by metrics-server, which is an add-on: it is preinstalled
 * on GKE/EKS/AKS/DOKS but absent on plenty of clusters (bare kubeadm, kind,
 * k3s without the bundled chart). **Its absence must never break anything.**
 * Everything here degrades to `null`, and the caller falls back to
 * requests-only allocation.
 *
 * Two distinct absence modes, and they return different things:
 *
 *  - **404** — the APIService was never registered, so the request falls
 *    through to the apiserver's default handler and comes back as a normal
 *    JSON `Status` with `"reason": "NotFound"`. metrics-server is not
 *    installed.
 *  - **503** — the APIService *is* registered but kube-aggregator cannot reach
 *    the backing service (crash-looping pod, wrong node IP, blocked
 *    control-plane-to-node path). The body here is **plain text**
 *    (`service unavailable`), not a JSON `Status`, because the aggregator
 *    calls `http.Error` directly. Do not assume the error body parses.
 *
 * Units, from the API reference: `usage.cpu` is average core usage over
 * `window` in CPU units (emitted with the `n` suffix, e.g. `487558164n` ≈
 * 0.4876 cores) and `usage.memory` is the memory *working set* in bytes
 * (emitted with `Ki`). Both are ordinary quantity strings, so they go through
 * the same parser as requests — which is why that parser has to accept `n`
 * and `u` even though the published grammar omits them.
 */

import type { K8sFetch } from "./shared.js";
import { parseResourceMap, type ResourcePair } from "./quantity.js";

const NODE_METRICS_PATH = "/apis/metrics.k8s.io/v1beta1/nodes";
const POD_METRICS_PATH = "/apis/metrics.k8s.io/v1beta1/pods";

interface NodeMetricsItem {
  metadata: { name: string };
  timestamp?: string;
  window?: string;
  usage?: Record<string, string>;
}

interface PodMetricsItem {
  metadata: { name: string; namespace?: string };
  timestamp?: string;
  window?: string;
  containers?: Array<{ name: string; usage?: Record<string, string> }>;
}

interface MetricsList<T> {
  items?: T[];
}

/** Why utilization is missing, in words a user can act on. */
export type UtilizationStatus =
  | { available: true }
  | { available: false; reason: "not-installed" | "unhealthy" | "forbidden" | "error" };

export interface ClusterUtilization {
  status: UtilizationStatus;
  /** node name → usage. Empty when unavailable. */
  nodes: Map<string, ResourcePair>;
  /** `namespace/name` → summed container usage. Empty when unavailable. */
  pods: Map<string, ResourcePair>;
}

const NO_UTILIZATION: ClusterUtilization = {
  status: { available: false, reason: "not-installed" },
  nodes: new Map(),
  pods: new Map(),
};

/** `namespace/name` — the key pod utilization is looked up by. */
export function podUtilizationKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

/**
 * Classify a failed metrics call. The K8sFetcher stringifies non-2xx
 * responses as `K8s API error <status> at <url>: <body>`, and the host k8s
 * driver produces its own message, so match on the status code wherever it
 * appears rather than on an exact format.
 */
function classify(err: unknown): UtilizationStatus {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b404\b/.test(message) || /NotFound/i.test(message)) {
    return { available: false, reason: "not-installed" };
  }
  if (/\b503\b/.test(message) || /service unavailable/i.test(message)) {
    return { available: false, reason: "unhealthy" };
  }
  if (/\b40[13]\b/.test(message) || /Forbidden/i.test(message)) {
    return { available: false, reason: "forbidden" };
  }
  return { available: false, reason: "error" };
}

/**
 * Fetch node and pod utilization. Never throws: a cluster without
 * metrics-server returns `NO_UTILIZATION` and every caller carries on with
 * requests-based allocation.
 */
export async function fetchClusterUtilization(k8sFetch: K8sFetch): Promise<ClusterUtilization> {
  const [nodeResult, podResult] = await Promise.allSettled([
    k8sFetch<MetricsList<NodeMetricsItem>>(NODE_METRICS_PATH),
    k8sFetch<MetricsList<PodMetricsItem>>(POD_METRICS_PATH),
  ]);

  if (nodeResult.status === "rejected" && podResult.status === "rejected") {
    return { ...NO_UTILIZATION, status: classify(nodeResult.reason) };
  }

  const nodes = new Map<string, ResourcePair>();
  if (nodeResult.status === "fulfilled") {
    for (const item of nodeResult.value?.items ?? []) {
      if (!item?.metadata?.name) continue;
      nodes.set(item.metadata.name, parseResourceMap(item.usage));
    }
  }

  const pods = new Map<string, ResourcePair>();
  if (podResult.status === "fulfilled") {
    for (const item of podResult.value?.items ?? []) {
      if (!item?.metadata?.name) continue;
      // PodMetrics reports per-container usage; a pod's usage is their sum.
      // There is no init-container subtlety here — completed init containers
      // simply do not appear.
      let cpuCores = 0;
      let memoryBytes = 0;
      for (const container of item.containers ?? []) {
        const usage = parseResourceMap(container.usage);
        cpuCores += usage.cpuCores;
        memoryBytes += usage.memoryBytes;
      }
      pods.set(podUtilizationKey(item.metadata.namespace ?? "default", item.metadata.name), {
        cpuCores,
        memoryBytes,
      });
    }
  }

  return { status: { available: true }, nodes, pods };
}

/** One-line explanation of why there is no utilization, for `guidance`. */
export function describeUtilizationGap(status: UtilizationStatus): string | null {
  if (status.available) return null;
  switch (status.reason) {
    case "not-installed":
      return "metrics-server is not installed on this cluster, so live CPU and memory usage is unavailable. Allocation falls back to what workloads request.";
    case "unhealthy":
      return "The metrics.k8s.io API is registered but unreachable — metrics-server is likely crash-looping or blocked from the control plane. Allocation falls back to what workloads request.";
    case "forbidden":
      return "This kubeconfig is not allowed to read metrics.k8s.io. Allocation falls back to what workloads request.";
    default:
      return "Live CPU and memory usage could not be read. Allocation falls back to what workloads request.";
  }
}
