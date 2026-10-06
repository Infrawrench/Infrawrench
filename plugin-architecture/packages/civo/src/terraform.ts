import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for provider `civo/civo` (docs/resources in
 * `civo/terraform-provider-civo`, 2026-09): civo_instance (`size`,
 * `disk_image`, `region`, `network_id`, `firewall_id`), civo_volume,
 * civo_kubernetes_cluster (one `pools` block), civo_kubernetes_node_pool
 * (import `cluster:pool`), civo_database, civo_firewall, civo_network,
 * civo_reserved_ip, civo_dns_domain_name, civo_dns_domain_record (import
 * `domain:record`), civo_object_store, civo_object_store_credential,
 * civo_ssh_key. The token comes from `CIVO_TOKEN` or a credentials file; the
 * provider deprecates `token` in HCL, so nothing is put in the block.
 */

const uuid = (r: ResourceInstance) =>
  (r.externalId ?? "").split("/").slice(1).join("/") || (r.externalId ?? "");
const region = (r: ResourceInstance) => (r.externalId ?? "").split("/")[0] ?? "";

function block(
  type: string,
  r: ResourceInstance,
  attributes: Record<string, TerraformValue>,
  importId: string,
  comments?: string[],
): TerraformExportResult {
  return {
    resource: {
      type,
      name: r.displayName || r.externalId || type,
      attributes,
      importId,
      ...(comments?.length ? { comments } : {}),
    },
  };
}

const withRegion = (r: ResourceInstance, attrs: Record<string, TerraformValue>) => {
  const reg = region(r);
  if (reg) attrs["region"] = tf.str(reg);
  return attrs;
};

