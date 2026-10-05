/**
 * Node and PersistentVolumeClaim labels as cost dimensions.
 *
 * A pod's compute share is bought from a specific node, and that node has a
 * shape: an instance type, a zone, a node pool, spot or on-demand capacity,
 * and whatever labels the platform team put on it (`team=payments`). A volume
 * row has a claim with labels of its own and a storage class. None of that
 * reaches the cost warehouse unless it rides along on the row, so this module
 * turns those labels into **tags**, which every cost surface (group-by,
 * filters, saved filters, budgets, allocation rules, the query language, the
 * CLI and MCP) already understands. No new dimension, no new code path.
 *
 * Three kinds of tag come out of here:
 *
 *  - **Normalised node attributes**, always: `instance_type`, `zone`,
 *    `node_pool` and `capacity_type`. Every provider spells "node pool" and
 *    "spot" differently (`eks.amazonaws.com/nodegroup`,
 *    `cloud.google.com/gke-nodepool`, `kubernetes.azure.com/agentpool`, …);
 *    the user should not have to know which, so the plugin reads them all and
 *    writes one name. `capacity_type` is `spot`, `on-demand` or `reserved`.
 *  - **Raw node labels** under `k8s_node_label:<key>`, for the keys the
 *    account's allowlist names.
 *  - **Raw PVC labels** under `k8s_pvc_label:<key>`, likewise, plus
 *    `storage_class` on every volume row.
 *
 * WHY AN ALLOWLIST. Node labels split rows: a workload whose pods run on spot
 * and on-demand nodes becomes two rows, one per distinct node-label tuple. A
 * per-node label (`kubernetes.io/hostname`) would make that one row per node
 * per workload per day, forever, for a dimension nobody groups by. So the keys
 * are capped ({@link MAX_LABEL_KEYS}), per-node identifiers are refused
 * outright, and the default is a short list of well-known keys plus a few
 * conventional ownership keys that only cost anything on clusters that use
 * them. PVC labels do not split rows (every claim is already its own row) but
 * every key is a column in the tags map, so they share the cap.
 *
 * Pure: label maps in, tag maps out.
 */

import type { CredentialFieldOption } from "@infrawrench/plugin-base";

/** Tag-key prefix for raw node labels. Changing it re-keys history: don't. */
export const NODE_LABEL_TAG_PREFIX = "k8s_node_label:";
/** Tag-key prefix for raw PVC labels. Changing it re-keys history: don't. */
export const PVC_LABEL_TAG_PREFIX = "k8s_pvc_label:";

/** Most label keys emitted per kind, whatever the setting says. */
export const MAX_LABEL_KEYS = 20;

/**
 * Node labels emitted when the account has not chosen. The topology and
 * architecture keys are set by the kubelet and cloud controllers on every
 * conformant cluster; the ownership keys are conventions that cost nothing on
 * a cluster that does not use them, because an absent label emits no tag.
 */
export const DEFAULT_NODE_LABEL_KEYS: readonly string[] = [
  "node.kubernetes.io/instance-type",
  "topology.kubernetes.io/zone",
  "topology.kubernetes.io/region",
  "kubernetes.io/arch",
  "kubernetes.io/os",
  "team",
  "owner",
  "environment",
  "cost-center",
];

/** PVC labels emitted when the account has not chosen. */
export const DEFAULT_PVC_LABEL_KEYS: readonly string[] = [
  "app.kubernetes.io/name",
  "app.kubernetes.io/instance",
  "app.kubernetes.io/component",
  "app.kubernetes.io/part-of",
  "team",
  "owner",
  "environment",
  "cost-center",
];

/**
 * Node labels that identify one node (or one instance) rather than a class
 * of them. Never emitted: each would turn every workload row into one row per
 * node, and the per-node view already exists on the cluster's own surfaces.
 */
const PER_NODE_LABEL_KEYS = new Set([
  "kubernetes.io/hostname",
  "doks.digitalocean.com/node-id",
  "k8s.scaleway.com/node-id",
  "node.kubernetes.io/instance-id",
  "alpha.eksctl.io/instance-id",
  "kubernetes.azure.com/node-image-version",
  "cloud.google.com/gke-boot-disk",
  "csi.volume.kubernetes.io/nodeid",
]);

/** True for a label key that names a single node and so is never a dimension. */
export function isPerNodeLabelKey(key: string): boolean {
  return PER_NODE_LABEL_KEYS.has(key) || /(^|[/.-])(node|instance|machine)-?id$/i.test(key);
}

/**
 * Parse an account's label-key setting.
 *
 * Blank means "the defaults"; `none` means "no raw labels" (the normalised
 * node attributes and `storage_class` are still written, they are bounded by
 * construction). Otherwise a comma- or newline-separated list of keys,
 * deduplicated, per-node identifiers dropped, capped at {@link MAX_LABEL_KEYS}.
 */
export function parseLabelKeySetting(
  raw: string | undefined,
  defaults: readonly string[],
  kind: "node" | "pvc",
): string[] {
  const text = raw?.trim() ?? "";
  if (!text) return [...defaults];
  if (text.toLowerCase() === "none") return [];
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const key = part.trim();
    // `none` beside real keys is a picker leftover, not a key.
    if (!key || seen.has(key) || key.toLowerCase() === "none") continue;
    if (kind === "node" && isPerNodeLabelKey(key)) continue;
    seen.add(key);
    if (seen.size >= MAX_LABEL_KEYS) break;
  }
  return [...seen];
}

/** What a node is, normalised across providers. Empty string when unknown. */
export interface NodeAttributes {
  instanceType: string;
  zone: string;
  region: string;
  nodePool: string;
  capacityType: "" | "spot" | "on-demand" | "reserved";
}

