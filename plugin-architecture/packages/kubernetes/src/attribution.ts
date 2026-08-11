/**
 * Resolving non-compute objects to the workload that owns them.
 *
 * Node compute attributes itself: a pod names its node, and that is the end of
 * it. Storage and load balancers do not — a PVC knows nothing about the pods
 * that mount it, and a Service knows nothing about the Deployment behind its
 * selector. Both links have to be reconstructed from the pod list, and both
 * have an ambiguous case that must resolve to "no single workload" rather than
 * to a guess.
 *
 * Pure: plain data in, plain data out, no fetching. `cluster-cost.ts` supplies
 * the shapes from live API objects.
 */

import type { AttributionTarget } from "./cost-model.js";

/** What this module needs to know about a pod. Nothing to do with cost. */
export interface AttributablePod {
  namespace: string;
  /** `metadata.labels` — what a Service selector is matched against. */
  labels: Record<string, string>;
  workload: string;
  workloadKind: string;
  /**
   * `spec.volumes[].persistentVolumeClaim.claimName`, unqualified. A claimName
   * always names a PVC in the pod's own namespace, so the namespace above is
   * the qualification.
   */
  claimNames: string[];
}

/** `namespace/name` — how both PVCs and Services are keyed here. */
export function namespacedKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

/**
 * Does a Service selector match a pod's labels?
 *
 * Services take **equality-based selectors only** — the selector is a plain
 * map, and the Kubernetes labels documentation is explicit that for Service
 * and ReplicationController "only equality-based requirement selectors are
 * supported". So this is an exact subset test and not a selector engine, and
 * it cannot silently under-match the way a partial `matchExpressions`
 * implementation would.
 *
 * An **empty selector never matches anything.** In Kubernetes an empty
 * selector on a Service does not mean "all pods" — it means the Service has no
 * selector at all and its Endpoints are managed by hand (an ExternalName-style
 * indirection, or a service pointing at something outside the cluster). Such a
 * Service has no workload behind it, which is exactly what returning `false`
 * expresses.
 */
export function selectorMatches(
  selector: Record<string, string> | undefined,
  labels: Record<string, string>,
): boolean {
  if (!selector) return false;
  const entries = Object.entries(selector);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => labels[key] === value);
}

/**
 * Which workloads mount each PersistentVolumeClaim.
 *
 * Keyed `namespace/claimName`. A claim mounted by two pods of the same
 * Deployment yields one workload, not two — the caller de-duplicates, but the
 * grouping by workload identity happens here so the "is this shared?" question
 * is asked about workloads rather than about pods.
 *
 * A claim nobody mounts simply has no entry, which is what makes it show up as
 * unattached: the storage exists and is billed, and no running workload is
 * using it.
 */
export function resolveVolumeMounts(pods: AttributablePod[]): Map<string, AttributionTarget[]> {
  const byClaim = new Map<string, Map<string, AttributionTarget>>();

  for (const pod of pods) {
    for (const claimName of pod.claimNames) {
      if (!claimName) continue;
      const key = namespacedKey(pod.namespace, claimName);
      let targets = byClaim.get(key);
      if (!targets) {
        targets = new Map();
        byClaim.set(key, targets);
      }
      targets.set(`${pod.workloadKind}/${pod.workload}`, {
        workload: pod.workload,
        workloadKind: pod.workloadKind,
      });
    }
  }

  const out = new Map<string, AttributionTarget[]>();
  for (const [key, targets] of byClaim) out.set(key, [...targets.values()]);
  return out;
}

/**
 * The single workload behind a `LoadBalancer` Service, or `undefined`.
 *
 * `undefined` for all three ambiguous cases, and the ambiguity is real rather
 * than a limitation:
 *
 *  - **No selector** — the Service's Endpoints are managed by hand. There is
 *    no workload to name.
 *  - **No matching pod** — a Service whose selector matches nothing. The load
 *    balancer is provisioned and billing while routing to nowhere, which is a
 *    finding in its own right, but it is not any workload's cost.
 *  - **Several workloads matched** — the classic shape is a canary or a
 *    blue/green pair sharing one Service. Splitting one indivisible load
 *    balancer between them would be an invented apportionment; the namespace
 *    is the tightest honest scope, and that is where the caller puts it.
 */
export function resolveLoadBalancerTarget(
  namespace: string,
  selector: Record<string, string> | undefined,
  pods: AttributablePod[],
): AttributionTarget | undefined {
  if (!selector || Object.keys(selector).length === 0) return undefined;

  const matched = new Map<string, AttributionTarget>();
  for (const pod of pods) {
    if (pod.namespace !== namespace) continue;
    if (!selectorMatches(selector, pod.labels)) continue;
    matched.set(`${pod.workloadKind}/${pod.workload}`, {
      workload: pod.workload,
      workloadKind: pod.workloadKind,
    });
    // Two distinct workloads is already ambiguous; a third changes nothing.
    if (matched.size > 1) return undefined;
  }

  return matched.size === 1 ? [...matched.values()][0] : undefined;
}
