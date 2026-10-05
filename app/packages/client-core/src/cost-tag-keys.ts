/**
 * Tag keys with a meaning beyond "a tag".
 *
 * The Kubernetes plugin writes node and PersistentVolumeClaim labels onto its
 * cost rows as ordinary tags under two reserved prefixes, plus a handful of
 * normalised node attributes (`node_pool`, `capacity_type`, …). Everything
 * downstream treats them as tags, which is the point: group-by, filters,
 * saved filters, budgets and allocation rules work on them unchanged. This
 * module is the one place that knows the prefixes, so pickers can label and
 * group the keys, the query language can offer `k8s_node_label['team']` as a
 * spelling of `tag['k8s_node_label:team']`, and the CLI can accept
 * `--group-by k8s_node_label:team`.
 *
 * Pure and dependency-free, like the rest of client-core.
 */

/** Tag-key prefix the Kubernetes plugin uses for node labels. */
export const K8S_NODE_LABEL_TAG_PREFIX = "k8s_node_label:";
/** Tag-key prefix the Kubernetes plugin uses for PersistentVolumeClaim labels. */
export const K8S_PVC_LABEL_TAG_PREFIX = "k8s_pvc_label:";

/**
 * Query-language names that are shorthand for a prefixed tag:
 * `k8s_node_label['team']` is `tag['k8s_node_label:team']`.
 */
export const COST_TAG_ALIASES = {
  k8s_node_label: K8S_NODE_LABEL_TAG_PREFIX,
  k8s_pvc_label: K8S_PVC_LABEL_TAG_PREFIX,
} as const;

export type CostTagAlias = keyof typeof COST_TAG_ALIASES;

/** The normalised node attributes the Kubernetes plugin always writes. */
export const K8S_NODE_ATTRIBUTE_TAG_KEYS = [
  "node_pool",
  "capacity_type",
  "instance_type",
  "zone",
] as const;

/** Tag keys the Kubernetes plugin writes that are neither labels nor node attributes. */
const K8S_OTHER_TAG_KEYS = new Set(["namespace", "workload", "workload_kind", "storage_class"]);

export type CostTagKeyGroup = "tag" | "k8s" | "k8s_node_label" | "k8s_pvc_label";

export interface CostTagKeyDescription {
  key: string;
  group: CostTagKeyGroup;
  /** The part worth showing: the label key without its prefix, or the tag key. */
  name: string;
}

/** The alias a tag key can be written with in the query language, if any. */
export function costTagAliasFor(tagKey: string): { alias: CostTagAlias; name: string } | null {
  for (const [alias, prefix] of Object.entries(COST_TAG_ALIASES) as Array<[CostTagAlias, string]>) {
    if (tagKey.startsWith(prefix) && tagKey.length > prefix.length) {
      return { alias, name: tagKey.slice(prefix.length) };
    }
  }
  return null;
}

export function describeCostTagKey(key: string): CostTagKeyDescription {
  const alias = costTagAliasFor(key);
  if (alias) return { key, group: alias.alias, name: alias.name };
  if (
    (K8S_NODE_ATTRIBUTE_TAG_KEYS as readonly string[]).includes(key) ||
    K8S_OTHER_TAG_KEYS.has(key)
  ) {
    return { key, group: "k8s", name: key };
  }
  return { key, group: "tag", name: key };
}

/**
 * Split a list of tag keys into display groups, each sorted by name, in a
 * fixed order (plain tags first). Empty groups are omitted.
 */
export function groupCostTagKeys(
  keys: readonly string[],
): Array<{ group: CostTagKeyGroup; keys: CostTagKeyDescription[] }> {
  const order: CostTagKeyGroup[] = ["tag", "k8s", "k8s_node_label", "k8s_pvc_label"];
  const buckets = new Map<CostTagKeyGroup, CostTagKeyDescription[]>();
  for (const key of keys) {
    const d = describeCostTagKey(key);
    const list = buckets.get(d.group) ?? [];
    list.push(d);
    buckets.set(d.group, list);
  }
  return order
    .filter((g) => buckets.has(g))
    .map((group) => ({
      group,
      keys: buckets.get(group)!.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/**
 * Resolve a `<kind>:<key>` group-by spec to a tag key: `tag:env` → `env`,
 * `k8s_node_label:team` → `k8s_node_label:team`. Returns null when the spec
 * is not tag-shaped, so callers can fall back to the fixed dimensions.
 */
export function tagKeyFromGroupBySpec(spec: string): string | null {
  const colon = spec.indexOf(":");
  if (colon <= 0) return null;
  const kind = spec.slice(0, colon).toLowerCase();
  const rest = spec.slice(colon + 1);
  if (!rest) return null;
  if (kind === "tag") return rest;
  if (kind in COST_TAG_ALIASES) return `${COST_TAG_ALIASES[kind as CostTagAlias]}${rest}`;
  return null;
}
