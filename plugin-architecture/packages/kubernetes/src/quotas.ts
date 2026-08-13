/**
 * Kubernetes quota readings — the cluster's own `ResourceQuota` objects.
 *
 * This is the one provider where the quota contract is not an adaptation of
 * something else: a `ResourceQuota`'s `status` carries `hard` and `used` maps
 * over the same keys, which is precisely `limit` and `used` over the same
 * unit. One unpaginated `GET /api/v1/resourcequotas` across all namespaces
 * returns every quota in the cluster with both halves already joined.
 *
 * Shape (`k8s.io/api/core/v1.ResourceQuotaStatus`, stable since v1.0):
 *
 * ```json
 * { "items": [ { "metadata": { "name": "compute", "namespace": "team-a" },
 *                "status": { "hard": { "requests.cpu": "20", "limits.memory": "40Gi" },
 *                            "used": { "requests.cpu": "8500m", "limits.memory": "12Gi" } } } ] }
 * ```
 *
 * Values are `resource.Quantity` strings, not numbers — `8500m` is 8.5 CPUs
 * and `40Gi` is 42,949,672,960 bytes. `quantity.ts` already parses them,
 * including the `M` (10^6) versus `Mi` (2^20) trap that under-counts memory by
 * 4.9% in the same direction every time, so it never looks like a bug.
 *
 * Two things this deliberately does **not** report:
 *
 * - **`LimitRange`.** It bounds an individual pod, not an aggregate, so it has
 *   no "used" and cannot be a utilisation.
 * - **Node capacity.** A cluster running out of allocatable CPU is a real and
 *   common outage, but it is not a *quota* — nobody approves an increase, you
 *   add nodes — and folding it in would put a row on the radar whose call to
 *   action is nothing like every other row's.
 */

import type { QuotaUsage } from "@infrawrench/plugin-base";

import { parseQuantity } from "./quantity.js";

/** One `ResourceQuota` object, narrowed to what this module reads. */
export interface K8sResourceQuota {
  metadata?: { name?: string; namespace?: string };
  status?: {
    hard?: Record<string, string>;
    used?: Record<string, string>;
  };
}

interface K8sResourceQuotaList {
  items?: K8sResourceQuota[];
}

/** The client's bound `k8sFetch`. */
export interface K8sQuotaContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
}

/**
 * Human labels for the standard resource names. Kubernetes' own keys are
 * precise and unreadable — `count/persistentvolumeclaims` beside
 * `limits.memory` in a list is not a set of labels a person scans.
 *
 * An unmapped key is titled from itself rather than dropped: `ResourceQuota`
 * covers arbitrary extended resources (`requests.nvidia.com/gpu`, a CRD's
 * `count/widgets.example.com`) and a table of known names would silently miss
 * exactly the scarce, contended things people set quotas on.
 */
const RESOURCE_LABELS: Record<string, string> = {
  "requests.cpu": "CPU requests",
  "limits.cpu": "CPU limits",
  "requests.memory": "Memory requests",
  "limits.memory": "Memory limits",
  "requests.storage": "Storage requests",
  "requests.ephemeral-storage": "Ephemeral storage requests",
  "limits.ephemeral-storage": "Ephemeral storage limits",
  cpu: "CPU",
  memory: "Memory",
  pods: "Pods",
  services: "Services",
  secrets: "Secrets",
  configmaps: "ConfigMaps",
  replicationcontrollers: "Replication controllers",
  resourcequotas: "Resource quotas",
  persistentvolumeclaims: "Persistent volume claims",
  "services.loadbalancers": "LoadBalancer services",
  "services.nodeports": "NodePort services",
};

export function resourceLabel(key: string): string {
  const mapped = RESOURCE_LABELS[key];
  if (mapped) return mapped;
  // `count/deployments.apps` → "deployments.apps".
  if (key.startsWith("count/")) return key.slice("count/".length);
  return key;
}

