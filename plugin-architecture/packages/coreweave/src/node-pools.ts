import type { CoreWeaveContext } from "./api.js";
import { kubeFetch, statusOf } from "./api.js";
import { NODES_PER_RACK, instanceSpec, isRackScale } from "./catalog.js";
import type { CwNodePool, RestoreState } from "./mappers.js";
import { RESTORE_ANNOTATION, readRestoreState } from "./mappers.js";

/**
 * CKS Node Pools: the `NodePool` custom resource
 * (`compute.coreweave.com/v1alpha1`, cluster-scoped) on each cluster's own
 * Kubernetes API server. The CKS REST API manages clusters only, so this is
 * the one place the plugin talks Kubernetes, using the same API token the
 * kubeconfig carries.
 *
 * Validation mirrors the Node Pool reference (docs.coreweave.com/products/cks/reference/node-pool)
 * so a bad size is refused here with a readable reason instead of being
 * accepted by the API server and then sitting in a failed condition:
 *
 * - `instanceType` is immutable;
 * - rack-scale NVL72 types (GB200, GB300, Vera Rubin) are sized in whole
 *   racks of 18 Nodes and reject `autoscaling: true`;
 * - with autoscaling, `minNodes <= targetNodes <= maxNodes`;
 * - Spot pools use `computeClass: spot`.
 */

const NODEPOOLS = "/apis/compute.coreweave.com/v1alpha1/nodepools";

export async function listNodePools(
  ctx: CoreWeaveContext,
  endpoint: string,
): Promise<CwNodePool[]> {
  const res = await kubeFetch<{ items?: CwNodePool[] }>(ctx, endpoint, NODEPOOLS);
  return res?.items ?? [];
}

export async function getNodePool(
  ctx: CoreWeaveContext,
  endpoint: string,
  name: string,
): Promise<CwNodePool> {
  return kubeFetch<CwNodePool>(ctx, endpoint, `${NODEPOOLS}/${encodeURIComponent(name)}`);
}

export async function createNodePool(
  ctx: CoreWeaveContext,
  endpoint: string,
  pool: CwNodePool,
): Promise<CwNodePool> {
  return kubeFetch<CwNodePool>(ctx, endpoint, NODEPOOLS, {
    method: "POST",
    body: JSON.stringify({
      apiVersion: "compute.coreweave.com/v1alpha1",
      kind: "NodePool",
      ...pool,
    }),
  });
}

/** JSON merge patch: `null` deletes a key. */
export async function patchNodePool(
  ctx: CoreWeaveContext,
  endpoint: string,
  name: string,
  patch: Record<string, unknown>,
): Promise<CwNodePool> {
  return kubeFetch<CwNodePool>(ctx, endpoint, `${NODEPOOLS}/${encodeURIComponent(name)}`, {
    method: "PATCH",
    contentType: "application/merge-patch+json",
    body: JSON.stringify(patch),
  });
}

