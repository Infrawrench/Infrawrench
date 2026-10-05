/**
 * What a GKE cluster's nodes cost per hour, for the Kubernetes peer.
 *
 * Priced per **node pool**, not per machine type: an `n1-standard-8` pool with
 * four T4s attached and one with none share a machine type and differ in price
 * by the GPUs, so the rate is keyed by the `cloud.google.com/gke-nodepool`
 * label every GKE node carries. A pool's hourly price is its machine type's
 * cores and RAM at the family's on-demand Compute Engine rates, plus each
 * attached GPU at its own on-demand SKU price. The per-GPU prices are passed
 * along too (`gpuHourly`), which lets the Kubernetes plugin split a GPU node
 * into its GPU and CPU/memory shares from real prices rather than a reference
 * ratio.
 *
 * Deliberately left unpriced, so the peer shows capacity without money rather
 * than a wrong number:
 *
 *  - **Autopilot clusters.** Autopilot bills per pod request, not per node.
 *  - **Spot and preemptible pools.** On-demand rates would overstate them
 *    several times over.
 *  - **Any pool whose GPU has no price** in the catalog. The machine price alone
 *    would understate a GPU node by most of its cost.
 */

import { gpuSkuKey, type PricingRates } from "./pricing.js";

export interface GkeAccelerator {
  acceleratorCount?: string | number;
  acceleratorType?: string;
}

export interface GkeNodePool {
  name?: string;
  locations?: string[];
  config?: {
    machineType?: string;
    spot?: boolean;
    preemptible?: boolean;
    accelerators?: GkeAccelerator[];
  };
}

export interface GkeCluster {
  location?: string;
  autopilot?: { enabled?: boolean };
  nodePools?: GkeNodePool[];
}

export interface MachineSpec {
  guestCpus: number;
  memoryMb: number;
  /** Accelerator-optimized types (A2, A3, G2) come with their GPUs built in. */
  accelerators?: Array<{ guestAcceleratorType?: string; guestAcceleratorCount?: number }>;
}

/** The label GKE puts on every node naming its pool. */
export const GKE_NODEPOOL_LABEL = "cloud.google.com/gke-nodepool";

function familyOf(machineType: string): string {
  const lowered = machineType.toLowerCase();
  if (lowered.startsWith("n2d-")) return "n2d";
  return lowered.split("-")[0] ?? "";
}

/** The zone to look a pool's machine type up in. */
export function poolZone(cluster: GkeCluster, pool: GkeNodePool): string | null {
  const first = pool.locations?.[0];
  if (first) return first;
  // A zonal cluster's location is itself a zone (`us-central1-a`).
  const location = cluster.location ?? "";
  return /-[a-z]$/.test(location) ? location : null;
}

/**
 * Build the `nodeHourlyRates` payload from a cluster, its machine specs and the
 * geo's pricing rates. Returns `""` when nothing could be priced.
 */
export function buildGkeNodeRates(
  cluster: GkeCluster,
  specs: Map<string, MachineSpec>,
  rates: PricingRates,
): string {
  if (cluster.autopilot?.enabled) return "";
  const byPool: Record<string, number> = {};
  const gpuHourly: Record<string, number> = {};
  const gpuRates = rates.gpuHourlyUsd ?? {};

  for (const pool of cluster.nodePools ?? []) {
    const name = pool.name;
    const machineType = pool.config?.machineType;
    if (!name || !machineType) continue;
    if (pool.config?.spot || pool.config?.preemptible) continue;
    const spec = specs.get(machineType);
    const family = rates.machineRates[familyOf(machineType)];
    if (!spec || !family) continue;

    let hourly =
      spec.guestCpus * family.corePerHourUsd + (spec.memoryMb / 1024) * family.ramPerGiBHourUsd;

    const attached =
      pool.config?.accelerators && pool.config.accelerators.length > 0
        ? pool.config.accelerators.map((a) => ({
            type: a.acceleratorType ?? "",
            count: Number(a.acceleratorCount ?? 0),
          }))
        : (spec.accelerators ?? []).map((a) => ({
            type: a.guestAcceleratorType ?? "",
            count: Number(a.guestAcceleratorCount ?? 0),
          }));
    let unpricedGpu = false;
    for (const accel of attached) {
      if (!accel.type || !(accel.count > 0)) continue;
      const price = gpuRates[gpuSkuKey(accel.type)];
      if (price == null) {
        unpricedGpu = true;
        continue;
      }
      hourly += price * accel.count;
      gpuHourly[accel.type] = price;
    }
    if (unpricedGpu || !(hourly > 0)) continue;
    byPool[name] = hourly;
  }

  if (Object.keys(byPool).length === 0) return "";
  return JSON.stringify({
    currency: "USD",
    source: "list-price",
    byInstanceType: {},
    byNodeName: {},
    byNodeLabel: { [GKE_NODEPOOL_LABEL]: byPool },
    ...(Object.keys(gpuHourly).length > 0 ? { gpuHourly } : {}),
  });
}