/**
 * Node-pool label keys, most specific first. Karpenter wins over the managed
 * node group label because a Karpenter-launched node on EKS is in a Karpenter
 * NodePool, not in a managed node group.
 */
const NODE_POOL_KEYS = [
  "karpenter.sh/nodepool",
  "eks.amazonaws.com/nodegroup",
  "alpha.eksctl.io/nodegroup-name",
  "cloud.google.com/gke-nodepool",
  "kubernetes.azure.com/agentpool",
  "agentpool",
  "doks.digitalocean.com/node-pool",
  "k8s.scaleway.com/pool-name",
  "lke.linode.com/pool-id",
  "nodepool",
];

function first(labels: Record<string, string>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = labels[key];
    if (value) return value;
  }
  return "";
}

/**
 * Spot, on-demand or reserved, from whichever provider label is present.
 *
 * Absence is only read as on-demand where the provider marks spot and leaves
 * on-demand unlabelled *and* the node is recognisably that provider's (a GKE
 * node pool with no spot label is on-demand; a node with no provider labels at
 * all is unknown, not on-demand).
 */
function capacityTypeOf(labels: Record<string, string>): NodeAttributes["capacityType"] {
  const karpenter = labels["karpenter.sh/capacity-type"]?.toLowerCase();
  if (karpenter === "spot" || karpenter === "on-demand" || karpenter === "reserved") {
    return karpenter;
  }
  const eks = labels["eks.amazonaws.com/capacityType"]?.toUpperCase();
  if (eks === "SPOT") return "spot";
  if (eks === "ON_DEMAND") return "on-demand";
  if (
    labels["cloud.google.com/gke-spot"] === "true" ||
    labels["cloud.google.com/gke-preemptible"] === "true" ||
    labels["cloud.google.com/gke-provisioning"]?.toLowerCase() === "spot"
  ) {
    return "spot";
  }
  const azure = labels["kubernetes.azure.com/scalesetpriority"]?.toLowerCase();
  if (azure === "spot") return "spot";
  if (azure === "regular") return "on-demand";
  if (
    labels["cloud.google.com/gke-nodepool"] ||
    labels["kubernetes.azure.com/agentpool"] ||
    labels["eks.amazonaws.com/nodegroup"]
  ) {
    return "on-demand";
  }
  return "";
}

export function nodeAttributes(labels: Record<string, string>): NodeAttributes {
  return {
    instanceType: first(labels, [
      "node.kubernetes.io/instance-type",
      "beta.kubernetes.io/instance-type",
    ]),
    zone: first(labels, ["topology.kubernetes.io/zone", "failure-domain.beta.kubernetes.io/zone"]),
    region: first(labels, [
      "topology.kubernetes.io/region",
      "failure-domain.beta.kubernetes.io/region",
    ]),
    nodePool: first(labels, NODE_POOL_KEYS),
    capacityType: capacityTypeOf(labels),
  };
}

function putIf(tags: Record<string, string>, key: string, value: string | undefined): void {
  if (value) tags[key] = value;
}

/**
 * The tags a node contributes to every row derived from it: a pod's compute
 * share, the node's idle and system-reserved slices. Absent labels emit no
 * tag, so an empty value never masquerades as a real group.
 */
export function nodeCostTags(
  labels: Record<string, string>,
  keys: readonly string[],
): Record<string, string> {
  const attrs = nodeAttributes(labels);
  const tags: Record<string, string> = {};
  putIf(tags, "instance_type", attrs.instanceType);
  putIf(tags, "zone", attrs.zone);
  putIf(tags, "node_pool", attrs.nodePool);
  putIf(tags, "capacity_type", attrs.capacityType);
  for (const key of keys) putIf(tags, `${NODE_LABEL_TAG_PREFIX}${key}`, labels[key]);
  return tags;
}

/** The tags a claim contributes to its own storage row. */
export function pvcCostTags(
  labels: Record<string, string>,
  storageClass: string,
  keys: readonly string[],
): Record<string, string> {
  const tags: Record<string, string> = {};
  putIf(tags, "storage_class", storageClass);
  for (const key of keys) putIf(tags, `${PVC_LABEL_TAG_PREFIX}${key}`, labels[key]);
  return tags;
}

/**
 * Label keys found on a set of objects, as picker options.
 *
 * Ordered by how many objects carry the key, so the keys worth grouping by
 * come first, with up to three sample values in the description. Node keys
 * that identify a single node are left out: the setting would drop them
 * anyway, and offering them invites a choice that cannot work.
 */
export function discoverLabelKeys(
  items: Array<{ metadata: { labels?: Record<string, string> } }>,
  kind: "node" | "pvc",
): CredentialFieldOption[] {
  const counts = new Map<string, { count: number; values: Set<string> }>();
  for (const item of items) {
    for (const [key, value] of Object.entries(item.metadata.labels ?? {})) {
      if (kind === "node" && isPerNodeLabelKey(key)) continue;
      const entry = counts.get(key) ?? { count: 0, values: new Set<string>() };
      entry.count += 1;
      if (value) entry.values.add(value);
      counts.set(key, entry);
    }
  }
  const noun = kind === "node" ? "node" : "claim";
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([key, { count, values }]) => {
      const sample = [...values].sort().slice(0, 3);
      const distinct = values.size;
      return {
        id: key,
        label: key,
        description:
          `${count} of ${items.length} ${noun}${items.length === 1 ? "" : "s"} · ` +
          `${distinct} value${distinct === 1 ? "" : "s"}` +
          (sample.length > 0
            ? ` (${sample.join(", ")}${distinct > sample.length ? ", …" : ""})`
            : ""),
      };
    });
}