/**
 * The unit a parsed quantity is now in.
 *
 * `parseQuantity` normalises to base units — cores for CPU, bytes for memory —
 * so the unit has to describe the *parsed* number, not the string it came
 * from. Saying "GB" next to a byte count is off by nine orders of magnitude,
 * and the surface has no way to notice.
 */
export function unitForResource(key: string): string | undefined {
  const bare = key.replace(/^(requests|limits)\./, "");
  if (bare === "cpu") return "cores";
  if (bare === "memory" || bare === "storage" || bare === "ephemeral-storage") return "bytes";
  return undefined;
}

/**
 * Turn one `ResourceQuota` into readings, one per resource key it constrains.
 *
 * Iterates `hard`, not `used`: `hard` is the set of things this quota actually
 * limits, and a key present in `used` but absent from `hard` is a resource
 * being consumed under no ceiling — which has no utilisation and belongs on a
 * usage screen, not a radar.
 *
 * A `used` key that is *missing* is read as zero rather than dropped, because
 * that is what it means: the API server omits a used entry only when nothing
 * in the namespace consumes that resource. A key that is present but
 * **unparseable** is dropped instead — that is a fact we do not have, and
 * calling it zero would draw an empty bar under a ceiling that may be full.
 */
export function quotaReadingsFor(quota: K8sResourceQuota): QuotaUsage[] {
  const namespace = quota.metadata?.namespace;
  const name = quota.metadata?.name;
  if (!namespace || !name) return [];

  const hard = quota.status?.hard ?? {};
  const used = quota.status?.used ?? {};
  const readings: QuotaUsage[] = [];

  for (const [key, hardValue] of Object.entries(hard)) {
    const limit = parseQuantity(hardValue);
    if (limit === null || limit <= 0) continue;

    const usedRaw = used[key];
    let usedValue: number;
    if (usedRaw === undefined) {
      usedValue = 0;
    } else {
      const parsed = parseQuantity(usedRaw);
      if (parsed === null) continue;
      usedValue = parsed;
    }

    const unit = unitForResource(key);
    readings.push({
      // Namespace and object name both in the id: two namespaces routinely
      // hold a `ResourceQuota` called `compute`, and keying on the resource
      // name alone would collapse every team's CPU quota into one series.
      id: `resourcequota/${namespace}/${name}/${key}`,
      // The namespace is the service, because it is the thing a reader groups
      // by — "which team is out of headroom" is the question, and the quota
      // object's own name is an implementation detail of how they wrote it.
      service: namespace,
      name: `${resourceLabel(key)} (${name})`,
      limit,
      used: usedValue,
      ...(unit ? { unit } : {}),
      // A `ResourceQuota` is a cluster object the user can edit — there is no
      // support ticket and no provider to ask. `false` would say "you cannot
      // change this", which is the opposite of true.
      adjustable: true,
      docsUrl: "https://kubernetes.io/docs/concepts/policy/resource-quotas/",
    });
  }

  return readings;
}

/**
 * Read every `ResourceQuota` in the cluster.
 *
 * A cluster with no `ResourceQuota` objects legitimately returns nothing, and
 * that is **not** an error: quotas are opt-in in Kubernetes and most small
 * clusters have none. It is the one provider here where an empty result is a
 * true statement about the cluster rather than a hint that something is
 * misconfigured, so unlike AWS and GCP this never throws a
 * {@link QuotaAccessError} on emptiness — a genuinely missing permission comes
 * back from the API server as a 403 and propagates as itself.
 */
export async function fetchK8sQuotas(ctx: K8sQuotaContext): Promise<QuotaUsage[]> {
  const list = await ctx.fetch<K8sResourceQuotaList>("/api/v1/resourcequotas");
  const readings: QuotaUsage[] = [];
  for (const item of list.items ?? []) readings.push(...quotaReadingsFor(item));
  return readings;
}