export const civoTerraformExport: TerraformExportCapability = {
  provider: { name: "civo", source: "civo/civo", version: "~> 1.1" },
  providerConfig: {},
  variables: [],
  supportedResourceTypeIds: [
    "instance",
    "volume",
    "kubernetes-cluster",
    "node-pool",
    "database",
    "firewall",
    "network",
    "reserved-ip",
    "domain",
    "dns-record",
    "object-store",
    "object-store-credential",
    "ssh-key",
  ],
  mapResource(r): TerraformExportResult | null {
    switch (r.resourceTypeId) {
      case "instance": {
        const size = fieldString(r, "size");
        if (!size) return null;
        const attrs: Record<string, TerraformValue> = {
          hostname: tf.str(fieldString(r, "hostname") || r.displayName),
          size: tf.str(size),
        };
        const fw = fieldString(r, "firewallId");
        if (fw) attrs["firewall_id"] = tf.str(fw);
        const net = fieldString(r, "networkId");
        if (net) attrs["network_id"] = tf.str(net);
        const notes = fieldString(r, "notes");
        if (notes) attrs["notes"] = tf.str(notes);
        return block("civo_instance", r, withRegion(r, attrs), uuid(r), [
          "Set disk_image to the image id the instance was built from; changing it rebuilds the instance.",
        ]);
      }
      case "volume": {
        const size = fieldNumber(r, "sizeGb");
        if (size === undefined) return null;
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(fieldString(r, "name") || r.displayName),
          size_gb: tf.num(size),
        };
        const net = fieldString(r, "networkId");
        if (net) attrs["network_id"] = tf.str(net);
        return block("civo_volume", r, withRegion(r, attrs), uuid(r));
      }
      case "kubernetes-cluster": {
        const size = fieldString(r, "nodeSize");
        if (!size) return null;
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(fieldString(r, "name") || r.displayName),
          pools: tf.block({
            size: tf.str(size),
            node_count: tf.num(fieldNumber(r, "nodeCount") ?? 1),
          }),
        };
        const fw = fieldString(r, "firewallId");
        if (fw) attrs["firewall_id"] = tf.str(fw);
        const type = fieldString(r, "clusterType");
        if (type) attrs["cluster_type"] = tf.str(type);
        const version = fieldString(r, "version");
        if (version) attrs["kubernetes_version"] = tf.str(version);
        return block("civo_kubernetes_cluster", r, withRegion(r, attrs), uuid(r), [
          "pools describes the first pool only; add civo_kubernetes_node_pool resources for the others.",
        ]);
      }
      case "node-pool": {
        const [, clusterId, poolId] = (r.externalId ?? "").split("/");
        if (!clusterId || !poolId) return null;
        return block(
          "civo_kubernetes_node_pool",
          r,
          withRegion(r, {
            cluster_id: tf.str(clusterId),
            size: tf.str(fieldString(r, "size")),
            node_count: tf.num(fieldNumber(r, "count") ?? 1),
          }),
          `${clusterId}:${poolId}`,
        );
      }
      case "database": {
        const engine = fieldString(r, "engine");
        const size = fieldString(r, "size");
        if (!engine || !size) return null;
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(fieldString(r, "name") || r.displayName),
          engine: tf.str(engine),
          version: tf.str(fieldString(r, "version")),
          size: tf.str(size),
          nodes: tf.num(fieldNumber(r, "nodes") ?? 1),
        };
        const fw = fieldString(r, "firewallId");
        if (fw) attrs["firewall_id"] = tf.str(fw);
        const net = fieldString(r, "networkId");
        if (net) attrs["network_id"] = tf.str(net);
        return block("civo_database", r, withRegion(r, attrs), uuid(r));
      }
      case "firewall": {
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(fieldString(r, "name") || r.displayName),
          create_default_rules: tf.bool(false),
        };
        const net = fieldString(r, "networkId");
        if (net) attrs["network_id"] = tf.str(net);
        return block("civo_firewall", r, withRegion(r, attrs), uuid(r), [
          "Add ingress_rule / egress_rule blocks for the rules; they are not part of the synced inventory.",
        ]);
      }
      case "network":
        return block(
          "civo_network",
          r,
          withRegion(r, { label: tf.str(fieldString(r, "label") || r.displayName) }),
          uuid(r),
        );
      case "reserved-ip":
        return block(
          "civo_reserved_ip",
          r,
          withRegion(r, { name: tf.str(fieldString(r, "name") || r.displayName) }),
          uuid(r),
        );
      case "domain":
        return block(
          "civo_dns_domain_name",
          r,
          { name: tf.str(fieldString(r, "name") || r.displayName) },
          fieldString(r, "name") || r.displayName,
        );
      case "dns-record": {
        const [domainId, recordId] = (r.externalId ?? "").split("/");
        if (!domainId || !recordId) return null;
        const attrs: Record<string, TerraformValue> = {
          domain_id: tf.str(domainId),
          type: tf.str(fieldString(r, "type")),
          name: tf.str(fieldString(r, "name") || "@"),
          value: tf.str(fieldString(r, "value")),
          ttl: tf.num(fieldNumber(r, "ttl") || 600),
        };
        if (["MX", "SRV"].includes(fieldString(r, "type")))
          attrs["priority"] = tf.num(fieldNumber(r, "priority") ?? 10);
        return block("civo_dns_domain_record", r, attrs, `${domainId}:${recordId}`);
      }
      case "object-store":
        return block(
          "civo_object_store",
          r,
          withRegion(r, {
            name: tf.str(fieldString(r, "name") || r.displayName),
            max_size_gb: tf.num(fieldNumber(r, "maxSizeGb") ?? 500),
          }),
          uuid(r),
        );
      case "object-store-credential":
        return block(
          "civo_object_store_credential",
          r,
          withRegion(r, { name: tf.str(fieldString(r, "name") || r.displayName) }),
          uuid(r),
        );
      case "ssh-key": {
        const key = fieldString(r, "publicKey");
        if (!key) return null;
        return block(
          "civo_ssh_key",
          r,
          { name: tf.str(fieldString(r, "name") || r.displayName), public_key: tf.str(key) },
          r.externalId ?? "",
        );
      }
      default:
        return null;
    }
  },
};