export async function deleteNodePool(
  ctx: CoreWeaveContext,
  endpoint: string,
  name: string,
): Promise<void> {
  try {
    await kubeFetch<unknown>(ctx, endpoint, `${NODEPOOLS}/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (statusOf(err) === 404) return;
    throw err;
  }
}

/** Names of the Nodes a pool owns, from the `compute.coreweave.com/node-pool` label. */
export async function nodeNamesInPool(
  ctx: CoreWeaveContext,
  endpoint: string,
  pool: string,
): Promise<string[]> {
  const res = await kubeFetch<{ items?: Array<{ metadata?: { name?: string } }> }>(
    ctx,
    endpoint,
    "/api/v1/nodes",
    { query: { labelSelector: `compute.coreweave.com/node-pool=${pool}` } },
  );
  return (res?.items ?? []).map((n) => n.metadata?.name ?? "").filter(Boolean);
}

export interface PoolSize {
  instanceType: string;
  targetNodes?: number | undefined;
  autoscaling: boolean;
  minNodes?: number | undefined;
  maxNodes?: number | undefined;
  computeClass?: string | undefined;
}

/** Parse a form value as a non-negative whole number; blank is undefined. */
export function wholeNumber(label: string, raw: string | undefined): number | undefined {
  const text = (raw ?? "").trim();
  if (text === "") return undefined;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${label} must be a whole number of 0 or more.`);
  return n;
}

/** Throws a readable error for any size CKS would reject. */
export function validatePoolSize(size: PoolSize): void {
  const rack = isRackScale(size.instanceType);
  const { targetNodes, minNodes, maxNodes, autoscaling } = size;
  if (rack) {
    if (autoscaling) {
      throw new Error(
        `${size.instanceType} is a rack-scale NVL72 instance type, and CKS does not autoscale those. Turn autoscaling off and set Target Nodes.`,
      );
    }
    if (targetNodes !== undefined && targetNodes % NODES_PER_RACK !== 0) {
      throw new Error(
        `${size.instanceType} is deployed in whole racks of ${NODES_PER_RACK} Nodes, so Target Nodes must be a multiple of ${NODES_PER_RACK} (for example ${NODES_PER_RACK}, ${NODES_PER_RACK * 2} or ${NODES_PER_RACK * 3}).`,
      );
    }
  }
  if (autoscaling) {
    if (minNodes === undefined || maxNodes === undefined) {
      throw new Error("Autoscaling needs both an autoscaler minimum and maximum.");
    }
    if (minNodes > maxNodes) {
      throw new Error("The autoscaler minimum cannot be larger than the maximum.");
    }
    if (targetNodes !== undefined && (targetNodes < minNodes || targetNodes > maxNodes)) {
      throw new Error(
        `Target Nodes (${targetNodes}) must be between the autoscaler minimum (${minNodes}) and maximum (${maxNodes}).`,
      );
    }
  } else if (targetNodes === undefined) {
    throw new Error("Set Target Nodes, or turn on autoscaling with a minimum and maximum.");
  }
}

/** Spec for a new pool from validated form values. */
export function buildNodePoolSpec(
  size: PoolSize,
  gpuDriver?: string,
): NonNullable<CwNodePool["spec"]> {
  validatePoolSize(size);
  const autoscaledTarget =
    size.autoscaling && size.targetNodes === undefined ? size.minNodes : size.targetNodes;
  return {
    computeClass: size.computeClass === "spot" ? "spot" : "default",
    instanceType: size.instanceType,
    ...(autoscaledTarget !== undefined ? { targetNodes: autoscaledTarget } : {}),
    autoscaling: size.autoscaling,
    ...(size.autoscaling && size.minNodes !== undefined ? { minNodes: size.minNodes } : {}),
    ...(size.autoscaling && size.maxNodes !== undefined ? { maxNodes: size.maxNodes } : {}),
    ...(gpuDriver && instanceSpec(size.instanceType)?.family === "gpu"
      ? { gpu: { version: gpuDriver } }
      : {}),
  };
}

/** Kubernetes object names: lowercase RFC 1123 DNS subdomain. */
export function validatePoolName(name: string): string | null {
  if (!/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(name)) {
    return "Node Pool names use lowercase letters, numbers, hyphens and dots, and start and end with a letter or number.";
  }
  return null;
}

/** Merge patch that scales a pool to zero and remembers how to undo it. */
export function scaleToZeroPatch(pool: CwNodePool): Record<string, unknown> {
  const spec = pool.spec ?? {};
  const restore: RestoreState = {
    ...(typeof spec.targetNodes === "number" ? { targetNodes: spec.targetNodes } : {}),
    ...(typeof spec.targetRacks === "number" ? { targetRacks: spec.targetRacks } : {}),
    ...(spec.autoscaling ? { autoscaling: true } : {}),
    ...(typeof spec.minNodes === "number" ? { minNodes: spec.minNodes } : {}),
    ...(typeof spec.maxNodes === "number" ? { maxNodes: spec.maxNodes } : {}),
  };
  const usesRacks = typeof spec.targetRacks === "number" && spec.targetNodes === undefined;
  return {
    metadata: { annotations: { [RESTORE_ANNOTATION]: JSON.stringify(restore) } },
    spec: {
      ...(usesRacks ? { targetRacks: 0 } : { targetNodes: 0 }),
      ...(spec.autoscaling ? { autoscaling: false, minNodes: 0 } : {}),
    },
  };
}

/** Merge patch that restores the size {@link scaleToZeroPatch} remembered. */
export function restorePatch(pool: CwNodePool): Record<string, unknown> {
  const restore = readRestoreState(pool);
  if (!restore) {
    throw new Error(
      "This Node Pool was not scaled to zero from Infrawrench, so there is no size to restore. Edit it and set Target Nodes instead.",
    );
  }
  return {
    metadata: { annotations: { [RESTORE_ANNOTATION]: null } },
    spec: {
      ...(restore.targetNodes !== undefined ? { targetNodes: restore.targetNodes } : {}),
      ...(restore.targetRacks !== undefined ? { targetRacks: restore.targetRacks } : {}),
      ...(restore.autoscaling
        ? {
            autoscaling: true,
            ...(restore.minNodes !== undefined ? { minNodes: restore.minNodes } : {}),
            ...(restore.maxNodes !== undefined ? { maxNodes: restore.maxNodes } : {}),
          }
        : {}),
    },
  };
}
