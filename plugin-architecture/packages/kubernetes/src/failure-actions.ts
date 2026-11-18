/**
 * Game-day failure actions for workloads: scale a Deployment or StatefulSet
 * to zero replicas, and back to the count it had.
 *
 * Both go through the `scale` subresource (`GET`/`PATCH
 * .../deployments/{name}/scale`, an `autoscaling/v1` Scale), which touches
 * `spec.replicas` and nothing else, so the undo restores exactly what was
 * there. The count is read by `prepare` before anything changes and handed
 * back to `undo` by the host.
 */
import type {
  FailureActionDeclaration,
  FailureUndoState,
  PreparedFailure,
} from "@infrawrench/plugin-base";
import { buildResourcePath, type K8sFetch } from "./shared.js";

export const SCALE_TO_ZERO: FailureActionDeclaration = {
  id: "scale-to-zero",
  label: "Scale to zero replicas",
  undoLabel: "Scale back to the previous replica count",
  description: "Every pod of the workload is terminated; the Service has no endpoints.",
};

const SCALABLE_TYPES = new Set(["k8s-deployment", "k8s-statefulset"]);

interface K8sScale {
  spec?: { replicas?: number };
}

function scalePath(typeId: string, resourceId: string, actionId: string): string {
  if (!SCALABLE_TYPES.has(typeId) || actionId !== SCALE_TO_ZERO.id) {
    throw new Error(`Kubernetes plugin: no failure action "${actionId}" for type "${typeId}"`);
  }
  return `${buildResourcePath(resourceId)}/scale`;
}

async function patchReplicas(fetch: K8sFetch, path: string, replicas: number): Promise<void> {
  await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json" },
    body: JSON.stringify({ spec: { replicas } }),
  });
}

export async function prepareK8sFailure(
  fetch: K8sFetch,
  typeId: string,
  resourceId: string,
  actionId: string,
): Promise<PreparedFailure> {
  const scale = await fetch<K8sScale>(scalePath(typeId, resourceId, actionId));
  const replicas = scale.spec?.replicas ?? 0;
  return {
    undo: { replicas },
    alreadyInEffect: replicas === 0,
    currentState: `${replicas} ${replicas === 1 ? "replica" : "replicas"}`,
  };
}

export async function injectK8sFailure(
  fetch: K8sFetch,
  typeId: string,
  resourceId: string,
  actionId: string,
): Promise<void> {
  await patchReplicas(fetch, scalePath(typeId, resourceId, actionId), 0);
}

export async function undoK8sFailure(
  fetch: K8sFetch,
  typeId: string,
  resourceId: string,
  actionId: string,
  undo: FailureUndoState,
): Promise<void> {
  const path = scalePath(typeId, resourceId, actionId);
  const replicas = undo["replicas"];
  if (typeof replicas !== "number" || !Number.isInteger(replicas) || replicas < 0) {
    throw new Error("Kubernetes plugin: the stored replica count to restore is missing");
  }
  await patchReplicas(fetch, path, replicas);
}
