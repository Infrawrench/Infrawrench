import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for provider `linode/linode`. Argument names checked
 * against the provider's docs/resources/*.md (main branch, 2026-10):
 * linode_instance, linode_volume, linode_nodebalancer, linode_lke_cluster
 * (`pool { type count }`, `control_plane { high_availability }`),
 * linode_object_storage_bucket, linode_firewall, linode_domain,
 * linode_domain_record (`record_type`), linode_vpc, linode_stackscript,
 * linode_database_postgresql_v2 / _mysql_v2 (`engine_id` is
 * `engine/major`), linode_reserved_ip. The token is `var.linode_token`.
 */

const tags = (r: ResourceInstance): TerraformValue | null => {
  const list = fieldString(r, "tags")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return list.length ? tf.list(list.map(tf.str)) : null;
};

function withTags(
  r: ResourceInstance,
  attrs: Record<string, TerraformValue>,
): Record<string, TerraformValue> {
  const t = tags(r);
  if (t) attrs["tags"] = t;
  return attrs;
}

function block(
  type: string,
  r: ResourceInstance,
  attributes: Record<string, TerraformValue>,
  comments?: string[],
  importId = r.externalId,
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

export const linodeTerraformExport: TerraformExportCapability = {
  provider: { name: "linode", source: "linode/linode", version: "~> 3.0" },
  providerConfig: { token: tf.ref("var.linode_token") },
  variables: [
    { name: "linode_token", description: "Linode personal access token", sensitive: true },
  ],
  supportedResourceTypeIds: [
    "linode",
    "volume",
    "nodebalancer",
    "lke-cluster",
    "bucket",
    "firewall",
    "domain",
    "domain-record",
    "vpc",
    "stackscript",
    "database",
    "reserved-ip",
  ],
  mapResource(r): TerraformExportResult | null {
    switch (r.resourceTypeId) {
      case "linode": {
        const region = fieldString(r, "region");
        const type = fieldString(r, "type");
        if (!region || !type) return null;
        const attrs: Record<string, TerraformValue> = {
          label: tf.str(fieldString(r, "label") || r.displayName),
          region: tf.str(region),
          type: tf.str(type),
        };
        const image = fieldString(r, "image");
        if (image) attrs["image"] = tf.str(image);
        if (r.fields["backupsEnabled"] === true) attrs["backups_enabled"] = tf.bool(true);
        return block("linode_instance", r, withTags(r, attrs), [
          "`image` is the image the Linode was deployed from; changing it in Terraform rebuilds the Linode.",
          "root_pass and authorized_keys are not exported: set them before applying a rebuild.",
        ]);
      }
      case "volume": {
        const region = fieldString(r, "region");
        const size = fieldNumber(r, "sizeGb");
        if (!region || size === undefined) return null;
        const attrs: Record<string, TerraformValue> = {
          label: tf.str(fieldString(r, "label") || r.displayName),
          region: tf.str(region),
          size: tf.num(size),
        };
        const linodeId = fieldString(r, "linodeId");
        if (linodeId) attrs["linode_id"] = tf.num(Number(linodeId));
        return block("linode_volume", r, withTags(r, attrs));
      }
      case "nodebalancer": {
        const region = fieldString(r, "region");
        if (!region) return null;
        return block(
          "linode_nodebalancer",
          r,
          withTags(r, {
            label: tf.str(fieldString(r, "label") || r.displayName),
            region: tf.str(region),
            client_conn_throttle: tf.num(fieldNumber(r, "clientConnThrottle") ?? 0),
          }),
          ["Ports and backends are separate linode_nodebalancer_config / _node resources."],
        );
      }
      case "lke-cluster": {
        const region = fieldString(r, "region");
        const version = fieldString(r, "k8sVersion");
        const nodeType = fieldString(r, "nodeType");
        if (!region || !version || !nodeType) return null;
        return block(
          "linode_lke_cluster",
          r,
          withTags(r, {
            label: tf.str(fieldString(r, "label") || r.displayName),
            region: tf.str(region),
            k8s_version: tf.str(version),
            pool: tf.block({
              type: tf.str(nodeType),
              count: tf.num(fieldNumber(r, "nodeCount") ?? 3),
            }),
            control_plane: tf.block({
              high_availability: tf.bool(r.fields["highAvailability"] === true),
            }),
          }),
          ["Only the largest node pool is exported; add a pool block per extra pool."],
        );
      }
      case "bucket": {
        const region = fieldString(r, "region");
        const name = fieldString(r, "name");
        if (!region || !name) return null;
        const attrs: Record<string, TerraformValue> = {
          label: tf.str(name),
          region: tf.str(region),
        };
        const acl = fieldString(r, "acl");
        if (acl) attrs["acl"] = tf.str(acl);
        if (typeof r.fields["corsEnabled"] === "boolean")
          attrs["cors_enabled"] = tf.bool(r.fields["corsEnabled"] === true);
        return block("linode_object_storage_bucket", r, attrs, undefined, `${region}:${name}`);
      }
      case "firewall": {
        const inbound = fieldString(r, "inboundPolicy");
        const outbound = fieldString(r, "outboundPolicy");
        if (!inbound || !outbound) return null;
        return block(
          "linode_firewall",
          r,
          withTags(r, {
            label: tf.str(fieldString(r, "label") || r.displayName),
            inbound_policy: tf.str(inbound),
            outbound_policy: tf.str(outbound),
            ...(fieldString(r, "status") === "disabled" ? { disabled: tf.bool(true) } : {}),
          }),
          [
            "Rules are not stored in inventory: add inbound/outbound blocks before applying, or the import will plan to remove them.",
          ],
        );
      }
      case "domain": {
        const domain = fieldString(r, "domain");
        const type = fieldString(r, "type") || "master";
        if (!domain) return null;
        const attrs: Record<string, TerraformValue> = {
          domain: tf.str(domain),
          type: tf.str(type),
        };
        const soa = fieldString(r, "soaEmail");
        if (soa) attrs["soa_email"] = tf.str(soa);
        const ttl = fieldNumber(r, "ttlSec");
        if (ttl) attrs["ttl_sec"] = tf.num(ttl);
        return block("linode_domain", r, withTags(r, attrs));
      }
      case "domain-record": {
        const [domainId, recordId] = (r.externalId ?? "").split("/");
        const type = fieldString(r, "type");
        const target = fieldString(r, "target");
        if (!domainId || !recordId || !type || !target) return null;
        const name = fieldString(r, "name");
        const attrs: Record<string, TerraformValue> = {
          domain_id: tf.num(Number(domainId)),
          name: tf.str(name === "@" ? "" : name),
          record_type: tf.str(type),
          target: tf.str(target),
        };
        const ttl = fieldNumber(r, "ttlSec");
        if (ttl) attrs["ttl_sec"] = tf.num(ttl);
        if (type === "MX" || type === "SRV")
          attrs["priority"] = tf.num(fieldNumber(r, "priority") ?? 10);
        return block("linode_domain_record", r, attrs, undefined, `${domainId},${recordId}`);
      }
      case "vpc": {
        const region = fieldString(r, "region");
        if (!region) return null;
        const attrs: Record<string, TerraformValue> = {
          label: tf.str(fieldString(r, "label") || r.displayName),
          region: tf.str(region),
        };
        const description = fieldString(r, "description");
        if (description) attrs["description"] = tf.str(description);
        return block("linode_vpc", r, attrs, ["Subnets are separate linode_vpc_subnet resources."]);
      }
      case "stackscript": {
        const script = fieldString(r, "script");
        const images = fieldString(r, "images")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!script || images.length === 0) return null;
        return block("linode_stackscript", r, {
          label: tf.str(fieldString(r, "label") || r.displayName),
          description: tf.str(fieldString(r, "description")),
          script: tf.str(script),
          images: tf.list(images.map(tf.str)),
          is_public: tf.bool(r.fields["isPublic"] === true),
        });
      }
      case "database": {
        const engine = fieldString(r, "engine");
        const version = fieldString(r, "version");
        const region = fieldString(r, "region");
        const type = fieldString(r, "type");
        const id = (r.externalId ?? "").split("/")[1];
        if (!engine || !version || !region || !type) return null;
        const attrs: Record<string, TerraformValue> = {
          label: tf.str(fieldString(r, "label") || r.displayName),
          engine_id: tf.str(`${engine}/${version.split(".")[0]}`),
          region: tf.str(region),
          type: tf.str(type),
          cluster_size: tf.num(fieldNumber(r, "clusterSize") ?? 1),
        };
        const allow = fieldString(r, "allowList")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (allow.length) attrs["allow_list"] = tf.list(allow.map(tf.str));
        return block(
          engine === "postgresql" ? "linode_database_postgresql_v2" : "linode_database_mysql_v2",
          r,
          attrs,
          undefined,
          id,
        );
      }
      case "reserved-ip": {
        const region = fieldString(r, "region");
        if (!region) return null;
        return block("linode_reserved_ip", r, withTags(r, { region: tf.str(region) }));
      }
      default:
        return null;
    }
  },
};
