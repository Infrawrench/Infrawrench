/**
 * Effective Pod resource requests and limits.
 *
 * This is *not* "sum the containers". Kubernetes schedules against an
 * effective figure that accounts for init containers running before the app
 * containers, sidecars (init containers with `restartPolicy: Always`, KEP-753)
 * running alongside them, pod-level resources (KEP-2837), and pod overhead.
 * Getting it wrong silently mis-sizes every derived cost, so the rules are
 * spelled out here.
 *
 * The canonical rule, from the sidecar-containers concept page and KEP-753
 * (and implemented in `component-helpers/resource/helpers.go`):
 *
 *     InitContainerUse(i) = Sum(sidecars with index < i) + InitContainer(i)
 *
 *     effective = Max( Max over i of InitContainerUse(i),
 *                      Sum(sidecars) + Sum(app containers) )
 *                 + pod overhead
 *
 * Two things about that are easy to get wrong:
 *
 *  - The naive "max of each init container" is the pre-sidecar formula and is
 *    wrong once sidecars exist. Init containers that finish *before* the first
 *    sidecar starts never coexist with it, so they must not be charged for it;
 *    the running sum is what expresses that.
 *  - A sidecar counts twice over: it is part of the steady-state sum AND part
 *    of the running total that later init containers are measured against.
 *
 * Pod-level `spec.resources` (beta and on by default since v1.34) *replaces*
 * the container aggregate for the resources it names — it does not add to it.
 * Overhead is added last, after the max and after any pod-level override.
 *
 * The init-containers concept page still carries the stale pre-KEP-753 text;
 * the sidecar-containers page is the current one. Do not "fix" this module
 * against the older page.
 */

import type { K8sPodSpec, K8sPodContainer } from "./types.js";
import {
  addPairs,
  maxPairs,
  parseResourceMap,
  ZERO_PAIR,
  type ResourcePair,
} from "./quantity.js";

/** A pod's effective request and limit, in cores and bytes. */
export interface EffectivePodResources {
  requests: ResourcePair;
  limits: ResourcePair;
}

function containerRequests(container: K8sPodContainer): ResourcePair {
  return parseResourceMap(container.resources?.requests);
}

function containerLimits(container: K8sPodContainer): ResourcePair {
  return parseResourceMap(container.resources?.limits);
}

/** An init container with `restartPolicy: Always` is a sidecar (KEP-753). */
function isSidecar(container: K8sPodContainer): boolean {
  return container.restartPolicy === "Always";
}

function aggregate(
  spec: K8sPodSpec,
  pick: (container: K8sPodContainer) => ResourcePair,
): ResourcePair {
  const appContainers = spec.containers ?? [];
  const initContainers = spec.initContainers ?? [];

  // Steady state: every app container, plus every sidecar (which keeps
  // running for the pod's whole life).
  let steady = ZERO_PAIR;
  for (const container of appContainers) steady = addPairs(steady, pick(container));

  // Init phase: walk the init containers in order, carrying the running sum of
  // the sidecars started so far, and take the high-water mark.
  let sidecarsSoFar = ZERO_PAIR;
  let initPeak = ZERO_PAIR;
  for (const container of initContainers) {
    const own = pick(container);
    if (isSidecar(container)) {
      sidecarsSoFar = addPairs(sidecarsSoFar, own);
      // A sidecar is also part of the steady state.
      steady = addPairs(steady, own);
      initPeak = maxPairs(initPeak, sidecarsSoFar);
    } else {
      initPeak = maxPairs(initPeak, addPairs(sidecarsSoFar, own));
    }
  }

  return maxPairs(initPeak, steady);
}

/**
 * Compute a pod spec's effective requests and limits. Works for a real Pod and
 * for the `spec.template.spec` inside a Deployment / StatefulSet / DaemonSet /
 * Job / CronJob, which carry the same shape.
 */
export function effectivePodResources(spec: K8sPodSpec): EffectivePodResources {
  let requests = aggregate(spec, containerRequests);
  let limits = aggregate(spec, containerLimits);

  // Pod-level resources override the container aggregate for the resources
  // they name (cpu, memory, hugepages-*). Assignment, not addition.
  const podLevelRequests = spec.resources?.requests;
  if (podLevelRequests) {
    const parsed = parseResourceMap(podLevelRequests);
    if (podLevelRequests["cpu"] != null) requests = { ...requests, cpuCores: parsed.cpuCores };
    if (podLevelRequests["memory"] != null) {
      requests = { ...requests, memoryBytes: parsed.memoryBytes };
    }
  }
  const podLevelLimits = spec.resources?.limits;
  if (podLevelLimits) {
    const parsed = parseResourceMap(podLevelLimits);
    if (podLevelLimits["cpu"] != null) limits = { ...limits, cpuCores: parsed.cpuCores };
    if (podLevelLimits["memory"] != null) limits = { ...limits, memoryBytes: parsed.memoryBytes };
  }

  // Overhead is charged on top of everything — it is the runtime's own cost
  // (VM-based sandboxes especially), and the scheduler reserves it.
  const overhead = parseResourceMap(spec.overhead);
  return {
    requests: addPairs(requests, overhead),
    limits: addPairs(limits, overhead),
  };
}

/**
 * The workload that owns a pod, from its `ownerReferences`. A ReplicaSet is
 * rewritten to the Deployment that made it: `web-7d9f8c` is noise, `web` is
 * the thing a human budgets for. ReplicaSet names are `<deployment>-<hash>`
 * where the hash is the pod-template hash, which is exactly what the pod's
 * `pod-template-hash` label carries — so the suffix can be stripped exactly
 * rather than guessed at.
 */
export function ownerWorkload(
  ownerReferences: Array<{ kind?: string; name?: string; controller?: boolean }> | undefined,
  labels: Record<string, string> | undefined,
  fallbackName: string,
): { workload: string; workloadKind: string } {
  const owner =
    (ownerReferences ?? []).find((ref) => ref.controller) ?? (ownerReferences ?? [])[0];
  if (!owner?.kind || !owner.name) {
    return { workload: fallbackName, workloadKind: "Pod" };
  }

  if (owner.kind === "ReplicaSet") {
    const hash = labels?.["pod-template-hash"];
    const suffix = hash ? `-${hash}` : "";
    const name =
      suffix && owner.name.endsWith(suffix) ? owner.name.slice(0, -suffix.length) : owner.name;
    return { workload: name, workloadKind: "Deployment" };
  }

  // A CronJob's Jobs are named `<cronjob>-<timestamp>`, but unlike a
  // ReplicaSet the Job is itself a first-class thing users look at, and the
  // Job's own ownerReference (which would name the CronJob) is not on the pod.
  // Report the Job; the Jobs listing already links back to its CronJob.
  return { workload: owner.name, workloadKind: owner.kind };
}
