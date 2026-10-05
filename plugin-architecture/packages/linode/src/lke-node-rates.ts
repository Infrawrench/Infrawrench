/**
 * The `nodeHourlyRates` payload an LKE cluster hands its Kubernetes peer.
 *
 * Shape is the JSON `kubernetes/src/node-rates.ts` parses: a bare
 * `{plan: hourly}` map starts with `{`, so it is read as that JSON form, finds
 * no `byInstanceType`, and prices nothing. LKE's cloud controller labels each
 * node `node.kubernetes.io/instance-type` with its Linode plan id
 * (`g6-standard-2`), so the pool plans are the instance-type keys.
 *
 * Beyond the nodes, everything else an LKE cluster is billed for has one
 * catalog price: the control plane (`lke-sa` is free, `lke-ha` and `lke-e`
 * are flat per-cluster fees), a `LoadBalancer` Service (a NodeBalancer), and
 * a PersistentVolume (Block Storage, the same per-GB price whichever of the
 * `linode-block-storage` classes provisioned it).
 */

import {
  type PriceCatalog,
  type ResolvedPrice,
  HOURS_PER_MONTH,
  findLinodeType,
  regionalPrice,
  simpleType,
} from "./pricing.js";
import type { LinodeLkeCluster, LinodeLkePool } from "./types.js";

/** Hourly figure, falling back to the monthly cap over 730 hours. */
function hourlyOf(p: ResolvedPrice): number | null {
  if (p.hourly != null) return p.hourly;
  if (p.monthly != null) return p.monthly / HOURS_PER_MONTH;
  return null;
}

/** The `/lke/types` id that prices this cluster's control plane. */
function controlPlaneType(cluster: LinodeLkeCluster): string {
  if (cluster.tier === "enterprise") return "lke-e";
  return cluster.control_plane?.high_availability ? "lke-ha" : "lke-sa";
}

/** The JSON payload, or `""` when no pool's plan has a price. */
export function buildLkeNodeRates(
  cluster: LinodeLkeCluster,
  pools: LinodeLkePool[],
  catalog: PriceCatalog,
): string {
  const region = cluster.region;
  const byInstanceType: Record<string, number> = {};
  for (const p of pools) {
    const hourly = regionalPrice(findLinodeType(catalog, p.type), region).hourly;
    if (p.type && hourly != null) byInstanceType[p.type] = hourly;
  }
  if (Object.keys(byInstanceType).length === 0) return "";

  // `lke-sa` is listed at $0, which is a real price: a standard control plane
  // genuinely costs nothing and should read as such, not as unknown.
  const controlPlaneHourly = hourlyOf(
    regionalPrice(simpleType(catalog.lkeTypes, controlPlaneType(cluster)), region),
  );
  const loadBalancerHourly = hourlyOf(
    regionalPrice(simpleType(catalog.nodeBalancerTypes, "nodebalancer"), region),
  );
  const volumeGiBMonth = regionalPrice(simpleType(catalog.volumeTypes, "volume"), region).monthly;

  return JSON.stringify({
    currency: "USD",
    source: "billed",
    byInstanceType,
    byNodeName: {},
    ...(controlPlaneHourly != null ? { controlPlaneHourly } : {}),
    ...(loadBalancerHourly != null ? { loadBalancerHourly } : {}),
    ...(volumeGiBMonth != null ? { storageGiBMonth: { "*": volumeGiBMonth } } : {}),
  });
}
